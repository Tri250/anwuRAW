#!/usr/bin/env bash
# Verifies that a release contains every artifact the build matrix must produce.
#
# The previous implementation compared against a hard-coded asset *count* (30).
# That number was calibrated before the tethering variants, the extra Linux
# glibc targets and the updater signatures were added, so it silently drifted
# out of date (v1.6.11 shipped 43 assets) and could not express *which* artifacts
# were missing. Checking the required names directly is both stable and precise.
#
# Usage:
#   check-release-assets.sh precheck   # prints complete=true|false, always exits 0
#   check-release-assets.sh verify     # exits 1 when anything is missing
#
# Environment: REPOSITORY, GH_TOKEN, and either RELEASE_ID or TAG.
set -uo pipefail

mode="${1:-verify}"
: "${REPOSITORY:?REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

# The release id is often only available as a tag (e.g. workflow_dispatch runs
# that only pass the tag, or draft releases whose tag ref does not exist yet).
# Resolve it explicitly instead of relying on the caller's expression.
resolve_release_id() {
  if [ -n "${RELEASE_ID:-}" ]; then
    printf '%s' "${RELEASE_ID}"
    return 0
  fi
  if [ -n "${TAG:-}" ]; then
    gh api "repos/${REPOSITORY}/releases/tags/${TAG}" --jq '.id' 2>/dev/null
    return 0
  fi
  return 1
}

if ! RELEASE_ID="$(resolve_release_id)" || [ -z "${RELEASE_ID}" ]; then
  if [ "${mode}" = "precheck" ]; then
    echo "Could not resolve a release id; assuming the release needs a rebuild."
    echo "complete=false" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi
  echo "::error::Could not resolve the release id (release-id='${RELEASE_ID:-}', tag='${TAG:-}')."
  exit 1
fi

echo "Checking assets of release ${RELEASE_ID} (${mode})."

assets=""
fetched=false
for attempt in 1 2 3 4 5; do
  if assets=$(gh api --paginate \
    "repos/${REPOSITORY}/releases/${RELEASE_ID}/assets?per_page=100" \
    --jq '.[].name' 2>/tmp/assets_err); then
    count=$(printf '%s\n' "${assets}" | grep -c . || true)
    echo "Attempt ${attempt}: fetched ${count:-0} asset(s)."
    fetched=true
    break
  fi
  echo "Attempt ${attempt}: assets API query failed:" >&2
  cat /tmp/assets_err >&2 || true
  sleep $((attempt * 5))
done

if [ "${fetched}" != "true" ]; then
  if [ "${mode}" = "precheck" ]; then
    echo "complete=false" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi
  echo "::error::Could not list release assets after 5 attempts."
  exit 1
fi

# Every platform in release.yml's matrix must contribute its primary bundle,
# and the desktop bundles that the updater consumes must be signed
# (`.sig` files only exist when TAURI_SIGNING_PRIVATE_KEY is configured).
required_patterns=(
  # Windows x64 + arm64 (NSIS installers)
  '^01_RapidRAW_v[0-9.]+_windows_x64\.exe$'
  '^01_RapidRAW_v[0-9.]+_windows_x64\.exe\.sig$'
  '^01_RapidRAW_v[0-9.]+_windows-11-arm_arm64\.exe$'
  '^01_RapidRAW_v[0-9.]+_windows-11-arm_arm64\.exe\.sig$'
  # macOS arm64 + x64, standard and tethering
  '^02_RapidRAW_v[0-9.]+_macos-14_aarch64\.dmg$'
  '^02_RapidRAW_v[0-9.]+_macos-15-intel_x64\.dmg$'
  '^02_tethering_RapidRAW_v[0-9.]+_macos-14_aarch64\.dmg$'
  '^02_tethering_RapidRAW_v[0-9.]+_macos-15-intel_x64\.dmg$'
  '^02_RapidRAW_v[0-9.]+_macos-14_aarch64\.app\.tar\.gz\.sig$'
  '^02_RapidRAW_v[0-9.]+_macos-15-intel_x64\.app\.tar\.gz\.sig$'
  # Linux: glibc 2.35 (ubuntu-22.04) and 2.39 (ubuntu-24.04), amd64 + arm64
  '^03_RapidRAW_v[0-9.]+_ubuntu-22.04_amd64\.AppImage$'
  '^03_RapidRAW_v[0-9.]+_ubuntu-22.04-arm_aarch64\.AppImage$'
  '^03_RapidRAW_v[0-9.]+_ubuntu-24.04_amd64\.AppImage$'
  '^03_RapidRAW_v[0-9.]+_ubuntu-24.04-arm_aarch64\.AppImage$'
  '^03_tethering_RapidRAW_v[0-9.]+_ubuntu-22.04_amd64\.AppImage$'
  '^03_tethering_RapidRAW_v[0-9.]+_ubuntu-24.04_amd64\.AppImage$'
  # Android arm64-v8a (APK is the sideloadable bundle; .aab is for the store)
  '^04_RapidRAW_v[0-9.]+_android_arm64-v8a\.apk$'
  # Updater manifest served from releases/latest/download/latest.json
  '^latest\.json$'
)

missing=()
for pattern in "${required_patterns[@]}"; do
  if ! printf '%s\n' "${assets}" | grep -Eq -- "${pattern}"; then
    missing+=("${pattern}")
  fi
done

if [ "${#missing[@]}" -eq 0 ]; then
  echo "All ${#required_patterns[@]} required artifacts are present."
  if [ "${mode}" = "precheck" ]; then
    echo "complete=true" >> "${GITHUB_OUTPUT:-/dev/null}"
  fi
  exit 0
fi

echo "Missing ${#missing[@]} of ${#required_patterns[@]} required artifacts:"
for pattern in "${missing[@]}"; do
  echo "  - ${pattern}"
done

if [ "${mode}" = "precheck" ]; then
  echo "complete=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

echo "::error::Release ${RELEASE_ID} is missing ${#missing[@]} required artifact(s); refusing to publish an incomplete release."
exit 1
