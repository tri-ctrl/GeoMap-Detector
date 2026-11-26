#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  cp .env.example .env
fi
if [ -n "${CODESPACE_NAME:-}" ]; then
  gmd_domain="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  gmd_host="${CODESPACE_NAME}-8095.${gmd_domain}"
  sed -i '/^S3_PUBLIC_ENDPOINT=/d; /^S3_PROXY_HOST=/d; /^UPLOAD_CORS_ORIGIN=/d' .env
  printf '\nS3_PUBLIC_ENDPOINT=https://%s\nS3_PROXY_HOST=%s\nUPLOAD_CORS_ORIGIN=https://%s,https://tri-ctrl.github.io\n' "$gmd_host" "$gmd_host" "$gmd_host" >> .env
fi
docker compose up -d --build
