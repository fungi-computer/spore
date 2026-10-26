#!/usr/bin/env bash
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
npm install --prefix "$scratch/install" --cache "$scratch/npm-cache" --no-audit --no-fund \
  "$CLI_TARBALL" "$NATIVE_TARBALL" > "$scratch/install.log"
cd "$scratch/install"
cli="$scratch/install/node_modules/@fungi.computer/spore/dist/fungi.cjs"
export HOME="$scratch/home" USERPROFILE="$scratch/home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share"
export XDG_CACHE_HOME="$HOME/.cache" XDG_STATE_HOME="$HOME/.local/state"
export FUNGI_INSTALL="$HOME/.fungi"
mkdir -p "$HOME" "$scratch/project"
endpoint=https://oyster.test/mcp
credential="$HOME/.config/fungi/credentials.json"

# No address at all, then an XDG runtime dir without a bus socket.
# Both must warn and use the 0600 file, never the host's session bus.
unset DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR DISPLAY
for shape in no-address missing-socket; do
  if [[ $shape == missing-socket ]]; then
    export XDG_RUNTIME_DIR="$scratch/absent-runtime"
  fi
  printf '%s\n' oyk_disposable-fallback-key |
    node "$cli" mcp use "$endpoint" --from-file - -C "$scratch/project" \
      > "$scratch/$shape.out" 2> "$scratch/$shape.err"
  test "$(grep -c 'OS keychain unavailable (Linux Secret Service)' "$scratch/$shape.err")" -eq 1
  grep -Fq "$credential" "$scratch/$shape.err"
  test "$(stat -c %a "$credential")" = 600
  printf '%s\n' oyk_disposable-fallback-key | node --input-type=module -e '
    import { oysterMcpKeyAuth } from "/repo/runtimes/local/dist/private-oyster-mcp-auth.js";
    let key = ""; for await (const chunk of process.stdin) key += chunk;
    const auth = oysterMcpKeyAuth(new URL("https://oyster.test/mcp"));
    if (await auth.token() !== key.trim() || await auth.token() !== key.trim())
      throw new Error("Fallback bearer does not match stdin");
  ' > "$scratch/$shape-read.out" 2> "$scratch/$shape-read.err"
  test "$(grep -c 'OS keychain unavailable (Linux Secret Service)' "$scratch/$shape-read.err")" -eq 1
  echo "Docker $shape: CLI write and Local read, warned 0600 fallback."
done

# Real Secret Service on a private session bus and home; seed pre-release data.
(
  unset XDG_RUNTIME_DIR
  export HOME="$scratch/keychain-home" USERPROFILE="$scratch/keychain-home"
  export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share"
  export XDG_CACHE_HOME="$HOME/.cache" XDG_STATE_HOME="$HOME/.local/state"
  export FUNGI_INSTALL="$HOME/.fungi"
  mkdir -p "$HOME" "$scratch/keychain-project"
  dbus-run-session -- bash -euo pipefail -c '
    printf "%s\n" test-password |
      gnome-keyring-daemon --unlock --components=secrets > "$1/daemon.out" 2> "$1/daemon.err"
    node --input-type=module -e '\''
      import { createPrivateCredentialStore } from "/repo/runtimes/local/dist/private-file-credential-store.js";
      const store = createPrivateCredentialStore(process.env.HOME + "/.config/fungi/credentials.json");
      await store.modify("oyster-mcp:https://oyster.test", async () => ({ type: "api_key", key: "oyk_disposable-old-key" }));
      await store.modify("other-local", async () => ({ type: "api_key", key: "unrelated-test-value" }));
    '\''
    printf "%s\n" oyk_disposable-new-key |
      node "$2" mcp use https://oyster.test/mcp --from-file - -C "$1/keychain-project" \
        > "$1/keychain.out" 2> "$1/keychain.err"
    test ! -s "$1/keychain.err"
    node --input-type=module -e '\''
      import { AsyncEntry } from "@napi-rs/keyring";
      import { createPrivateCredentialStore } from "/repo/runtimes/local/dist/private-file-credential-store.js";
      import { oysterMcpKeyAuth } from "/repo/runtimes/local/dist/private-oyster-mcp-auth.js";
      const entry = new AsyncEntry("fungi-oyster-mcp", "oyster-mcp:https://oyster.test", { linux: { store: "secret-service" } });
      if ((await entry.getPassword()) !== "oyk_disposable-new-key") throw new Error("Keychain did not receive the new key");
      const store = createPrivateCredentialStore(process.env.HOME + "/.config/fungi/credentials.json");
      if (await store.read("oyster-mcp:https://oyster.test") !== undefined) throw new Error("Plaintext Oyster key survived migration");
      if ((await store.read("other-local"))?.key !== "unrelated-test-value") throw new Error("Unrelated local credential changed");
      if ((await oysterMcpKeyAuth(new URL("https://oyster.test/mcp")).token()) !== "oyk_disposable-new-key")
        throw new Error("MCP bearer did not read from Secret Service");
    '\''
    echo "Docker Secret Service: CLI write, old-key migration/deletion, unrelated credential preservation, MCP read."
    # The daemon remains available, but its backing collection cannot persist
    # another key. A failed keychain call must never turn into a file write.
    chmod -R a-w "$HOME/.local/share/keyrings"
    result=0
    printf "%s\n" oyk_disposable-error-proof |
      timeout 25 node "$2" mcp use https://oyster.test/mcp --from-file - -C "$1/keychain-project" \
        > "$1/error.out" 2> "$1/error.err" || result=$?
    chmod -R u+w "$HOME/.local/share/keyrings"
    test "$result" -ne 0
    test "$result" -ne 124
    grep -Eiq "permission|denied|keyring|keychain|platform failure" "$1/error.err"
    ! grep -q "OS keychain unavailable" "$1/error.err"
    printf "Backend failure: "
    sed -n "1p" "$1/error.err" | cut -c1-160
    node --input-type=module -e '\''
      import { createPrivateCredentialStore } from "/repo/runtimes/local/dist/private-file-credential-store.js";
      const store = createPrivateCredentialStore(process.env.HOME + "/.config/fungi/credentials.json");
      if (await store.read("oyster-mcp:https://oyster.test") !== undefined)
        throw new Error("Erroring Secret Service silently fell back to the file");
    '\''
    echo "Docker erroring Secret Service: exit $result, failure visible, no plaintext fallback."
    node "$2" mcp show -C "$1/keychain-project" > "$1/show.out" 2> "$1/show.err"
    grep -Fq "https://oyster.test/mcp" "$1/show.out"
    test ! -s "$1/show.err"
    node "$2" mcp forget -C "$1/keychain-project" > "$1/forget.out" 2> "$1/forget.err"
    node "$2" logout --fungi-mcp https://oyster.test/mcp > "$1/logout.out" 2> "$1/logout.err"
    node --input-type=module -e '\''
      import { AsyncEntry } from "@napi-rs/keyring";
      const entry = new AsyncEntry("fungi-oyster-mcp", "oyster-mcp:https://oyster.test", { linux: { store: "secret-service" } });
      if ((await entry.getPassword()) !== "oyk_disposable-new-key")
        throw new Error("Show, forget or Hub logout changed the Oyster key");
    '\''
    echo "Docker show/forget/Hub logout: Oyster key unchanged."
  ' _ "$scratch" "$cli"
)
