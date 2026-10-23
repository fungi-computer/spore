import { expect, test } from "bun:test";
import { agentLabel } from "../src/agent-label.js";

test("made by resolves the immutable creating Agent id, not a wire display name", () => {
  const parent = {
    agentId: "parent-id",
    name: "Shiitake",
    createdBy: null,
    databasePath: "/project/parent/agent.sqlite",
    sessionCount: 0,
  };
  const child = {
    agentId: "child-id",
    name: "Fixer",
    createdBy: parent.agentId,
    databasePath: "/project/child/agent.sqlite",
    sessionCount: 0,
  };
  expect(agentLabel(child, [parent, child])).toBe("Fixer, made by Shiitake");
  expect(agentLabel(child, [child])).toBe("Fixer, made by parent-id");
  expect(agentLabel(parent, [parent, child])).toBe("Shiitake");
});
