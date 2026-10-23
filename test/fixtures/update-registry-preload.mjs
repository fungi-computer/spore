import { appendFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const trace = process.env.FUNGI_UPDATE_PROOF_TRACE;
if (trace === undefined) throw new Error("Missing isolated update proof trace");
if (process.argv[1] !== process.env.FUNGI_UPDATE_PROOF_CLI)
  throw new Error("Refusing a launcher outside the disposable installation");
appendFileSync(
  trace,
  `${JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    args: process.argv.slice(1),
    build: process.env.FUNGI_BUNDLED_BUILD_ID,
  })}\n`,
);
const fetch = globalThis.fetch;
// The registry is the only injected network boundary. Local's real HTTP
// transport, service process, SQLite, launcher and TUI are not replaced.
globalThis.fetch = (input, options) => {
  const url = new URL(
    input instanceof globalThis.Request ? input.url : String(input),
  );
  if (url.hostname === "registry.npmjs.org")
    return Promise.resolve(globalThis.Response.json({ version: "0.1.1" }));
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    return Promise.reject(new Error(`Unexpected proof network: ${url.origin}`));
  return fetch(input, options);
};
