FROM golang:1.23-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /build
RUN git clone --depth=1 https://github.com/teslamotors/vehicle-command.git . \
    && go mod download \
    && go build -o tesla-http-proxy ./cmd/tesla-http-proxy

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /build/tesla-http-proxy /usr/local/bin/tesla-http-proxy

ENTRYPOINT ["tesla-http-proxy"]
