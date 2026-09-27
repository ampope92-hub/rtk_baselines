"""Grades the two runs test.sh made: the collected node program run once against the agent's own
session on another address and once against a held-back network's session reached by name.
Nothing here works out a baseline: every figure is compared with the true baseline the session's
generator (solution/generate_network.py) recorded, baked into this image."""
import json
import math
import os

import pytest

RUN = "/opt/run"
TRUTH = "/opt/truth"
SESSIONS = ["sample", "hidden"]
BAR_MM = 30.0
TIME_LIMIT = 120.0
KEYS = ("east", "north", "up")


def read_text(path):
    """Opens without following a symlink, so a link planted at the path is refused."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as fh:
        return fh.read().decode("utf-8")


def truth(name):
    return json.loads(read_text(os.path.join(TRUTH, "golden", name + ".json")))["baseline_mm"]


def session(name):
    return json.loads(read_text(os.path.join(TRUTH, name, "session.json")))


def report(name):
    """The run's stdout: one line holding one JSON object. A final newline is optional."""
    code, t0, t1 = read_text(os.path.join(RUN, f"status_{name}.txt")).split()
    elapsed = float(t1) - float(t0)
    assert elapsed < TIME_LIMIT, f"the {name} run was still going at the {TIME_LIMIT:.0f} s limit"
    text = read_text(os.path.join(RUN, f"report_{name}.json")).removesuffix("\n")
    assert text.strip(), f"the {name} run printed nothing (exit status {code})"
    assert "\n" not in text, f"the {name} run printed more than one line"
    obj = json.loads(text)
    assert isinstance(obj, dict), f"the {name} run did not print a JSON object"
    return obj


def component(entry, key, rov):
    assert isinstance(entry, dict), f"{rov}: the value is not an object"
    assert key in entry, f"{rov}: no {key}"
    v = entry[key]
    assert isinstance(v, (int, float)) and not isinstance(v, bool), f"{rov}: {key} is not a number"
    assert math.isfinite(v), f"{rov}: {key} is {v}"
    return float(v)


def test_program_collected():
    """A regular main.js was among the files collected from /app/rtk."""
    assert read_text(os.path.join(RUN, "source_check.txt")).strip() == "ok", "no main.js in /app/rtk"


@pytest.mark.parametrize("name", SESSIONS)
def test_report_names_every_rover(name):
    """One JSON object keyed by exactly the session's rovers, each with numeric east, north, up."""
    rep, want = report(name), set(truth(name))
    assert set(rep) == want, f"{name}: missing {sorted(want - set(rep))}, not rovers {sorted(set(rep) - want)[:5]}"
    for rov, entry in rep.items():
        for key in KEYS:
            component(entry, key, rov)


@pytest.mark.parametrize("name", SESSIONS)
def test_baselines_within_30_mm(name):
    """Every rover's east, north and up are each within 30 mm of its true baseline."""
    rep, true = report(name), truth(name)
    bad = []
    for rov, t in true.items():
        for key in KEYS:
            err = component(rep.get(rov), key, rov) - t[key]
            if abs(err) > BAR_MM:
                bad.append((rov, key, round(err, 1)))
    assert not bad, f"{name}: {len(bad)} component(s) off by more than {BAR_MM:.0f} mm: {bad[:8]}"


@pytest.mark.parametrize("name", SESSIONS)
def test_run_read_every_epoch(name):
    """The run took every epoch of every station from its caster, and the caster really did cut
    connections at its limit while it was serving the run."""
    ses = session(name)
    sent = {}
    cuts = 0
    log = os.path.join(RUN, f"caster_{name}.log")
    assert os.path.isfile(log), f"{name}: the caster never had a connection"
    for line in read_text(log).splitlines():
        f = line.split()
        if len(f) == 5 and f[2] == "SENT":
            sent.setdefault(f[3], set()).add(int(f[4]))
        elif len(f) >= 3 and f[2] == "CUT":
            cuts += 1
    missing = []
    for st, rows in ses["epochs"].items():
        want = {row[0] for row in rows}
        gone = want - sent.get(st, set())
        if gone:
            missing.append((st, len(gone)))
    assert not missing, f"{name}: epochs never taken from the caster: {missing}"
    assert cuts > 0, f"{name}: the caster never reached its connection limit"
