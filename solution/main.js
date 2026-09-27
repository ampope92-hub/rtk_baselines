'use strict';
// Reference tool: every rover's baseline to the reference station, east / north / up in mm, from
// one session of dual-frequency code and carrier phase read off the network's caster.
//
//   node main.js        (CASTER_HOST and CASTER_PORT from the environment)
//
// Per rover: double differences against the reference station and one pivot satellite, a float
// least-squares solution for the baseline, one ionospheric offset per satellite pair (steady
// over the session) and the L1 and L2 ambiguities of every unbroken arc; then the integer
// ambiguities by integer least squares (LAMBDA: decorrelate with integer Gauss transforms and
// swaps, then a shrinking-ellipsoid search), and the baseline again with the integers held.
// Arcs are cut wherever the receiver raised a loss-of-lock bit or the phase itself shows a jump
// (geometry-free phase stepping between epochs, or the Melbourne-Wubbena wide lane leaving its
// running mean), because not every receiver raises the bit.

const net = require('net');

const C = 299792458.0;
const F1 = 1575.42e6;
const F2 = 1227.60e6;
const W1 = C / F1;
const W2 = C / F2;
const GAM = (F1 / F2) ** 2;
const WWL = C / (F1 - F2);
const WGS_A = 6378137.0;
const WGS_F = 1 / 298.257223563;
const WGS_E2 = WGS_F * (2 - WGS_F);
const SIG_CODE = 0.3;     // m, one measurement
const SIG_PHASE = 0.0015; // m, one measurement

// ---------------------------------------------------------------- caster client

function openLink(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const lines = [];
    const waiting = [];
    let buf = '';
    let closed = false;
    let up = false;
    const flush = () => {
      while (waiting.length && (lines.length || closed)) waiting.shift()(lines.length ? lines.shift() : null);
    };
    sock.setEncoding('latin1');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
      flush();
    });
    sock.on('close', () => { closed = true; flush(); });
    sock.on('error', (e) => { closed = true; if (!up) reject(e); flush(); });
    sock.on('connect', () => {
      up = true;
      resolve({
        next: () => new Promise((r) => { waiting.push(r); flush(); }),
        send: (s) => { if (!closed) sock.write(s + '\n'); },
        close: () => sock.destroy(),
      });
    });
  });
}

async function greet(host, port) {
  const link = await openLink(host, port);
  const hello = await link.next();
  if (!hello || !hello.startsWith('CASTER ')) throw new Error('no greeting from the caster: ' + hello);
  return link;
}

async function readNetwork(host, port) {
  let link = await greet(host, port);
  link.send('STATIONS');
  const stations = [];
  for (;;) {
    const line = await link.next();
    if (line === null) throw new Error('caster closed during STATIONS');
    const f = line.split(/\s+/);
    if (f[0] === 'END') break;
    if (f[0] === 'CUT') { link.close(); link = await greet(host, port); link.send('STATIONS'); stations.length = 0; continue; }
    if (f[0] !== 'STA') throw new Error('unexpected: ' + line);
    stations.push({ id: f[1], role: f[2], receiver: f[3], xyz: [Number(f[4]), Number(f[5]), Number(f[6])] });
  }
  const epochs = {};
  for (const st of stations) {
    const got = new Map();
    let cursor = '-';
    let done = false;
    while (!done) {
      link.send(`SUB ${st.id} ${cursor}`);
      let cur = null;
      for (;;) {
        const line = await link.next();
        if (line === null) { // dropped without a cursor: start over from the last one, skip repeats
          link.close();
          link = await greet(host, port);
          break;
        }
        const f = line.split(/\s+/);
        if (f[0] === 'EPOCH') {
          const k = Number(f[1]);
          cur = got.has(k) ? null : { k, t: Number(f[2]), obs: new Map() };
          if (cur) got.set(k, cur);
        } else if (f[0] === 'OBS') {
          if (cur) {
            cur.obs.set(f[1], {
              x: Number(f[2]), y: Number(f[3]), z: Number(f[4]),
              C1: Number(f[5]), L1: Number(f[6]), C2: Number(f[7]), L2: Number(f[8]), lli: Number(f[9]),
            });
          }
        } else if (f[0] === 'END') {
          done = true;
          break;
        } else if (f[0] === 'CUT') {
          cursor = f[1];
          link.close();
          link = await greet(host, port);
          break;
        } else {
          throw new Error(`caster said "${line}" to SUB ${st.id}`);
        }
      }
    }
    epochs[st.id] = [...got.values()].sort((a, b) => a.k - b.k);
  }
  link.send('QUIT');
  link.close();
  return { stations, epochs };
}

