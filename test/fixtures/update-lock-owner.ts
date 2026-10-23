import { acquireNodeStoreLease } from "@fungi.computer/shiitake/node";

const path = process.argv[2];
if (path === undefined) throw new Error("Expected lock file path");
const lease = acquireNodeStoreLease(path);
process.on("SIGTERM", () => {
  lease.release();
  process.exit(0);
});
console.log("locked");
setInterval(() => undefined, 1_000);
