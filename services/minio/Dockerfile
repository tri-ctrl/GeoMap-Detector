FROM golang:1.24.9-bookworm AS build
ARG MINIO_REF=RELEASE.2025-10-15T17-29-55Z
ARG GOPROXY=https://proxy.golang.org,direct
ENV CGO_ENABLED=0 GOMAXPROCS=2 GODEBUG=http2client=0
RUN --mount=type=secret,id=custom_ca \
    --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    if [ -s /run/secrets/custom_ca ]; then export SSL_CERT_FILE=/run/secrets/custom_ca GIT_SSL_CAINFO=/run/secrets/custom_ca; fi; \
    git clone --depth 1 --branch "$MINIO_REF" https://github.com/minio/minio.git /src \
    && cd /src && (go mod download || GOPROXY=direct go mod download) \
    && go build -trimpath -ldflags='-s -w' -o /minio .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home minio && mkdir /data && chown minio /data
COPY --from=build /minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /licenses/minio-LICENSE
USER minio
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