// ---------------------------------------------------------------- geometry

function ecef2geod(x) {
  const p = Math.hypot(x[0], x[1]);
  let lat = Math.atan2(x[2], p * (1 - WGS_E2));
  for (let i = 0; i < 10; i++) {
    const n = WGS_A / Math.sqrt(1 - WGS_E2 * Math.sin(lat) ** 2);
    const h = p / Math.cos(lat) - n;
    lat = Math.atan2(x[2], p * (1 - WGS_E2 * n / (n + h)));
  }
  return [lat, Math.atan2(x[1], x[0])];
}

function toEnu(ref, d) {
  const [la, lo] = ecef2geod(ref);
  const e = [-Math.sin(lo), Math.cos(lo), 0];
  const n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const dot = (a) => a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
  return [dot(e), dot(n), dot(u)];
}

// ---------------------------------------------------------------- dense linear algebra

function zeros(n, m) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(new Float64Array(m));
  return a;
}

function spdInverse(A) {
  const n = A.length;
  const L = zeros(n, n);
  for (let j = 0; j < n; j++) {
    let s = A[j][j];
    for (let k = 0; k < j; k++) s -= L[j][k] * L[j][k];
    if (!(s > 0)) throw new Error('normal matrix is singular');
    L[j][j] = Math.sqrt(s);
    for (let i = j + 1; i < n; i++) {
      let t = A[i][j];
      for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / L[j][j];
    }
  }
  const Li = zeros(n, n);
  for (let i = 0; i < n; i++) {
    Li[i][i] = 1 / L[i][i];
    for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= L[i][k] * Li[k][j];
      Li[i][j] = s / L[i][i];
    }
  }
  const Q = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = i; k < n; k++) s += Li[k][i] * Li[k][j];
      Q[i][j] = s;
      Q[j][i] = s;
    }
  }
  return Q;
}

// ---------------------------------------------------------------- cycle slips

// Arc number for every epoch of one station's satellite, cut on the bits or on a jump in the data.
function arcsOf(series) {
  const arcs = new Array(series.length).fill(0);
  let arc = 0;
  let mwSum = 0;
  let mwN = 0;
  const gf = (o) => W1 * o.L1 - W2 * o.L2;
  const mw = (o) => ((F1 * W1 * o.L1 - F2 * W2 * o.L2) / (F1 - F2) - (F1 * o.C1 + F2 * o.C2) / (F1 + F2)) / WWL;
  for (let i = 0; i < series.length; i++) {
    const o = series[i];
    if (i > 0) {
      let jump = o.lli !== 0;
      if (Math.abs(gf(o) - gf(series[i - 1])) > 0.05) jump = true;
      if (mwN >= 5 && Math.abs(mw(o) - mwSum / mwN) > 4.0) jump = true;
      if (jump) { arc++; mwSum = 0; mwN = 0; }
    }
    arcs[i] = arc;
    mwSum += mw(o);
    mwN++;
  }
  return arcs;
}

// ---------------------------------------------------------------- one rover

