#!/usr/bin/env python3
"""Builds one monitoring-network session for the caster, and the true baselines, from a physical
model written down first. Standard library only, so the same seed gives the same bytes.

  python3 generate_network.py <sample|hidden> <session.json> <truth.json> [--seed N]

The model, per station r and satellite s at epoch t (metres unless stated):
  rho      straight distance from the listed satellite position to the station's monument
  C1       rho + c (dtr - dts) + I          C2  rho + c (dtr - dts) + g I       g = (f1/f2)^2
  L1 (cy)  (rho + c (dtr - dts) - I) / w1 + N1        L2 (cy)  (rho + c (dtr - dts) - g I) / w2 + N2
with white noise on every measurement (code sigma_code, phase sigma_phase), receiver and satellite
clocks off by up to half a millisecond, N1 and N2 whole numbers of cycles fixed for as long as the
receiver keeps lock, and I the L1 ionospheric delay: a thin shell over the network at every station,
plus, at a rover, an offset per satellite that is steady over the session and grows with the
rover's distance from the reference station. Nothing is added for the neutral atmosphere: the
stations' firmware takes it out before the caster sees the data.

Receivers of the second model (TARN-2) lose lock without always raising the loss-of-lock bits;
the first model (KESTREL-5) raises both bits on every slip. Epochs the telemetry link dropped are
missing from a station's stream; the receiver kept tracking through them.
"""
import argparse
import json
import math
import random

C = 299792458.0
F1 = 1575.42e6
F2 = 1227.60e6
W1 = C / F1
W2 = C / F2
GAM = (F1 / F2) ** 2
WGS_A = 6378137.0
WGS_F = 1 / 298.257223563
WGS_E2 = WGS_F * (2 - WGS_F)
OMEGA_E = 7.2921151467e-5
ORB_A = 26559700.0
ORB_T = 43082.0
SHELL = 350e3

RECEIVERS = ("KESTREL-5", "TARN-2")

NETWORKS = {
    # the network the agent's caster serves
    "sample": {"seed": 20260935, "name": "ETNA-S", "lat": 37.7340, "lon": 15.0040, "h": 820.0,
               "planes": 6, "per": 5, "incl": 55.0, "mask": 10.0, "sats": (8, 9), "rovers": 7,
               "epochs": 90, "dt": 1.0, "sig_code": 0.35, "sig_phase": 0.0015, "ion_zenith": 4.0,
               "ion_per_km": 0.010, "km": (2.0, 11.0), "up": (150.0, 1500.0),
               "unflagged": 2, "flagged": 2, "gaps": 3, "terrain": 0.6},
    # the held-back network: another volcano, a denser sky, shorter sessions, other constants
    "hidden": {"seed": 41178, "name": "RUAP-H", "lat": -39.2810, "lon": 175.5630, "h": 1150.0,
               "planes": 8, "per": 6, "incl": 56.0, "mask": 8.0, "sats": (13, 15), "rovers": 6,
               "epochs": 60, "dt": 1.0, "sig_code": 0.30, "sig_phase": 0.0015, "ion_zenith": 5.0,
               "ion_per_km": 0.012, "km": (2.0, 12.0), "up": (100.0, 1300.0),
               "unflagged": 3, "flagged": 2, "gaps": 4, "terrain": 0.6},
}


def geod2ecef(lat, lon, h):
    la, lo = math.radians(lat), math.radians(lon)
    n = WGS_A / math.sqrt(1 - WGS_E2 * math.sin(la) ** 2)
    return [(n + h) * math.cos(la) * math.cos(lo), (n + h) * math.cos(la) * math.sin(lo),
            (n * (1 - WGS_E2) + h) * math.sin(la)]


def enu_basis(lat, lon):
    la, lo = math.radians(lat), math.radians(lon)
    return ([-math.sin(lo), math.cos(lo), 0.0],
            [-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)],
            [math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])


