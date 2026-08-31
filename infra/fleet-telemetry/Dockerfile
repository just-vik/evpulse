# Build tesla-fleet-telemetry from source (Debian for glibc compat with confluent-kafka-go)
FROM golang:1.23-bookworm AS builder
RUN apt-get update -q && apt-get install -y -q git libzmq3-dev pkg-config

RUN git clone --depth=1 https://github.com/teslamotors/fleet-telemetry.git /src
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
