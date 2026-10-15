import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseClientEntryV1 } from "@fungi.computer/shiitake/client-entry";

const decodeModule = Schema.decodeUnknownSync(
  Schema.Struct({ default: Schema.Unknown }),
);

/** Resolve a host-selected installed entry using the Bun CLI resolver. */
export function loadInstalledClientExtension(
  entry: string,
  invocationRoot: string,
  optional = false,
) {
  return Effect.tryPromise({
    try: async () => {
      const path = await Bun.resolve(entry, invocationRoot).catch(
        (cause: unknown) => {
          if (
            optional &&
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ERR_MODULE_NOT_FOUND"
          )
            return undefined;
          throw cause;
        },
      );
      if (path === undefined) return undefined;
      const module = decodeModule(await import(pathToFileURL(path).href));
      return parseClientEntryV1(module.default);
    },
    catch: (cause) =>
      new Error(`Client extension unavailable: ${entry}`, { cause }),
  });
}
