import { expect, test as it } from "bun:test";
import { offlineLine } from "../src/computer-command.js";

it("says why the link is down in one plain sentence", () => {
  expect(
    offlineLine({ kind: "offline", retryInMs: 4000, reason: "unreachable" }),
  ).toBe("offline, can't reach the host; retrying in 4 s");
  expect(
    offlineLine({
      kind: "offline",
      retryInMs: 500,
      reason: "connection-closed",
    }),
  ).toBe("offline, the connection dropped; retrying in 1 s");
  const probe = offlineLine({
    kind: "offline",
    retryInMs: 15000,
    reason: "probe-unavailable",
  });
  expect(probe).toBe(
    "offline, can't check the host (is this machine online?); retrying in 15 s",
  );
  expect(probe).not.toMatch(/fetch failed|Dial probe/);
});
