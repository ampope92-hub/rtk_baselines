# Volcano GNSS Baselines (Carrier-Phase Ambiguity Resolution in Node.js)

A volcano observatory runs a network of dual-frequency satellite receivers: one reference station on the lava plain and rovers on the edifice. The agent must write a single Node.js program, `/app/rtk/main.js`, that connects over TCP to the network's caster (found via `CASTER_HOST`/`CASTER_PORT`), pulls a full session of code and carrier-phase observations for every station - reconnecting with a cursor whenever the caster cuts the connection - and prints one line of JSON giving each rover's east/north/up baseline from the reference station in millimetres. A README describes the caster protocol, record layouts and what the group knows about its receivers, clocks, ionosphere and frame; the geodetic model is left to the agent. This is a multi-container task: the caster runs as its own service.

## What makes it hard

The 30 mm bar is only reachable once the double-difference carrier-phase ambiguities are fixed to integers, and nothing in the task says so. Every wrong route still prints plausible baselines.

- **Ionosphere.** The delay differs between the ends of each baseline by up to about 0.4 m, steady over the session, so it must be carried as one parameter per satellite pair. Set to zero, the fixed baselines miss by 3.9 m on the shipped session.
- **Unflagged cycle slips.** One receiver model loses lock without always raising the loss-of-lock bits. Cutting arcs on the bits alone leaves two slipped satellites and puts two rovers metres out (worst 82 m); slips must be detected from the geometry-free phase and the wide-lane combination.
- **Correlated float ambiguities.** Rounding them gives a worst rover error of 195 mm; sequential rounding without decorrelation, 379 mm; the float baseline itself is 85 mm out.
- **A larger held-back network.** The hidden session has 15 satellites and 26-30 ambiguities per rover over 60 epochs, against 8 satellites, 14-18 ambiguities and 90 epochs shipped. Integer least squares without LAMBDA reduction solves the shipped session in 1.8 s but is still searching when the 120 s limit kills it on every held-back session tried. With the reduction, the whole run takes about a second.

Over eight fresh seeds of each network, the reference's worst component error is 9.0 mm and 2.3 mm, against best wrong routes of 50 mm and 86 mm; the 30 mm bar sits at the midpoint.

## How it's graded

The verifier runs in a separate container and collects only `/app/rtk`, keeping just the regular `.js`, `.mjs`, `.cjs` and `package.json` files at its top level (no symlinks, subdirectories or `node_modules`). It starts its own caster twice and runs `node main.js` against each:

1. The shipped session on a different address and port (127.0.0.3) with a smaller per-connection limit (23 epochs).
2. A held-back session from another network, reached by host name, with a 17-epoch limit.

`tests/test_outputs.py` checks that `main.js` was collected; that each run printed one JSON object keyed by exactly that session's rovers with numeric `east`/`north`/`up`; that every component is within 30 mm of the true baseline; that the run finished within 120 s; and, from the caster's own log, that every epoch of every station was actually sent, with connection cuts in play.

Anti-cheat: the program runs as an unprivileged user under a seccomp launcher (`tests/launch.c`) that blocks any further `exec`, so it cannot hand off to another process. True baselines are baked into the verifier image root-only; tests, sessions, caster and logs are closed to that user and probed before the run; pytest runs by absolute path with `-P` and opens files with `O_NOFOLLOW`. The task.toml verification write-up lists the one-change variants of the reference (float-only, rounding, no reduction, bit-only slip detection, no ionosphere, hard-coded host, frozen answers, forking a second node) used to confirm each scores 0.

## Repository layout

- `instruction.md` - the task prompt given to the agent.
- `task.toml` - metadata, difficulty/solution/verification write-ups, timeouts and network policy.
- `environment/` - agent image (`Dockerfile`), caster image (`Dockerfile.caster`, `caster/`), `docker-compose.yaml` wiring the two, and the protocol README in `app/rtk/`.
- `solution/` - reference `main.js` (arc cutting, ionosphere-float double-difference model, LAMBDA reduction and integer search), `solve.sh`, and `generate_network.py`, which rebuilds both sessions and true baselines byte for byte.
- `tests/` - verifier image, `test.sh`, `test_outputs.py`, the seccomp launcher `launch.c`, the caster, both sessions and their true baselines (`golden/`).

## Running it

Requires Docker and Harbor (`uv tool install harbor` or `pip install harbor`). From the repo root:

```
harbor run -p . -a oracle
```

runs the reference solution through the verifier (should score reward 1). To try an agent instead:

```
harbor run -p . -a <agent> -m <model>
```

for example `-a claude-code`.

---

Task design, data generators, reference solution and verifier by Audrey Pope.
