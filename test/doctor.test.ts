import { expect, test } from "bun:test";
import type { PrivateLocalServiceStatus } from "@fungi.computer/truffle";
import { runDoctor } from "../src/doctor.js";

// The live decoder, fault latch and redaction are proven at their owner in
// runtimes/local; doctor consumes the public status contract read-only.
test("doctor prints the current FAILED code/since without starting a service", async () => {
  const since = new Date().toISOString();
  const status: PrivateLocalServiceStatus = {
    protocol: 3,
    serviceId: "fixture-service",
    pid: process.pid,
    version: "source",
    baseUrl: "http://127.0.0.1:12345",
    diagnostics: { state: "failed", code: "sink-write-failed", since },
  };
  let reads = 0;
  let output = "";
  await runDoctor({
    localServiceStatus: () => {
      reads++;
      return Promise.resolve(status);
    },
    fungiAccount: () => Promise.resolve(undefined),
    models: {
      getProviders: () => [],
      checkAuth: () => Promise.resolve(undefined),
      login: () => Promise.reject(new Error("unused")),
      logout: () => Promise.resolve(),
    },
    connect: () => Promise.resolve(true),
    version: "fixture",
    write: (text) => {
      output += text;
    },
  });
  expect(output).toContain(`FAILED sink-write-failed since ${since}`);
  expect(reads).toBe(1);
});
