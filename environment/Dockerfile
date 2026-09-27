# The processing box. Node from Debian's own package and nothing else: no npm, no packages. The
# network's observations are not in this image; they are only reachable through the caster
# service (Dockerfile.caster), over its socket.
FROM public.ecr.aws/docker/library/python:3.13-slim-bookworm@sha256:01f42367a0a94ad4bc17111776fd66e3500c1d87c15bbd6055b7371d39c124fb

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CASTER_HOST=127.0.0.1 \
    CASTER_PORT=2101

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        nodejs \
        tmux \
        asciinema \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/rtk
COPY app/rtk/ /app/rtk/