def sat_pos(cfg, idx, t):
    """Circular orbits in planes spread evenly in node, turned into the Earth-fixed frame."""
    p, s = divmod(idx, cfg["per"])
    raan = 2 * math.pi * p / cfg["planes"]
    u = 2 * math.pi * s / cfg["per"] + p * 1.7 * 2 * math.pi / (cfg["per"] * cfg["planes"])
    u += 2 * math.pi * t / ORB_T
    i = math.radians(cfg["incl"])
    xo, yo = ORB_A * math.cos(u), ORB_A * math.sin(u)
    x = xo * math.cos(raan) - yo * math.cos(i) * math.sin(raan)
    y = xo * math.sin(raan) + yo * math.cos(i) * math.cos(raan)
    z = yo * math.sin(i)
    th = OMEGA_E * t
    return [x * math.cos(th) + y * math.sin(th), -x * math.sin(th) + y * math.cos(th), z]


def elevation(rx, sv, basis):
    d = [sv[i] - rx[i] for i in range(3)]
    r = math.sqrt(sum(v * v for v in d))
    return math.degrees(math.asin(sum(basis[2][i] * d[i] for i in range(3)) / r))


def build(cfg, seed):
    rng = random.Random(seed)
    ref = geod2ecef(cfg["lat"], cfg["lon"], cfg["h"])
    basis = enu_basis(cfg["lat"], cfg["lon"])
    nsv = cfg["planes"] * cfg["per"]
    T, dt = cfg["epochs"], cfg["dt"]
    lo, hi = cfg["sats"]
    while True:
        t0 = float(rng.randrange(0, 604800 - 4000))
        vis = [s for s in range(nsv)
               if all(elevation(ref, sat_pos(cfg, s, t), basis) >= cfg["mask"] + 2
                      for t in (t0, t0 + (T - 1) * dt))]
        if lo <= len(vis) <= hi:
            break
    ids = {s: f"SV{s + 1:02d}" for s in vis}

    stations = [{"id": "REF", "role": "REF", "receiver": RECEIVERS[0], "xyz": ref, "enu": [0.0, 0.0, 0.0]}]
    for r in range(cfg["rovers"]):
        dist = rng.uniform(*cfg["km"]) * 1000.0
        az = rng.uniform(0.0, 2 * math.pi)
        enu = [dist * math.sin(az), dist * math.cos(az), rng.uniform(*cfg["up"])]
        xyz = [ref[i] + sum(enu[j] * basis[j][i] for j in range(3)) for i in range(3)]
        stations.append({"id": f"R{r + 1:02d}", "role": "ROVER", "receiver": RECEIVERS[r % 2], "xyz": xyz,
                         "enu": enu, "approx": [v + rng.uniform(-3.0, 3.0) for v in xyz]})
    rovers = stations[1:]
    for st in stations:
        st["masked"] = set()
        if st["role"] == "ROVER" and rng.random() < cfg["terrain"]:
            # the crater rim hides the lowest satellite from this rover
            st["masked"].add(min(vis, key=lambda s: elevation(st["xyz"], sat_pos(cfg, s, t0), basis)))

    sat_clk = {s: (rng.uniform(-3e-4, 3e-4), rng.uniform(-1e-11, 1e-11)) for s in vis}
    for st in stations:
        st["clk"] = (rng.uniform(-5e-4, 5e-4), rng.uniform(-2e-9, 2e-9))
        st["amb"] = {s: [rng.randint(-3000000, 3000000), rng.randint(-3000000, 3000000)] for s in vis}
        km = math.hypot(st["enu"][0], st["enu"][1]) / 1000.0
        st["dion"] = {s: (rng.gauss(0.0, cfg["ion_per_km"] * km) if st["role"] == "ROVER" else 0.0)
                      for s in vis}

    # cycle slips: (station, sat, epoch, d1, d2, flagged). TARN-2 rovers carry the unflagged ones.
    slips = []
    tarn = [r for r in rovers if r["receiver"] == RECEIVERS[1]]
    kest = [r for r in rovers if r["receiver"] == RECEIVERS[0]]

    def add_slip(st, flagged):
        free = [s for s in vis if s not in st["masked"]
                and sum(1 for x in slips if x[0] == st["id"] and x[1] == s) == 0]
        s = rng.choice(free)
        k = rng.randrange(int(T * 0.2), int(T * 0.8))
        while True:
            d1, d2 = rng.randint(-9, 9), rng.randint(-9, 9)
            if (d1, d2) != (0, 0) and abs(W1 * d1 - W2 * d2) > 0.10:
                break
        slips.append((st["id"], s, k, d1, d2, flagged))

    for i in range(cfg["unflagged"]):
        add_slip(tarn[i % len(tarn)], False)
    for i in range(cfg["flagged"]):
        add_slip(kest[i % len(kest)], True)
    add_slip(tarn[rng.randrange(len(tarn))], True)

    gaps = []
    for g in range(cfg["gaps"]):
        st = stations[(g * 3 + 1) % len(stations)] if g else stations[0]
        k = rng.randrange(3, T // 3) if g % 2 == 0 else rng.randrange(2 * T // 3, T - 8)
        gaps.append((st["id"], k, k + rng.randint(2, 6)))

    session = {"network": cfg["name"], "stations": [], "epochs": {}}
    for st in stations:
        pos = st["xyz"] if st["role"] == "REF" else st["approx"]
        session["stations"].append({"id": st["id"], "role": st["role"], "receiver": st["receiver"],
                                    "xyz": [round(v, 4) for v in pos]})
    for st in stations:
        rows = []
        for k in range(T):
            t = t0 + k * dt
            obs = []
            dtr = st["clk"][0] + st["clk"][1] * (t - t0)
            for s in vis:
                if s in st["masked"]:
                    continue
                sv = [round(v, 3) for v in sat_pos(cfg, s, t)]
                rho = math.sqrt(sum((sv[i] - st["xyz"][i]) ** 2 for i in range(3)))
                el = elevation(st["xyz"], sv, basis)
                zr = WGS_A / (WGS_A + SHELL) * math.cos(math.radians(el))
                ion = cfg["ion_zenith"] / math.sqrt(1.0 - zr * zr) + st["dion"][s]
                geo = rho + C * (dtr - (sat_clk[s][0] + sat_clk[s][1] * (t - t0)))
                n1, n2 = st["amb"][s]
                lli = 0
                for sid, ss, sk, d1, d2, fl in slips:
                    if sid == st["id"] and ss == s and k >= sk:
                        n1 += d1
                        n2 += d2
                        if k == sk and fl:
                            lli = 3
                c1 = geo + ion + rng.gauss(0.0, cfg["sig_code"])
                c2 = geo + GAM * ion + rng.gauss(0.0, cfg["sig_code"])
                l1 = (geo - ion + rng.gauss(0.0, cfg["sig_phase"])) / W1 + n1
                l2 = (geo - GAM * ion + rng.gauss(0.0, cfg["sig_phase"])) / W2 + n2
                obs.append([ids[s], sv[0], sv[1], sv[2], round(c1, 3), round(l1, 3),
                            round(c2, 3), round(l2, 3), lli])
            if any(g[0] == st["id"] and g[1] <= k < g[2] for g in gaps):
                continue
            rows.append([k, t, obs])
        session["epochs"][st["id"]] = rows

    truth = {"network": cfg["name"],
             "baseline_mm": {r["id"]: {"east": round(r["enu"][0] * 1000, 2),
                                       "north": round(r["enu"][1] * 1000, 2),
                                       "up": round(r["enu"][2] * 1000, 2)} for r in rovers},
             "satellites": len(vis),
             "slips": [{"station": x[0], "sat": ids[x[1]], "epoch": x[2], "d1": x[3], "d2": x[4], "flagged": x[5]}
                       for x in slips],
             "gaps": [{"station": g[0], "first": g[1], "last": g[2] - 1} for g in gaps],
             "masked": {r["id"]: [ids[s] for s in sorted(r["masked"])] for r in rovers}}
    return session, truth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("network", choices=sorted(NETWORKS))
    ap.add_argument("session")
    ap.add_argument("truth")
    ap.add_argument("--seed", type=int)
    a = ap.parse_args()
    cfg = NETWORKS[a.network]
    session, truth = build(cfg, cfg["seed"] if a.seed is None else a.seed)
    with open(a.session, "w") as fh:
        json.dump(session, fh, separators=(",", ":"))
        fh.write("\n")
    with open(a.truth, "w") as fh:
        json.dump(truth, fh, indent=1, sort_keys=True)
        fh.write("\n")


if __name__ == "__main__":
    main()
