import { describe, expect, test } from "bun:test";

import { goalContract } from "@fungi.computer/shiitake-extensions/goal";

import { createTuiFixture, fixtureGoalStartedAt } from "./fixture.js";

describe("TUI Session fixture", () => {
  test("distinct fixture owners have distinct durable identities matching their Session", async () => {
    const first = createTuiFixture();
    const second = createTuiFixture();
    expect(first.identity).not.toEqual(second.identity);
    expect((await first.session.read()).sessionId).toBe(
      first.identity.sessionId,
    );
    expect((await second.session.read()).sessionId).toBe(
      second.identity.sessionId,
    );
  });

  test("projects an accepted prompt through public owner update and progress frames", async () => {
    const fixture = createTuiFixture({
      goal: {
        revision: "fixture-goal",
        objective: "Preserve fixture goal",
        state: "active",
        startedAt: fixtureGoalStartedAt,
        pauseCause: null,
      },
    });
    const watch = await fixture.session.watch();
    const changes = watch.changes[Symbol.asyncIterator]();
    await fixture.session.extension(goalContract.id).call("pause", {});
    expect((await changes.next()).value).toMatchObject({
      kind: "update",
      extensions: {
        [goalContract.id]: {
          status: "running",
          value: {
            goal: {
              revision: "fixture-goal",
              objective: "Preserve fixture goal",
              state: "paused",
            },
          },
        },
      },
    });
    const accepted = await fixture.session.command({
      requestId: "fixture-request",
      text: "Native prompt",
      delivery: "followUp",
      type: "prompt",
    });
    expect(accepted).toEqual({
      commandId: "owner-fixture-request",
      status: "accepted",
    });

    expect((await changes.next()).value).toMatchObject({
      kind: "update",
      cursor: null,
      messages: [],
      pending: {
        total: 1,
        prompts: [
          {
            requestId: "fixture-request",
            commandId: "owner-fixture-request",
            delivery: "followUp",
            text: "Native prompt",
          },
        ],
        hasMore: false,
      },
    });
    fixture.confirmLatestPrompt();
    const ownerUpdate = await changes.next();
    const progress = await changes.next();

    expect(ownerUpdate.value).toMatchObject({
      extensions: {
        [goalContract.id]: {
          value: {
            goal: {
              revision: "fixture-goal",
              objective: "Preserve fixture goal",
              state: "paused",
            },
          },
        },
      },
      kind: "update",
      activity: { queue: { state: "running" } },
    });
    expect(progress.value).toMatchObject({
      kind: "progress",
      progress: { text: "Fixture is streaming a reply." },
    });

    await watch.close();
    await watch.close();
    await fixture.waitForClose();
    expect(fixture.closeCalls()).toBe(1);
  });
});
