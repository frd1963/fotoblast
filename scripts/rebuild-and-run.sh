#!/usr/bin/env bash
# Kill any running Fotoblast container, build a multiarch image, and run it locally.
#
# Usage:
#   ./scripts/rebuild-and-run.sh
#   IMAGE=frd1963/fotoblast:multiarch PUSH=1 ./scripts/rebuild-and-run.sh
#   PUSH=0 ./scripts/rebuild-and-run.sh          # build current arch only, load locally
#   EVENT_NAME="smith-wedding" ./scripts/rebuild-and-run.sh
#
# Env overrides:
#   IMAGE            Image tag (default: frd1963/fotoblast:latest)
#   CONTAINER_NAME   Container name (default: fotoblast)
#   PORT             Host port (default: 3000)
#   VOLUME           Named volume for photos (default: fotoblast-data)
#   PLATFORMS        Build platforms (default: linux/amd64,linux/arm64)
#   BUILDER          buildx builder name (default: multiarch-builder)
#   PUSH             1 = push multiarch to registry then pull (default: 1)
#                    0 = build+load current platform only (no push)
#   EVENT_NAME       Optional event name passed into the container
#   MAX_UPLOAD_MB    Optional upload size limit
#   EXTRA_RUN_ARGS   Extra args appended to docker run

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-frd1963/fotoblast:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-fotoblast}"
PORT="${PORT:-3000}"
VOLUME="${VOLUME:-fotoblast-data}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-multiarch-builder}"
PUSH="${PUSH:-1}"

log() { printf '==> %s\n' "$*"; }

stop_container() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    log "Stopping container: $CONTAINER_NAME"
    docker rm -f "$CONTAINER_NAME" >/dev/null
  else
    log "No container named $CONTAINER_NAME"
  fi
}

ensure_builder() {
  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    log "Creating buildx builder: $BUILDER"
    docker buildx create --name "$BUILDER" --use
  else
    docker buildx use "$BUILDER"
  fi
  docker buildx inspect --bootstrap >/dev/null
}

build_image() {
  if [[ "$PUSH" == "1" ]]; then
    log "Building multiarch ($PLATFORMS) and pushing $IMAGE"
    docker buildx build \
      --platform "$PLATFORMS" \
      -t "$IMAGE" \
      --push \
      .
    log "Pulling $IMAGE for local run"
    docker pull "$IMAGE"
  else
    local host_platform
    host_platform="$(docker version -f '{{.Server.Os}}/{{.Server.Arch}}')"
    log "Building for host platform only ($host_platform) and loading $IMAGE"
    docker buildx build \
      --platform "$host_platform" \
      -t "$IMAGE" \
      --load \
      .
  fi
}

run_container() {
  local run_args=(
    -d
    --name "$CONTAINER_NAME"
    --rm
    -p "${PORT}:3000"
    -v "${VOLUME}:/app/repo"
  )

  if [[ -n "${EVENT_NAME:-}" ]]; then
    run_args+=(--env "EVENT_NAME=${EVENT_NAME}")
  fi
  if [[ -n "${MAX_UPLOAD_MB:-}" ]]; then
    run_args+=(--env "MAX_UPLOAD_MB=${MAX_UPLOAD_MB}")
  fi

  # shellcheck disable=SC2206
  if [[ -n "${EXTRA_RUN_ARGS:-}" ]]; then
    # Intentional word-splitting so callers can pass multiple flags.
    run_args+=(${EXTRA_RUN_ARGS})
  fi

  log "Starting $CONTAINER_NAME from $IMAGE on port $PORT"
  docker run "${run_args[@]}" "$IMAGE"
  log "Running at http://localhost:${PORT}/ui"
  docker ps --filter "name=^/${CONTAINER_NAME}$"
}

stop_container
ensure_builder
build_image
run_container
