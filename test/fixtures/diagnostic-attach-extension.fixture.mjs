import { defineClientEntry } from "@fungi.computer/shiitake/client-entry";
import { ExtensionId } from "@fungi.computer/shiitake/extensions";
import * as Effect from "effect/Effect";

const failure = new Error("Extension attachment failed");
failure.name = "ExtensionAttachError";
export default defineClientEntry(
  {
    id: ExtensionId.make("diagnostic-attach-fixture"),
    commands: {},
    projection: null,
  },
  { attach: () => Effect.fail(failure) },
);
