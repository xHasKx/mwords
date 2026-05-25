#!/usr/bin/env bash
# Open an interactive shell in the mwords Android build container.
# Project source is bind-mounted at /work; npm and Gradle caches live
# in a persistent podman volume mounted at /cache so they survive
# between container runs.
# Run from the project root: tools/android-build/container-shell.sh
set -euo pipefail

IMAGE="${MWORDS_ANDROID_IMAGE:-mwords-android:latest}"
CACHE_VOLUME="${MWORDS_ANDROID_CACHE:-mwords-android-cache}"

if [[ ! -f package.json ]]; then
  echo "error: package.json not found — run this from the project root." >&2
  exit 1
fi

if ! podman image exists "$IMAGE"; then
  echo "error: image $IMAGE not built. Run tools/android-build/container-build.sh first." >&2
  exit 1
fi

# Idempotent: only creates the named volume if it's missing.
podman volume inspect "$CACHE_VOLUME" >/dev/null 2>&1 \
  || podman volume create "$CACHE_VOLUME" >/dev/null

# --userns=keep-id + --user maps the host UID/GID into the container at
# the same numeric value, so files written to /work and /cache are
# owned by you on the host. :U recursively chowns the cache volume to
# match the container user (no-op once it's already yours). HOME lives
# inside the cache volume so npm/etc. have a persistent writable config
# dir; the mkdir runs each time in case it's a fresh volume.
# Keystore settings are forwarded by name only (no value here) — podman
# pulls them from the host shell environment if set, leaves them unset
# otherwise. The keystore path must point at a file inside /work (the
# bind-mounted project tree) so it's readable from the container.
# ANDROID_KEY_ALIAS has a project default baked into the image.
exec podman run --rm -it \
  --userns=keep-id \
  --user "$(id -u):$(id -g)" \
  -v "$PWD":/work:Z \
  -v "$CACHE_VOLUME":/cache:U,Z \
  -w /work \
  -e HOME=/cache/home \
  -e ANDROID_KEYSTORE_PATH \
  -e ANDROID_KEYSTORE_PASSWORD \
  -e ANDROID_KEY_PASSWORD \
  -e ANDROID_VERSION_NAME \
  -e ANDROID_VERSION_CODE \
  "$IMAGE" bash -c 'mkdir -p "$HOME" && exec bash'
