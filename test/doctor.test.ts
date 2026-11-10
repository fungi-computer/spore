import { expect, test } from "bun:test";
import type { PrivateLocalServiceStatus } from "@fungi.computer/truffle";
import { runDoctor } from "../src/doctor.js";

// The live decoder, fault latch and redaction are proven at their owner in
// runtimes/local; doctor consumes the public status contract read-only.
test("doctor prints the current FAILED code/since without starting a service", async () => {
  const since = new Date().toISOString();
  const status: PrivateLocalServiceStatus = {
    protocol: 5,
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

test("doctor gives a retry command when the network request fails", async () => {
  let output = "";
  const passed = await runDoctor({
    localServiceStatus: () => Promise.resolve(undefined),
    fungiAccount: () => Promise.resolve(undefined),
    models: {
      getProviders: () => [],
      checkAuth: () => Promise.resolve(undefined),
      login: () => Promise.reject(new Error("unused")),
      logout: () => Promise.resolve(),
    },
    connect: () => Promise.reject(new TypeError("fetch failed")),
    version: "fixture",
    write: (text) => {
      output += text;
    },
  });
  expect(passed).toBe(false);
  expect(output).toContain(
    "Check your network connection, then run fungi doctor.",
  );
  expect(output).not.toContain("TypeError");
  expect(output).toContain("PASS version:");
});

for (const providerId of ["openai", "anthropic"]) {
  test(`doctor recognizes ${providerId} subscription sign-in without requiring Fungi setup`, async () => {
    let output = "";
    const passed = await runDoctor({
      localServiceStatus: () => Promise.resolve(undefined),
      fungiAccount: () => Promise.resolve(undefined),
      models: {
        getProviders: () => [],
        checkAuth: (id) =>
          Promise.resolve(id === providerId ? { type: "oauth" } : undefined),
        login: () => Promise.reject(new Error("unused")),
        logout: () => Promise.resolve(),
      },
      connect: () => Promise.resolve(true),
      version: "fixture",
      write: (text) => {
        output += text;
      },
    });
    expect(passed).toBe(true);
    expect(output).toContain("subscription ready");
    expect(output).not.toContain("run fungi login");
    expect(output).toContain("Next: run fungi.");
  });
}
