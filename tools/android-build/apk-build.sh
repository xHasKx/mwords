#!/usr/bin/env bash
# Build an mwords APK with Capacitor.
# Run *inside the container* from /work (the project root).
# Use tools/android-build/container-shell.sh on the host to drop into
# the container, then invoke this script.
#
# Steps:
#   1. npm ci                  — install JS deps
#   2. npm run build           — produce dist/
#   3. npx cap sync android    — copy dist/ into the native project
#   4. ./gradlew <task>        — build the APK (default: assembleDebug)
#
# Pass an alternate Gradle task as the first argument, e.g.
#   tools/android-build/apk-build.sh assembleRelease
# Release builds need a signing config in android/app/build.gradle plus
# the secrets in the environment (ANDROID_KEYSTORE_PATH,
# ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD).
set -euo pipefail

TASK="${1:-assembleDebug}"

if [[ ! -f package.json ]]; then
  echo "error: package.json not found — run this from /work inside the container." >&2
  exit 1
fi

if [[ ! -d android/app ]]; then
  cat >&2 <<'EOF'
error: android/app/ not found — Capacitor's Android project hasn't been
       generated yet. Run these once inside the container:

         npm i -D @capacitor/cli @capacitor/core @capacitor/android
         npx cap init mwords io.github.xhaskx.mwords --web-dir=dist
         npx cap add android

EOF
  exit 1
fi

echo "==> npm ci"
npm ci

echo "==> npm run build"
npm run build

echo "==> npx cap sync android"
npx cap sync android

echo "==> ./gradlew $TASK"
( cd android && ./gradlew "$TASK" )

shopt -s nullglob
mapfile -t apks < <(find android/app/build/outputs/apk -name '*.apk' -type f 2>/dev/null)
if (( ${#apks[@]} == 0 )); then
  echo "error: build finished but no APK found under android/app/build/outputs/apk/" >&2
  exit 1
fi

echo
echo "APK(s):"
for apk in "${apks[@]}"; do
  size=$(stat -c%s "$apk")
  printf "  %s  (%s bytes - $(md5sum $apk))\n" "$apk" "$size"
done
