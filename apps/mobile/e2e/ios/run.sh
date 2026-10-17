#!/usr/bin/env bash
# Runs the UI tests against an installed Pistead development build and a running native fixture.
#   pnpm dev:native                                   # test-mode server, faux host, writes .local/dev-native.json
#   npx expo start                                    # Metro for the development build (apps/mobile)
#   npx expo run:ios --device <udid> --no-bundler     # install the development build once
#   apps/mobile/e2e/ios/run.sh <udid> [screenshot dir]
# Needs XcodeGen (brew install xcodegen). Each run signs in with a fresh test token; signing out revokes the old one.
# PISTEAD_FIXTURE names another fixture file (default: the repository's .local/dev-native.json); the fixture must have a session.
set -euo pipefail

udid=${1:?usage: run.sh <simulator udid> [screenshot dir]}
shots=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
fixture=${PISTEAD_FIXTURE:-"$here/../../../../.local/dev-native.json"}
[[ -f $fixture ]] || { echo "No fixture at $fixture; start one with pnpm dev:native" >&2; exit 1; }

field() { node -e 'const f=require(process.argv[1]); process.stdout.write(String(f[process.argv[2]] ?? ""))' "$fixture" "$1"; }
server=$(field server)
session=$(field sessionId)
[[ -n $session && $session != null ]] || { echo "The fixture at $fixture has no session" >&2; exit 1; }
token=$(curl -fsS -X POST "$server/api/auth/test" -H "Authorization: Bearer $(field testSecret)" -H 'Content-Type: application/json' \
  -d '{"id":"dev","client":"native"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))')

cd "$here"
xcodegen generate --quiet
TEST_RUNNER_PISTEAD_SERVER=$server TEST_RUNNER_PISTEAD_TOKEN=$token TEST_RUNNER_PISTEAD_SESSION_ID=$session TEST_RUNNER_PISTEAD_SHOTS=$shots \
  xcodebuild test -project PisteadE2E.xcodeproj -scheme PisteadUITests -destination "id=$udid" -derivedDataPath "$here/build" -quiet
