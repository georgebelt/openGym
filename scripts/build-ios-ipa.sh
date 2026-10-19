#!/usr/bin/env bash
# Build a device IPA for signing separately. No Apple account or signing identity is used.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
frontend_dir="$repo_dir/frontend"
ios_dir="$frontend_dir/ios/App"
output_dir="$ios_dir/output"
# CocoaPods runs xcodebuild clean during cap sync. Keep archives outside its build directory:
# an archive created there by -archivePath makes the next clean refuse the unowned directory.
archive_dir="$output_dir/App.xcarchive"

for tool in node npm pod xcodebuild ditto shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing $tool. Install Node, Xcode and CocoaPods before building." >&2
    exit 1
  fi
done
xcodebuild -checkFirstLaunchStatus
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

cd "$frontend_dir"
version="$(node -p "require('./package.json').version")"
build_number="$(node -e 'const s = require("node:fs").readFileSync("android/app/build.gradle", "utf8"); const m = s.match(/^\s*versionCode\s+(\d+)/m); if (!m) process.exit(1); console.log(m[1])')"
revision="$(git -C "$repo_dir" rev-parse --short HEAD)"
export APP_BUILD="${APP_BUILD:-$revision}"
mkdir -p "$output_dir"

npm ci --no-audit --no-fund
VITE_MOBILE=1 npm run build
node "$repo_dir/scripts/catalogue/stage-media.mjs" dist
npx --no-install cap sync ios
node --input-type=module <<'NODE'
import { checkCopy } from './scripts/check-mobile-bundle.mjs'
const problems = ['dist', 'ios/App/App/public'].flatMap(checkCopy)
if (problems.length) throw new Error(problems.join('\n'))
console.log('Mobile bundle verified in dist and the iOS app.')
NODE

archive_log="$output_dir/xcodebuild.log"
echo "Archiving the iOS device app; log: $archive_log"
if ! xcodebuild \
  -workspace "$ios_dir/App.xcworkspace" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$frontend_dir/ios/DerivedData" \
  -archivePath "$archive_dir" \
  MARKETING_VERSION="$version" \
  CURRENT_PROJECT_VERSION="$build_number" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  archive >"$archive_log" 2>&1; then
  tail -80 "$archive_log" >&2
  exit 1
fi

app_dir="$archive_dir/Products/Applications/App.app"
test -f "$app_dir/App"
packaging_dir="$(mktemp -d "$output_dir/.ipa.XXXXXX")"
trap 'rm -rf "$packaging_dir"' EXIT
mkdir "$packaging_dir/Payload"
ditto --noextattr --norsrc "$app_dir" "$packaging_dir/Payload/App.app"

ipa_name="openGym-$version-$build_number-$revision-unsigned.ipa"
ditto --noextattr --norsrc -c -k --keepParent \
  "$packaging_dir/Payload" "$output_dir/$ipa_name"
cd "$output_dir"
shasum -a 256 "$ipa_name" > "$ipa_name.sha256"
echo "Unsigned IPA: $output_dir/$ipa_name"
cat "$ipa_name.sha256"
