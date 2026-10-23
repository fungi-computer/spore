import { appendFileSync } from "node:fs";
import { mock } from "bun:test";
import * as service from "@fungi.computer/truffle/service";

const trace = process.env.FUNGI_TEST_UPDATE_TRACE;
if (trace === undefined) throw new Error("Missing isolated update trace");
const record = (event: string) => {
  appendFileSync(trace, `${event}\n`);
};

// Replace only the process manager. The real CLI dispatch and updater adapter
// still run, but this proof cannot start or stop a machine-local service.
await mock.module("@fungi.computer/truffle/service", () => ({
  ...service,
  createPrivateLocalServiceManager: () => {
    record("new manager");
    return {
      start: () => {
        record("public ensure");
        return process.env.FUNGI_TEST_UPDATE_REFUSE === "1"
          ? Promise.reject(new Error("Fixture version ensure refused"))
          : Promise.resolve({
              serviceId: "update-call-proof",
              baseUrl: "http://127.0.0.1:1",
              pid: process.pid,
              protocol: 1,
              version: "fixture-new-launcher",
            });
      },
      stop: () => {
        record("unexpected stop");
        throw new Error("Replacement must belong to public ensure");
      },
    };
  },
}));
