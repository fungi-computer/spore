import {
  subscribeSessionActivity,
  type ParakeetInteractions,
} from "@fungi.computer/parakeet/headless";
import type { ShiitakeSession } from "@fungi.computer/shiitake";
import {
  parseClientEntryV1,
  type ClientEntryV1,
  type ClientActivityV0,
} from "@fungi.computer/shiitake/client-entry";
import type { QueryClient } from "@tanstack/query-core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import { loadInstalledClientExtension } from "./installed-client-extension.js";

export function clientActivity(
  session: ShiitakeSession,
  queryClient: QueryClient,
  interactions: ParakeetInteractions | undefined,
  signal: AbortSignal,
) {
  return Stream.toAsyncIterable(
    Stream.callback<ClientActivityV0>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const end = () => {
              Queue.endUnsafe(queue);
            };
            signal.addEventListener("abort", end, { once: true });
            if (signal.aborted) end();
            let activity: ClientActivityV0 = "unknown";
            let delivered: ClientActivityV0 | undefined;
            let unsubscribeHost: (() => void) | undefined;
            const report = () => {
              const interaction = interactions
                ?.snapshot()
                .open?.host.snapshot();
              const next =
                interaction?.status === "prompting" ||
                (interaction?.status === "working" &&
                  interaction.handoff !== undefined)
                  ? "blocked"
                  : interaction?.status === "working"
                    ? "working"
                    : activity;
              if (next === delivered) return;
              delivered = next;
              Queue.offerUnsafe(queue, next);
            };
            const observeInteraction = () => {
              unsubscribeHost?.();
              unsubscribeHost = interactions
                ?.snapshot()
                .open?.host.subscribe(report);
              report();
            };
            const unsubscribeInteraction =
              interactions?.subscribe(observeInteraction);
            const unsubscribeSession = subscribeSessionActivity(
              queryClient,
              session,
              (state) => {
                activity = state;
                report();
              },
            );
            observeInteraction();
            return () => {
              signal.removeEventListener("abort", end);
              unsubscribeSession();
              unsubscribeInteraction?.();
              unsubscribeHost?.();
            };
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      { bufferSize: 1, strategy: "sliding" },
    ).pipe(Stream.takeWhile(() => !signal.aborted)),
  );
}

/** Load once in the application scope; attachments borrow the selected scope. */
export function prepareClientExtensions(
  options: Readonly<{
    invocationRoot: string;
    entries: readonly string[];
    clients?: readonly ClientEntryV1[] | undefined;
    queryClient: QueryClient;
    onError: (error: Error) => void;
  }>,
) {
  return Effect.gen(function* () {
    const clients = (options.clients ?? []).map((entry) =>
      parseClientEntryV1(entry),
    );
    const admitted = new Set(clients.map((entry) => entry.id));
    if (admitted.size !== clients.length)
      return yield* Effect.fail(
        new Error("Duplicate builtin client extension"),
      );
    const entries = options.entries.map((entry) => ({
      entry,
      root: options.invocationRoot,
    }));
    const definitions = yield* Effect.forEach(entries, ({ entry, root }) =>
      loadInstalledClientExtension(entry, root).pipe(
        Effect.flatMap((extension) => {
          if (extension === undefined) return Effect.succeed(undefined);
          if (admitted.has(extension.id))
            return Effect.fail(
              new Error(`Duplicate client extension: ${extension.id}`),
            );
          admitted.add(extension.id);
          return Effect.succeed(extension);
        }),
        Effect.catch((error) =>
          Effect.sync(() => {
            options.onError(error);
            return undefined;
          }),
        ),
      ),
    ).pipe(
      Effect.map((loaded) => [
        ...clients,
        ...loaded.filter((entry) => entry !== undefined),
      ]),
      Effect.forkScoped,
    );
    return {
      entries: Fiber.join(definitions),
      attach: (session: ShiitakeSession, interactions?: ParakeetInteractions) =>
        // Read the loader result without inheriting its application scope.
        Fiber.await(definitions).pipe(
          Effect.flatten,
          Effect.flatMap((loaded) =>
            Effect.forEach(
              loaded,
              (extension) =>
                extension.attach === undefined
                  ? Effect.void
                  : Effect.scoped(
                      Effect.gen(function* () {
                        const controller = new AbortController();
                        yield* Effect.addFinalizer(() =>
                          Effect.sync(() => {
                            controller.abort();
                          }),
                        );
                        const attachment = extension.attach?.({
                          activity: clientActivity(
                            session,
                            options.queryClient,
                            interactions,
                            controller.signal,
                          ),
                          signal: controller.signal,
                          onError: options.onError,
                        });
                        if (attachment !== undefined) yield* attachment;
                      }).pipe(Effect.andThen(Effect.never)),
                    ).pipe(
                      Effect.catchCause((cause) =>
                        Effect.sync(() => {
                          if (Cause.hasInterruptsOnly(cause)) return;
                          const failure = Cause.squash(cause);
                          options.onError(
                            failure instanceof Error
                              ? failure
                              : new Error(
                                  "Client extension attachment failed",
                                  { cause },
                                ),
                          );
                        }),
                      ),
                      Effect.forkScoped,
                    ),
              { discard: true },
            ),
          ),
          Effect.andThen(Effect.never),
          Effect.forkScoped,
          Effect.asVoid,
        ),
    };
  });
}
