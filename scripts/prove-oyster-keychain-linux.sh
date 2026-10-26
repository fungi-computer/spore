#!/usr/bin/env bash
# Built-package proof. Install and run entirely inside a disposable Docker container.
set -euo pipefail
cd "$(dirname "$0")/../../.."
root=$PWD
scratch=$(mktemp -d "$root/.botanical/oyster-keychain-proof.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
cli=$(npm pack --silent .botanical/fungi-cli-package --pack-destination "$scratch")
native=$(npm pack --silent .botanical/fungi-cli-native-linux-x64 --pack-destination "$scratch")
docker build -q -f apps/tui/scripts/oyster-keychain-linux-proof.Dockerfile apps/tui/scripts > "$scratch/image"
docker run --rm --user 1000:1000 -e HOME=/tmp \
  -v "$root:/repo:ro" -v "$scratch:/proof:ro" \
  -e CLI_TARBALL="/proof/$cli" -e NATIVE_TARBALL="/proof/$native" \
  "$(cat "$scratch/image")" bash /repo/apps/tui/scripts/oyster-keychain-linux-container.sh