function setUp(ses, rov) {
  const ref = ses.ref;
  const arcs = {};
  for (const st of [ref, rov]) {
    arcs[st] = {};
    const bySat = {};
    for (const ep of ses.epochs[st]) for (const [s, o] of ep.obs) (bySat[s] = bySat[s] || []).push({ k: ep.k, ...o });
    for (const [s, ser] of Object.entries(bySat)) {
      const a = arcsOf(ser);
      arcs[st][s] = new Map(ser.map((o, i) => [o.k, a[i]]));
    }
  }
  const R = new Map(ses.epochs[ref].map((e) => [e.k, e]));
  const V = new Map(ses.epochs[rov].map((e) => [e.k, e]));
  const ks = [...V.keys()].filter((k) => R.has(k)).sort((a, b) => a - b);
  const sats = new Set();
  for (const k of ks) for (const s of V.get(k).obs.keys()) if (R.get(k).obs.has(s)) sats.add(s);
  // pivot: seen at both ends in every common epoch, fewest arc breaks, then highest in the sky
  let pivot = null;
  let best = [Infinity, -Infinity];
  const last = ks[ks.length - 1];
  for (const s of [...sats].sort()) {
    if (!ks.every((k) => V.get(k).obs.has(s) && R.get(k).obs.has(s))) continue;
    const breaks = arcs[rov][s].get(last) - arcs[rov][s].get(ks[0]) + arcs[ref][s].get(last) - arcs[ref][s].get(ks[0]);
    const o = R.get(ks[0]).obs.get(s);
    const d = [o.x - ses.refXyz[0], o.y - ses.refXyz[1], o.z - ses.refXyz[2]];
    const up = toEnu(ses.refXyz, d)[2] / Math.hypot(d[0], d[1], d[2]);
    if (breaks < best[0] || (breaks === best[0] && up > best[1])) { best = [breaks, up]; pivot = s; }
  }
  if (pivot === null) throw new Error(`${rov}: no satellite tracked at both ends through the session`);
  const others = [...sats].filter((s) => s !== pivot).sort();
  const arcIndex = new Map();
  const epochs = [];
  for (const k of ks) {
    const r = R.get(k).obs;
    const v = V.get(k).obs;
    const list = [];
    for (const s of others) {
      if (!r.has(s) || !v.has(s)) continue;
      // a new arc of the pivot starts new double-difference ambiguities for every satellite
      const key = `${s}/${arcs[rov][s].get(k)}/${arcs[ref][s].get(k)}/${arcs[rov][pivot].get(k)}/${arcs[ref][pivot].get(k)}`;
      if (!arcIndex.has(key)) arcIndex.set(key, arcIndex.size);
      list.push({ s, ion: others.indexOf(s), arc: arcIndex.get(key), r: r.get(s), v: v.get(s) });
    }
    epochs.push({ pr: r.get(pivot), pv: v.get(pivot), list });
  }
  return { rov, m: others.length, na: arcIndex.size, epochs };
}

// Least squares on the double differences. Unknowns: baseline correction (3), one ionospheric
// offset per non-pivot satellite, and, unless `fixed` holds them, L1 then L2 ambiguities per arc.
// Each epoch's double differences share the pivot, so they are weighted with the inverse of
// their covariance, 1/(2 sigma^2) (I - J/n) for n satellites in the epoch.
function adjust(ses, P, b, fixed) {
  const nI = P.m;
  const nA = fixed ? 0 : 2 * P.na;
  const np = 3 + nI + nA;
  const N = zeros(np, np);
  const u = new Float64Array(np);
  const xr = ses.refXyz;
  const xv = [xr[0] + b[0], xr[1] + b[1], xr[2] + b[2]];
  const single = (r, v) => {
    const dv = Math.hypot(v.x - xv[0], v.y - xv[1], v.z - xv[2]);
    const dr = Math.hypot(v.x - xr[0], v.y - xr[1], v.z - xr[2]);
    return {
      e: [(xv[0] - v.x) / dv, (xv[1] - v.y) / dv, (xv[2] - v.z) / dv],
      rho: dv - dr,
      L1: W1 * (v.L1 - r.L1), L2: W2 * (v.L2 - r.L2), C1: v.C1 - r.C1, C2: v.C2 - r.C2,
    };
  };
  for (const ep of P.epochs) {
    const p = single(ep.pr, ep.pv);
    const sd = ep.list.map((q) => ({ q, d: single(q.r, q.v) }));
    const n = sd.length + 1;
    for (const type of ['L1', 'L2', 'C1', 'C2']) {
      const ionCoef = { L1: -1, L2: -GAM, C1: 1, C2: GAM }[type];
      const phase = type[0] === 'L';
      const f = 1 / (2 * (phase ? SIG_PHASE : SIG_CODE) ** 2);
      const rows = [];
      const colSum = new Float64Array(np);
      let ySum = 0;
      for (const { q, d } of sd) {
        const idx = [0, 1, 2];
        const val = [d.e[0] - p.e[0], d.e[1] - p.e[1], d.e[2] - p.e[2]];
        if (nI) { idx.push(3 + q.ion); val.push(ionCoef); }
        let y = (d[type] - p[type]) - (d.rho - p.rho);
        if (phase) {
          const wl = type === 'L1' ? W1 : W2;
          const a = (type === 'L1' ? 0 : P.na) + q.arc;
          if (fixed) y -= wl * fixed[a];
          else { idx.push(3 + nI + a); val.push(wl); }
        }
        rows.push({ idx, val, y });
        for (let j = 0; j < idx.length; j++) colSum[idx[j]] += val[j];
        ySum += y;
      }
      for (const r of rows) {
        for (let a = 0; a < r.idx.length; a++) {
          const ia = r.idx[a];
          const fa = f * r.val[a];
          for (let c = 0; c < r.idx.length; c++) N[ia][r.idx[c]] += fa * r.val[c];
          u[ia] += fa * r.y;
        }
      }
      const g = f / n;
      const nz = [];
      for (let a = 0; a < np; a++) if (colSum[a] !== 0) nz.push(a);
      for (const a of nz) {
        for (const c of nz) N[a][c] -= g * colSum[a] * colSum[c];
        u[a] -= g * colSum[a] * ySum;
      }
    }
  }
  const Q = spdInverse(N);
  const x = Q.map((row) => row.reduce((s, v, j) => s + v * u[j], 0));
  return { x, Q, nI };
}

