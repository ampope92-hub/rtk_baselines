#!/usr/bin/env python3
"""The monitoring network's observation caster: a line protocol over TCP that streams one
session's epochs per station.

  python3 caster.py --data session.json --host H --port P [--limit N] [--idle S]
                    [--ready-file F] [--log F]

Protocol (README.md in the tool's directory is the contract; this follows it):
  greeting            CASTER RTK2 <network> limit=<n>
  STATIONS            STA <id> <role> <receiver> <x> <y> <z> ... END
  SUB <station> <c>   EPOCH <k> <t> / OBS ... lines per epoch, then END when the session is done;
                      <c> is '-' for the first epoch or a cursor from CUT
  QUIT                BYE, then close
  CUT <cursor>        after the n-th epoch a connection has carried; the caster closes
  ERR <text>          unknown command, station or cursor
A connection idle for --idle seconds is closed without a word.
"""
import argparse
import json
import secrets
import socket
import threading
import time


class Caster:
    def __init__(self, a):
        with open(a.data) as fh:
            self.net = json.load(fh)
        self.limit, self.idle = a.limit, a.idle
        self.cursors = {}
        self.lock = threading.Lock()
        self.logpath = a.log
        self.conn_no = 0
        self.stations = {s["id"]: s for s in self.net["stations"]}

    def log(self, msg):
        if self.logpath:
            with self.lock, open(self.logpath, "a") as fh:
                fh.write(f"{time.monotonic():.3f} {msg}\n")

    def epoch_lines(self, st, i):
        k, t, obs = self.net["epochs"][st][i]
        out = [f"EPOCH {k} {t:.1f}"]
        for o in obs:
            out.append("OBS " + " ".join([o[0]] + [f"{v:.3f}" for v in o[1:8]] + [str(o[8])]))
        return out, k

    def serve(self, conn):
        with self.lock:
            self.conn_no += 1
            cno = self.conn_no
        conn.settimeout(self.idle)
        self.log(f"c{cno} OPEN")
        rfile = conn.makefile("rb")
        sent = 0
        try:
            conn.sendall(f"CASTER RTK2 {self.net['network']} limit={self.limit}\n".encode())
            while True:
                raw = rfile.readline(4096)
                if not raw:
                    self.log(f"c{cno} CLOSED by client")
                    return
                f = raw.decode("ascii", "replace").split()
                if f == ["STATIONS"]:
                    out = []
                    for s in self.net["stations"]:
                        out.append(f"STA {s['id']} {s['role']} {s['receiver']} "
                                   + " ".join(f"{v:.4f}" for v in s["xyz"]))
                    out.append("END")
                    conn.sendall(("\n".join(out) + "\n").encode())
                    self.log(f"c{cno} STATIONS")
                    continue
                if f == ["QUIT"]:
                    conn.sendall(b"BYE\n")
                    self.log(f"c{cno} QUIT")
                    return
                if len(f) == 3 and f[0] == "SUB":
                    st, cur = f[1], f[2]
                    if st not in self.stations:
                        conn.sendall(b"ERR unknown station\n")
                        self.log(f"c{cno} ERR station")
                        continue
                    if cur == "-":
                        i = 0
                    else:
                        with self.lock:
                            got = self.cursors.get(cur)
                        if got is None or got[0] != st:
                            conn.sendall(b"ERR bad cursor\n")
                            self.log(f"c{cno} ERR cursor")
                            continue
                        i = got[1]
                    rows = self.net["epochs"][st]
                    while i < len(rows):
                        if sent >= self.limit:
                            tok = secrets.token_hex(8)
                            with self.lock:
                                self.cursors[tok] = (st, i)
                            conn.sendall(f"CUT {tok}\n".encode())
                            self.log(f"c{cno} CUT {st} at {i}")
                            return
                        lines, k = self.epoch_lines(st, i)
                        conn.sendall(("\n".join(lines) + "\n").encode())
                        self.log(f"c{cno} SENT {st} {k}")
                        sent += 1
                        i += 1
                    conn.sendall(b"END\n")
                    self.log(f"c{cno} END {st}")
                    continue
                conn.sendall(b"ERR unknown command\n")
                self.log(f"c{cno} ERR command")
        except TimeoutError:
            self.log(f"c{cno} IDLE closed")
        except OSError:
            self.log(f"c{cno} RESET")
        finally:
            try:
                conn.close()
            except OSError:
                pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=2101)
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--idle", type=float, default=10.0)
    ap.add_argument("--ready-file")
    ap.add_argument("--log")
    a = ap.parse_args()
    caster = Caster(a)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((a.host, a.port))
    srv.listen(32)
    if a.ready_file:
        with open(a.ready_file, "w") as fh:
            fh.write("ready\n")
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=caster.serve, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
