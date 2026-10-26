#!/usr/bin/env bash
# Run on a Mac with Node, Bun and pnpm installed; never use a live Oyster key.
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { echo 'This proof requires macOS' >&2; exit 1; }
cd "$(dirname "$0")/../../.."
root=$PWD
heavy_slot=${HEAVY_SLOT:-$HOME/Botanical-cto/lanes/heavy-slot.sh}
arch=$(uname -m)
case "$arch" in arm64) target=darwin-arm64 ;; x86_64) target=darwin-x64 ;; *) exit 1 ;; esac
scratch=$(mktemp -d)
chmod 700 "$scratch"
service=fungi-oyster-mcp
account="oyster-mcp:https://oyster-mac-proof-$(openssl rand -hex 8).example"
endpoint="${account#oyster-mcp:}/mcp"
key=oyk_disposable-mac-keychain-proof
keychain=$(security default-keychain -d user | tr -d ' "')
cleanup() {
  if [[ ${created:-0} == 1 ]]; then
    security delete-generic-password -s "$service" -a "$account" "$keychain" >/dev/null ||
      echo 'Keychain cleanup failed; delete the dummy entry manually' >&2
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
if security find-generic-password -s "$service" -a "$account" "$keychain" >/dev/null 2>&1; then
  echo 'Refusing to overwrite an existing Keychain entry' >&2
  exit 1
fi
"$heavy_slot" pnpm turbo:run run build --filter=@fungi.computer/spore... --concurrency=4
"$heavy_slot" pnpm --dir apps/tui run build:proof-package
cli_tarball=$(npm pack --silent .botanical/fungi-cli-package --pack-destination "$scratch")
native_tarball=$(npm pack --silent ".botanical/fungi-cli-native-$target" --pack-destination "$scratch")
npm install --prefix "$scratch/install" --no-audit --no-fund \
  "$scratch/$cli_tarball" "$scratch/$native_tarball"
package="$scratch/install/node_modules/@fungi.computer/spore"
cp -R "$package" "$scratch/staged"
ln -s "$scratch/install/node_modules" "$scratch/staged/node_modules"
"$heavy_slot" pnpm --dir apps/tui run build:binaries "$scratch/staged" "$target"
export HOME="$scratch/home" USERPROFILE="$scratch/home" FUNGI_INSTALL="$scratch/home/.fungi"
mkdir -p "$HOME" "$scratch/project"
created=1
printf '%s\n' "$key" | node "$package/dist/fungi.cjs" mcp use "$endpoint" --from-file - -C "$scratch/project"
printf '%s\n' "$key" > "$scratch/expected"
security find-generic-password -s "$service" -a "$account" -w "$keychain" > "$scratch/actual"
cmp "$scratch/expected" "$scratch/actual"
OYSTER_PROOF_ENDPOINT="$endpoint" OYSTER_PROOF_KEY="$key" node --input-type=module -e '
  import { oysterMcpKeyAuth } from "./runtimes/local/dist/private-oyster-mcp-auth.js";
  if (await oysterMcpKeyAuth(new URL(process.env.OYSTER_PROOF_ENDPOINT)).token() !== process.env.OYSTER_PROOF_KEY)
    throw new Error("Local MCP did not read the key from macOS Keychain");
'
printf '%s\n' "$key" | "$root/.botanical/dist/fungi/fungi-$target" mcp use "$endpoint" --from-file - -C "$scratch/project"
security find-generic-password -s "$service" -a "$account" -w "$keychain" > "$scratch/actual"
cmp "$scratch/expected" "$scratch/actual"
test ! -e "$HOME/.config/fungi/credentials.json" ||
  ! grep -q 'oyster-mcp:' "$HOME/.config/fungi/credentials.json"
echo 'macOS Keychain: npm bundle and compiled binary saved and read the dummy key; no plaintext Oyster entry.'