// ---------------------------------------------------------------- integer least squares (LAMBDA)

const ROUND = (x) => Math.floor(x + 0.5);
const SGN = (x) => (x <= 0 ? -1 : 1);

// Q = L' diag(D) L with L unit lower triangular
function factor(Q) {
  const n = Q.length;
  const A = Q.map((r) => Float64Array.from(r));
  const L = zeros(n, n);
  const D = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    D[i] = A[i][i];
    if (!(D[i] > 0)) throw new Error('ambiguity covariance is not positive definite');
    const a = Math.sqrt(D[i]);
    for (let j = 0; j <= i; j++) L[i][j] = A[i][j] / a;
    for (let j = 0; j <= i - 1; j++) for (let k = 0; k <= j; k++) A[j][k] -= L[i][k] * L[i][j];
    for (let j = 0; j <= i; j++) L[i][j] /= L[i][i];
  }
  return { L, D };
}

// decorrelation: integer Gauss transforms and swaps until the conditional variances are ordered
function decorrelate(L, D) {
  const n = D.length;
  const Z = zeros(n, n);
  for (let i = 0; i < n; i++) Z[i][i] = 1;
  const gauss = (i, j) => {
    const mu = ROUND(L[i][j]);
    if (mu === 0) return;
    for (let k = i; k < n; k++) L[k][j] -= mu * L[k][i];
    for (let k = 0; k < n; k++) Z[k][j] -= mu * Z[k][i];
  };
  const swap = (j, del) => {
    const eta = D[j] / del;
    const lam = D[j + 1] * L[j + 1][j] / del;
    D[j] = eta * D[j + 1];
    D[j + 1] = del;
    for (let k = 0; k <= j - 1; k++) {
      const a0 = L[j][k];
      const a1 = L[j + 1][k];
      L[j][k] = -L[j + 1][j] * a0 + a1;
      L[j + 1][k] = eta * a0 + lam * a1;
    }
    L[j + 1][j] = lam;
    for (let k = j + 2; k < n; k++) [L[k][j], L[k][j + 1]] = [L[k][j + 1], L[k][j]];
    for (let k = 0; k < n; k++) [Z[k][j], Z[k][j + 1]] = [Z[k][j + 1], Z[k][j]];
  };
  let j = n - 2;
  let k = n - 2;
  while (j >= 0) {
    if (j <= k) for (let i = j + 1; i < n; i++) gauss(i, j);
    const del = D[j] + L[j + 1][j] * L[j + 1][j] * D[j + 1];
    if (del + 1e-6 < D[j + 1]) { swap(j, del); k = j; j = n - 2; } else j--;
  }
  return Z;
}

