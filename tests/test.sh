#!/bin/bash

# Verifier entrypoint. Runs in the verifier container, not the agent's, and sees only the paths
# declared in `artifacts`. Everything it needs is baked into tests/Dockerfile; nothing is fetched
# here. It runs the collected node program twice, each time against a caster it starts from the
# copy in this image: the agent's own session on another address, port and connection limit, then
# a held-back network's session reached by host name.

set -uo pipefail
cd /
mkdir -p /logs/verifier
echo 0 > /logs/verifier/reward.txt
exec 2>&1

# Root runs this script and later pytest, after agent-authored code has run as the unprivileged
# user. Every directory on PATH must be root-owned and closed to writing by others.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
hash -r
for d in ${PATH//:/ }; do
  real="$(/usr/bin/readlink -f "$d" 2>/dev/null)" || continue
  [ -d "$real" ] || continue
  owner="$(/usr/bin/stat -c %u "$real")"
  mode="$(/usr/bin/stat -c %a "$real")"
  if [ "$owner" != "0" ] || [ $(( 8#$mode & 8#022 )) -ne 0 ]; then
    echo "FATAL: $d (-> $real) is on root's PATH but is owner $owner mode $mode."
    echo 0 > /logs/verifier/reward.txt
    exit 0
  fi
done
echo "every directory on root's PATH is root-owned and closed to writing by anyone else"

NODE=/usr/bin/node
PY=/usr/local/bin/python3
if [ ! -x "$NODE" ] || [ ! -x "$PY" ]; then
  echo "FATAL: node or the caster's interpreter is missing"
  echo 0 > /logs/verifier/reward.txt
  exit 0
fi

/usr/bin/install -d -m 700 -o root -g root /opt/run

as_runner() {
  setpriv --clear-groups --no-new-privs --reuid runner --regid runner "$@"
}

# The held-back run reaches its caster by name. README.md says CASTER_HOST can be a host name or
# an address.
CASTER_BY_NAME=caster.summit.internal
printf '%s\t%s\n' 127.0.0.4 "$CASTER_BY_NAME" >> /etc/hosts
if ! /usr/bin/getent hosts "$CASTER_BY_NAME" >/dev/null 2>&1; then
  echo "FATAL: $CASTER_BY_NAME does not resolve in this container"
  echo 0 > /logs/verifier/reward.txt
  exit 0
fi

# Close the verifier's code, the sessions, the true baselines, the caster, the run directory and
# the reward directory to the unprivileged user before anything untrusted runs, and prove it.
chmod 700 /tests /logs/verifier /opt/truth /opt/caster /opt/run 2>/dev/null || true
if as_runner bash -c 'test -r /tests/test_outputs.py || ls /opt/truth || ls /opt/caster || ls /opt/run || ls /logs/verifier' >/dev/null 2>&1; then
  echo "FATAL: /tests, the sessions, the caster, the run directory or the reward directory is reachable by the build user."
  echo 0 > /logs/verifier/reward.txt
  exit 0
fi
echo "verifier files closed to the unprivileged build user"

# What runs is the program's own source and nothing else, by construction: the regular .js, .mjs
# and .cjs files and a package.json directly under /app/rtk are copied into a root-owned
# directory, and /app/rtk is rebuilt from that copy, root-owned and read-only to the user who runs
# it. A link, a subdirectory or a node_modules tree never reaches the run.
rm -rf /opt/src_pristine
/usr/bin/install -d -m 700 -o root -g root /opt/src_pristine
for f in /app/rtk/*.js /app/rtk/*.mjs /app/rtk/*.cjs /app/rtk/package.json; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then /usr/bin/cp --no-dereference "$f" /opt/src_pristine/; fi
done
echo "collected source files: $(ls /opt/src_pristine | tr '\n' ' ')"
rm -rf /app/rtk
/usr/bin/install -d -o root -g root -m 755 /app/rtk
cp /opt/src_pristine/* /app/rtk/ 2>/dev/null || true
chown -R root:root /app/rtk
chmod 644 /app/rtk/* 2>/dev/null || true
if [ -f /app/rtk/main.js ]; then echo ok > /opt/run/source_check.txt; else echo missing > /opt/run/source_check.txt; fi

# Interpreters other than node closed to the user who runs the program. Root is unaffected.
INTERP="$(for t in python3 python3.13 pip perl awk mawk; do
            p="$(command -v "$t" 2>/dev/null)" && readlink -f "$p"; done | sort -u)"
close_interp() { for f in $INTERP; do /usr/bin/chmod 750 "$f" 2>/dev/null || true; done; }
open_interp()  { for f in $INTERP; do /usr/bin/chmod 755 "$f" 2>/dev/null || true; done; }
trap 'open_interp' EXIT

CASTER_PID=""
start_caster() {   # $1 session, $2 address, $3 port, $4 limit
  /usr/bin/rm -f /opt/run/ready
  "$PY" /opt/caster/caster.py --data "/opt/truth/$1/session.json" --host "$2" --port "$3" \
      --limit "$4" --ready-file /opt/run/ready --log "/opt/run/caster_$1.log" \
      >> "/opt/run/caster_$1.err" 2>&1 &
  CASTER_PID=$!
  local i
  for i in $(/usr/bin/seq 1 300); do
    [ -f /opt/run/ready ] && return 0
    /usr/bin/sleep 0.1
  done
  echo "FATAL: the caster never came up on $2:$3"
  return 1
}

# `kill` is the shell builtin on purpose: a builtin cannot be shadowed by anything on PATH.
stop_caster() {
  [ -n "$CASTER_PID" ] || return 0
  kill -TERM "$CASTER_PID" 2>/dev/null || true
  wait "$CASTER_PID" 2>/dev/null
  CASTER_PID=""
}

# $1 session, $2 CASTER_HOST, $3 CASTER_PORT. Runs `node main.js` from /app/rtk as the
# unprivileged user with a clean environment, through tool_launch (tests/launch.c) so neither node
# nor any child can start another program. Stdout is kept for grading; stderr goes to this log.
# The run is killed at the 120 seconds the instruction states, and the wall time is recorded so a
# run is only called a timeout when it actually reached the limit.
run_tool() {
  local out="/opt/run/report_$1.json" pid status t0 t1
  /usr/bin/find /tmp /var/tmp /dev/shm -mindepth 1 -user runner -delete 2>/dev/null || true
  t0="$(/usr/bin/date +%s.%N)"
  setsid /usr/bin/timeout --signal=KILL 120 \
    env -i -C /app/rtk HOME=/home/runner PATH=/usr/bin:/bin CASTER_HOST="$2" CASTER_PORT="$3" \
      setpriv --clear-groups --no-new-privs --reuid runner --regid runner \
      /usr/local/bin/tool_launch "$NODE" main.js > "$out" &
  pid=$!
  wait "$pid"
  status=$?
  t1="$(/usr/bin/date +%s.%N)"
  kill -KILL -- -"$pid" 2>/dev/null || true
  as_runner bash -c 'kill -9 -1' 2>/dev/null || true
  /usr/bin/chown root:root "$out" 2>/dev/null || true
  /usr/bin/chmod 600 "$out" 2>/dev/null || true
  echo "$status $t0 $t1" > "/opt/run/status_$1.txt"
  echo "run $1: exit status $status, caster $2:$3, $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}') s"
}

close_interp
echo "=== the agent's own session, on another address and port, with a smaller connection limit ==="
if start_caster sample 127.0.0.3 7311 23; then
  run_tool sample 127.0.0.3 7311
fi
stop_caster

echo "=== a held-back network's session, reached by name ==="
if start_caster hidden 127.0.0.4 7412 17; then
  run_tool hidden "$CASTER_BY_NAME" 7412
fi
stop_caster
as_runner bash -c 'kill -9 -1' 2>/dev/null || true
open_interp

for s in sample hidden; do
  if [ -f "/opt/run/caster_$s.log" ]; then
    echo "$s: $(/usr/bin/grep -c ' OPEN' /opt/run/caster_$s.log) connections, $(/usr/bin/grep -c ' SENT ' /opt/run/caster_$s.log) epochs sent, $(/usr/bin/grep -c ' CUT ' /opt/run/caster_$s.log) cuts"
  fi
  [ -f "/opt/run/caster_$s.err" ] && /usr/bin/tail -n 5 "/opt/run/caster_$s.err"
done

# By absolute path, and -P keeps the working directory off the module path.
"$PY" -P -m pytest -o cache_dir=/tmp/pytest_cache -p no:cacheprovider \
  --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA
if [ "$?" -eq 0 ]; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi
