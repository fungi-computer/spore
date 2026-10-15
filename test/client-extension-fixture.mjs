import * as Effect from "effect/Effect";
import { fixtureClients } from "./fixture.js";

export const noOpClientExtensions = (options) =>
  Effect.succeed({
    entries: Effect.succeed(options.clients ?? fixtureClients),
    attach: () => Effect.void,
  });
