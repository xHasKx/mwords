#!/usr/bin/env bash
# Regenerate Android launcher icons from a single source-of-truth design.
#
# Design: lowercase "m" in DejaVu Sans Bold, white on the app's accent
# blue (#2563eb — matches the light-theme --accent). Adaptive icon has
# the bg as a color resource and the "m" rendered onto the foreground
# layer; legacy ic_launcher.png / ic_launcher_round.png composite the
# two together (square / circle clip respectively) for pre-O launchers.
#
# Run from the project root: tools/android-build/regenerate-icons.sh
# Requires: ImageMagick (`magick` or `convert` — both work).
set -euo pipefail

if [[ ! -d android/app/src/main/res ]]; then
  echo "error: android/app/src/main/res not found — run from the project root." >&2
  exit 1
fi

# Pick the ImageMagick command, preferring v7 (`magick`).
if command -v magick >/dev/null 2>&1; then
  IM="magick"
else
  IM="convert"
fi

BG_COLOR='#2563eb'
FG_COLOR='#ffffff'
GLYPH='m'
FONT='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

RES=android/app/src/main/res

# Density → legacy icon px (full-bleed square / round)
declare -A LEGACY=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
# Density → adaptive icon foreground px (108dp at the density's scale)
declare -A FG=( [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432 )

# Update the adaptive-icon background color resource to match.
cat > "$RES/values/ic_launcher_background.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">$BG_COLOR</color>
</resources>
EOF

for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  legacy_size=${LEGACY[$density]}
  fg_size=${FG[$density]}
  dir="$RES/mipmap-$density"

  # --- Adaptive icon foreground (transparent bg, glyph in safe zone).
  # Safe zone is the inner 66% of the canvas, so target the glyph at
  # ~50% of canvas height for comfortable margin.
  fg_glyph_pt=$(( fg_size / 2 ))
  $IM -size "${fg_size}x${fg_size}" xc:none \
    -font "$FONT" -pointsize "$fg_glyph_pt" -fill "$FG_COLOR" \
    -gravity center -annotate +0+0 "$GLYPH" \
    "$dir/ic_launcher_foreground.png"

  # --- Legacy square icon (full-bleed bg + glyph).
  legacy_glyph_pt=$(( legacy_size * 2 / 3 ))
  $IM -size "${legacy_size}x${legacy_size}" "xc:$BG_COLOR" \
    -font "$FONT" -pointsize "$legacy_glyph_pt" -fill "$FG_COLOR" \
    -gravity center -annotate +0+0 "$GLYPH" \
    "$dir/ic_launcher.png"

  # --- Legacy round icon (circle clip of the square).
  $IM "$dir/ic_launcher.png" \
    \( -size "${legacy_size}x${legacy_size}" xc:none \
       -fill white -draw "circle $((legacy_size/2)),$((legacy_size/2)) $((legacy_size/2)),0" \) \
    -alpha set -compose CopyOpacity -composite \
    "$dir/ic_launcher_round.png"
done

echo "Regenerated Android launcher icons for all 5 densities."

# Web favicons — derive from the largest Android launcher PNG so the
# Capacitor app, the browser tab, and the PWA / iOS home-screen icon
# all share the same design.
mkdir -p public
src="$RES/mipmap-xxxhdpi/ic_launcher.png"
$IM "$src" -define icon:auto-resize=16,32,48 public/favicon.ico
$IM "$src" -resize 180x180 public/apple-touch-icon.png
$IM "$src" -resize 192x192 public/icon-192.png
$IM "$src" -resize 512x512 public/icon-512.png

echo "Regenerated web favicons under public/."
