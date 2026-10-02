# Build tesla-fleet-telemetry from source (Debian for glibc compat with confluent-kafka-go)
#
# Pinned to an upstream release tag (Oct 2026, P1.3a) instead of `main` — an
# unpinned clone meant "today's build" and "a rebuild in 6 months" could silently
# be different Fleet Telemetry binaries for the same EVPulse commit (e.g. after a
# disaster-recovery rebuild on a new server, or `docker compose build
# fleet-telemetry` run again). teslamotors/fleet-telemetry maintains real semver
# tags (30+ releases, actively cut) — a tag is preferred here over a raw commit
# SHA per that upstream release model.
#
# FLEET_TELEMETRY_VERSION bump checklist:
#   1. Check go.mod at the new tag for its required Go version — v0.9.5 requires
#      Go 1.27.0, which is why the builder below is already bumped past the
#      golang:1.23-bookworm this image used before pinning.
#   2. Do a local `docker build` test before deploying — confirmed empirically
#      (Oct 2026) that EVPulse's apt-installed libzmq3-dev (dynamic linking) still
#      satisfies v0.9.5's libzmq/libsodium needs, even though upstream's own
#      Dockerfile now compiles both statically from source for its distroless
#      target — that's not required here, just noted in case a future version
#      changes this.
#   3. P1.3b (tracked separately, not done here): migrate to the official
#      pre-built `tesla/fleet-telemetry` image (Docker Hub, multi-arch, digest-
#      pinnable) instead of building from source at all. That image is distroless
#      and non-root (UID 65532, no shell) — it needs server.json rendered outside
#      the container (no envsubst/entrypoint.sh inside it) and cert file
#      permissions adapted, so it's a separate runtime-hardening change, not a
#      drop-in swap.
ARG FLEET_TELEMETRY_VERSION=v0.9.5
FROM golang:1.27-bookworm AS builder
ARG FLEET_TELEMETRY_VERSION
RUN apt-get update -q && apt-get install -y -q git libzmq3-dev pkg-config

RUN git clone --depth=1 --branch ${FLEET_TELEMETRY_VERSION} https://github.com/teslamotors/fleet-telemetry.git /src
WORKDIR /src
RUN go build -o /fleet-telemetry ./cmd/

# Runtime: Debian slim + shared libs
FROM debian:bookworm-slim
RUN apt-get update -q && apt-get install -y -q gettext-base ca-certificates libzmq5 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /fleet-telemetry /usr/local/bin/fleet-telemetry
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 443 9090
ENTRYPOINT ["/entrypoint.sh"]
