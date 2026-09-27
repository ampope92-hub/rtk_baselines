# Verifier image. Runs in its own container, sees only the paths declared in `artifacts`, and
# holds what the agent never sees: the held-back network's session, the true baselines of both
# networks and the caster that serves them. It runs the collected node program against casters
# it starts itself.

# The program is started through tests/launch.c, which lets it start no other program. Built
# statically in a throwaway stage, so no C compiler reaches the final image.
FROM public.ecr.aws/docker/library/python:3.13-slim-bookworm@sha256:01f42367a0a94ad4bc17111776fd66e3500c1d87c15bbd6055b7371d39c124fb AS launcher
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY launch.c /tmp/launch.c
RUN gcc -O2 -static -Wall -o /tool_launch /tmp/launch.c

FROM public.ecr.aws/docker/library/python:3.13-slim-bookworm@sha256:01f42367a0a94ad4bc17111776fd66e3500c1d87c15bbd6055b7371d39c124fb

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The same Debian node the agent's box carries, and the verifier tooling from a hash-pinned
# lockfile. Nothing is installed at trial time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes --no-deps -r /tmp/requirements.txt && rm -f /tmp/requirements.txt

COPY --from=launcher /tool_launch /usr/local/bin/tool_launch
RUN useradd --create-home --uid 10001 --shell /bin/bash runner

# Landing directory for the declared artifact.
RUN mkdir -p /app/rtk

# The sessions, the true baselines and the caster. Root only, and never in any container the
# agent reaches.
COPY data /opt/truth
COPY golden /opt/truth/golden
COPY caster /opt/caster
RUN chmod 700 /opt/truth /opt/caster

# Separate mode does not upload tests/ into the image, so the image owns /tests itself.
COPY . /tests/

WORKDIR /app/rtk
