#!/usr/bin/env bash
# Build the mwords Android build container.
# Run from the project root: tools/android-build/container-build.sh
set -euo pipefail

IMAGE="${MWORDS_ANDROID_IMAGE:-mwords-android:latest}"
CONTEXT="tools/android-build"

if [[ ! -f "$CONTEXT/Containerfile" ]]; then
  echo "error: $CONTEXT/Containerfile not found — run this from the project root." >&2
  exit 1
fi

echo "Building $IMAGE from $CONTEXT/Containerfile ..."
podman build -t "$IMAGE" -f "$CONTEXT/Containerfile" "$CONTEXT"
echo "Done. Enter the container with tools/android-build/container-shell.sh"
