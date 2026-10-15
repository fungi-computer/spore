/**
 * Probe pane: a non-built-in pane built only on the Button. If the
 * conversation pane needs a capability, this probe exercises it too, which
 * proves the capability is public. Architecture rules treat this directory
 * exactly like `apps/tui/src/panes/*`.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  definePaneKind,
  type PaneKit,
  type PaneTarget,
} from "../../../src/button/index.js";

export type ProbePaneTarget = Readonly<{ kind: "probe"; label: string }>;

function ProbeView({
  kit,
  target,
}: Readonly<{ kit: PaneKit; target: ProbePaneTarget }>) {
  const viewport = useSyncExternalStore(
    kit.viewport.subscribe,
    kit.viewport.read,
  );
  const focused = useSyncExternalStore(
    kit.input.focused.subscribe,
    kit.input.focused.read,
  );
  const [keys, setKeys] = useState("");
  useEffect(() => {
    const commands = kit.commands.contribute([
      {
        id: "switch-conversation",
        title: "Switch conversation",
        category: "Probe",
        projections: { bindings: { values: ["o"], order: 1 } },
        handler: async () => {
          const outcome = await kit.replace({
            kind: "conversation",
            agentId: "local",
            sessionId: null,
            createRequestId: "probe-new-conversation",
          });
          if (outcome.kind === "refused")
            kit.notify({ tone: "error", message: outcome.reason });
        },
      },
    ]);
    const chip = kit.status.contribute({
      slot: "chips",
      order: 1,
      text: `Probe ${target.label}`,
      compact: "Probe",
      tone: "info",
    });
    const stopKeys = kit.input.onKey((key) => {
      if (key.name.length !== 1) return false;
      setKeys((current) => current + key.name);
      return true;
    });
    return () => {
      stopKeys();
      chip.dispose();
      commands.dispose();
    };
  }, [kit, target.label]);
  return (
    <text>
      {`${target.label} ${String(viewport.width)}x${String(viewport.height)}${focused ? " focused" : ""} keys:${keys}`}
    </text>
  );
}

const decodeProbeTarget = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal("probe"), label: Schema.String }),
);

/** Open requests are data from other panes: parse before rendering. */
function parseProbeTarget(target: PaneTarget): ProbePaneTarget | undefined {
  return Option.getOrUndefined(decodeProbeTarget(target));
}

export const probePane = definePaneKind<ProbePaneTarget>({
  kind: "probe",
  parse: parseProbeTarget,
  key: (target) => `probe:${target.label}`,
  title: (target) => `Probe ${target.label}`,
  launcher: {
    name: "Probe",
    description: "A pane built only on the Button",
    target: { kind: "probe", label: "menu" },
  },
  View: ProbeView,
});