// depth-first search of the ellipsoid, nearest integers first, radius shrinking to the best two
function searchBest(L, D, zs) {
  const n = D.length;
  const S = zeros(n, n);
  const dist = new Float64Array(n);
  const zb = new Float64Array(n);
  const z = new Float64Array(n);
  const step = new Float64Array(n);
  const found = [];
  let maxdist = Infinity;
  let k = n - 1;
  zb[k] = zs[k];
  z[k] = ROUND(zb[k]);
  let y = zb[k] - z[k];
  step[k] = SGN(y);
  for (;;) {
    const nd = dist[k] + y * y / D[k];
    if (nd < maxdist) {
      if (k !== 0) {
        dist[--k] = nd;
        for (let i = 0; i <= k; i++) S[k][i] = S[k + 1][i] + (z[k + 1] - zb[k + 1]) * L[k + 1][i];
        zb[k] = zs[k] + S[k][k];
        z[k] = ROUND(zb[k]);
        y = zb[k] - z[k];
        step[k] = SGN(y);
      } else {
        found.push({ d: nd, z: Float64Array.from(z) });
        found.sort((a, b) => a.d - b.d);
        if (found.length > 2) found.pop();
        if (found.length === 2) maxdist = found[1].d;
        z[0] += step[0];
        y = zb[0] - z[0];
        step[0] = -step[0] - SGN(step[0]);
      }
    } else {
      if (k === n - 1) break;
      k++;
      z[k] += step[k];
      y = zb[k] - z[k];
      step[k] = -step[k] - SGN(step[k]);
    }
  }
  return found;
}

// a = Z^-T z, by elimination on Z^T (Z is unimodular, so the answer is integer)
function undo(Z, z) {
  const n = Z.length;
  const A = zeros(n, n + 1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = Z[j][i];
    A[i][n] = z[i];
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f !== 0) for (let j = c; j <= n; j++) A[r][j] -= f * A[c][j];
    }
  }
  return Array.from({ length: n }, (_, i) => Math.round(A[i][n] / A[i][i]));
}

function integerFix(ahat, Qa) {
  const n = ahat.length;
  const { L, D } = factor(Qa);
  const Z = decorrelate(L, D);
  const zs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += Z[j][i] * ahat[j];
    zs[i] = s;
  }
  const best = searchBest(L, D, zs);
  return undo(Z, best[0].z);
}

function baseline(ses, rov) {
  const P = setUp(ses, rov);
  const approx = ses.stations.find((s) => s.id === rov).xyz;
  let b = [0, 1, 2].map((i) => approx[i] - ses.refXyz[i]);
  let fl = null;
  for (let it = 0; it < 4; it++) {
    fl = adjust(ses, P, b, null);
    b = [b[0] + fl.x[0], b[1] + fl.x[1], b[2] + fl.x[2]];
  }
  const off = 3 + fl.nI;
  const n = 2 * P.na;
  const ahat = new Float64Array(n);
  const Qa = zeros(n, n);
  for (let i = 0; i < n; i++) {
    ahat[i] = fl.x[off + i];
    for (let j = 0; j < n; j++) Qa[i][j] = fl.Q[off + i][off + j];
  }
  // fl.x holds the last correction to b, which is already applied: the ambiguities are at b
  const fixed = integerFix(ahat, Qa);
  for (let it = 0; it < 2; it++) {
    const fx = adjust(ses, P, b, fixed);
    b = [b[0] + fx.x[0], b[1] + fx.x[1], b[2] + fx.x[2]];
  }
  return toEnu(ses.refXyz, b);
}

async function main() {
  const host = process.env.CASTER_HOST || '127.0.0.1';
  const port = Number(process.env.CASTER_PORT || 2101);
  const { stations, epochs } = await readNetwork(host, port);
  const ref = stations.find((s) => s.role === 'REF');
  const ses = { ref: ref.id, refXyz: ref.xyz, stations, epochs };
  const out = {};
  for (const st of stations) {
    if (st.role !== 'ROVER') continue;
    const [e, n, u] = baseline(ses, st.id);
    out[st.id] = { east: +(e * 1000).toFixed(1), north: +(n * 1000).toFixed(1), up: +(u * 1000).toFixed(1) };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
