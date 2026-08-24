#!/usr/bin/env bash
set -euo pipefail

mode="${1:?usage: run-readiness.sh baseline|candidate}"
compose_file=".github/mill-improve/compose.yaml"

case "$mode" in
  baseline | candidate) ;;
  *)
    printf 'unsupported mode: %s\n' "$mode" >&2
    exit 2
    ;;
esac

trap 'docker compose -f "$compose_file" down' EXIT

docker compose -f "$compose_file" config --quiet

if [[ "$mode" == baseline ]]; then
  docker compose -f "$compose_file" up -d
  sleep 2
else
  docker compose -f "$compose_file" up -d --wait --wait-timeout 30
fi

container_id="$(docker compose -f "$compose_file" ps -q readiness-fixture)"
test -n "$container_id"
health_status="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")"
if [[ "$health_status" != healthy ]]; then
  printf '%s\n' 'service readiness failed: database not ready' >&2
  exit 1
fi
