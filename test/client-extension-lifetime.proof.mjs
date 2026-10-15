import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { QueryClient } from "@tanstack/query-core";
import { prepareClientExtensions } from "@fungi.computer/tui/client-extensions";

const root = await mkdtemp(join(tmpdir(), "fungi-extension-lifetime-"));
const appScope = await Effect.runPromise(Scope.make());
const queryClient = new QueryClient();
const errors = [];
const failed = Promise.withResolvers();

async function fixture(name, completion) {
  const path = join(root, `${name}.mjs`);
  await writeFile(
    path,
    `
import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
import { EventEmitter } from "node:events";
export const events = new EventEmitter();
export const marks = ["loaded"];
const mark = (kind) => { marks.push(kind); events.emit(kind); };
export default {
  protocol: "shiitake.client/v1", id: ${JSON.stringify(name)},
  attach: () => Effect.acquireRelease(
    Effect.sync(() => mark("acquired")),
    () => Effect.sync(() => mark("closed")),
  ).pipe(Effect.andThen(${completion})),
};
`,
  );
  return { path, module: await import(pathToFileURL(path).href) };
}

async function selection(extensions, address) {
  const scope = await Effect.runPromise(Scope.fork(appScope, "sequential"));
  await Effect.runPromise(
    extensions.attach({ address }).pipe(Scope.provide(scope)),
  );
  return scope;
}

try {
  const healthy = await fixture("healthy", "Effect.never");
  const rejected = await fixture(
    "rejected",
    'Effect.fail(new Error("controlled setup rejection"))',
  );
  const extensions = await Effect.runPromise(
    prepareClientExtensions({
      invocationRoot: root,
      entries: [healthy.path, rejected.path],
      queryClient,
      onError: (error) => {
        errors.push(error);
        failed.resolve();
      },
    }).pipe(Scope.provide(appScope)),
  );

  const firstAcquired = once(healthy.module.events, "acquired");
  const first = await selection(extensions, "fixture://first");
  await firstAcquired;
  await failed.promise;
  assert.deepEqual(rejected.module.marks, ["loaded", "acquired", "closed"]);
  assert.equal(errors.length, 1);
  await Effect.runPromise(Scope.close(first, Exit.void));
  assert.deepEqual(healthy.module.marks, ["loaded", "acquired", "closed"]);

  const secondAcquired = once(healthy.module.events, "acquired");
  const secondRejected = once(rejected.module.events, "closed");
  await selection(extensions, "fixture://second");
  await secondAcquired;
  await secondRejected;
  await Effect.runPromise(Scope.close(appScope, Exit.void));
  for (const item of [healthy, rejected]) {
    assert.deepEqual(item.module.marks, [
      "loaded",
      "acquired",
      "closed",
      "acquired",
      "closed",
    ]);
  }
  assert.equal(errors.length, 2);
  process.stdout.write(
    "extension lifetime: single module identity, repeated selected attachment, failed-setup cleanup and held sibling interruption passed\n",
  );
} finally {
  await Effect.runPromise(Scope.close(appScope, Exit.void));
  queryClient.clear();
  await rm(root, { recursive: true, force: true });
}
