import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WhistlePrompt, WhistleRuntime } from "@fungi.computer/whistle";
import {
  createWhistleInteractionHost,
  type WhistleInteractionHost,
} from "@fungi.computer/whistle/interaction";
import type { DialogController } from "./dialog.js";
import type { TuiSandboxSource, TuiSandboxStatus } from "./local-sandbox.js";
import { ModalHeader, modalContentWidth } from "./modal.js";
import { fitFooterCaption } from "./footer-layout.js";
import { Picker } from "./picker.js";
import type { TuiPresentation } from "./presentation.js";
import { InteractionView } from "./interaction-dialog.js";
import { reportFailure } from "./log-event.js";

const sandboxStatusKey = (identity: string | undefined) =>
  ["tui-sandbox-status", identity] as const;

const modes = [
  {
    mode: "read-only",
    name: "Read-only",
    description: "Read files; no edits or command network.",
  },
  {
    mode: "workspace",
    name: "Workspace",
    description: "Work in the Agent's folder, inside the sandbox.",
  },
  {
    mode: "full-access",
    name: "Full access",
    description: "Outside the sandbox, as you.",
  },
] as const;

type PermissionChange =
  | Readonly<{ kind: "mode"; mode: TuiSandboxStatus["mode"] }>
  | Readonly<{ kind: "remove-rule"; prefix: readonly string[] }>;

function PermissionsPicker({
  status,
  rules,
  source,
  signal,
  refresh,
  colors,
  onClose,
}: Readonly<{
  status: TuiSandboxStatus;
  rules: readonly (readonly string[])[];
  source: TuiSandboxSource;
  signal: AbortSignal;
  refresh: () => Promise<void>;
  colors: TuiPresentation["colors"];
  onClose: () => void;
}>) {
  const { width, height } = useTerminalDimensions();
  const current = modes.findIndex((choice) => choice.mode === status.mode);
  const compact = height < 20;
  const [operationHost, setOperationHost] = useState<WhistleInteractionHost>();
  const operation = useRef<WhistleInteractionHost | undefined>(undefined);
  useEffect(() => () => operation.current?.cancel(), []);
  const apply = async (change: PermissionChange) => {
    if (operation.current !== undefined) return;
    const host = createWhistleInteractionHost({ title: "Permissions" });
    operation.current = host;
    const attempt = host.begin();
    const activeSignal = AbortSignal.any([signal, attempt.interaction.signal]);
    const retire = () => {
      host.cancel();
    };
    signal.addEventListener("abort", retire, { once: true });
    if (signal.aborted) retire();
    setOperationHost(host);
    try {
      const confirmation:
        Extract<WhistlePrompt, { type: "confirmation" }> | undefined =
        change.kind === "remove-rule"
          ? {
              type: "confirmation",
              message: "Remove Always-allow rule?",
              summary: fitFooterCaption(
                `“${change.prefix.join(" ")}”`,
                modalContentWidth(width),
              ),
              body: "Remove this saved approval for every Workspace Agent in this project. Another rule may still cover the command.",
              confirmLabel: "Remove rule",
              cancelLabel: "Keep rule",
              destructive: true,
            }
          : change.mode === "full-access"
            ? {
                type: "confirmation",
                message: "Switch to Full access?",
                summary: "Outside the sandbox, as you",
                body: "Commands can use your files, network and credentials, without permission questions.",
                confirmLabel: "Use Full access",
                cancelLabel: `Keep ${modes[current]?.name ?? status.mode}`,
                destructive: true,
              }
            : undefined;
      if (confirmation !== undefined) {
        const confirmed = await attempt.interaction.prompt(confirmation);
        if (!confirmed) {
          attempt.settle({ status: "cancelled" });
          setOperationHost(undefined);
          return;
        }
      }
      attempt.interaction.notify({
        type: "progress",
        message:
          change.kind === "mode"
            ? "Saving Agent mode…"
            : "Removing project rule…",
      });
      await attempt.interaction.run(async () => {
        try {
          if (change.kind === "mode")
            await source.setMode(change.mode, activeSignal);
          else await source.rules.remove(change.prefix, activeSignal);
        } finally {
          await refresh();
        }
      });
      attempt.settle({ status: "handled" });
      onClose();
    } catch (cause) {
      if (activeSignal.aborted) attempt.settle({ status: "cancelled" });
      else {
        reportFailure("local-permissions", cause);
        attempt.settle({
          status: "failed",
          message:
            cause instanceof Error
              ? cause.message
              : "Unable to save permissions",
        });
      }
    } finally {
      signal.removeEventListener("abort", retire);
      operation.current = undefined;
    }
  };
  if (operationHost !== undefined)
    return (
      <InteractionView host={operationHost} colors={colors} onClose={onClose} />
    );
  return (
    <box flexDirection="column" rowGap={compact ? 0 : 1}>
      <ModalHeader
        content={{
          title: "Permissions",
          summary: `Current mode: ${modes[current]?.name ?? status.mode}`,
          facts: [
            {
              label: "Rules",
              value: "Shared by Workspace Agents in this project.",
            },
          ],
        }}
        width={modalContentWidth(width)}
        compact={compact}
        colors={colors}
      />
      <Picker
        choices={[
          ...modes.map((choice) => ({
            name: choice.name,
            description: choice.description,
            group: "Agent mode",
            tone:
              choice.mode === "full-access"
                ? ("destructive" as const)
                : undefined,
          })),
          ...rules.map((prefix) => ({
            name: `Remove “${prefix.join(" ")}”…`,
            group: "Always-allow rules",
            description: "Remove this project's saved approval.",
            tone: "destructive" as const,
          })),
        ]}
        currentIndex={current}
        searchable={rules.length > 3}
        rowLimit={Math.max(1, height - (compact ? 8 : 12))}
        colors={colors}
        onCancel={onClose}
        onSelect={(index) => {
          if (index === current) onClose();
          else {
            const selected = modes[index]?.mode;
            if (selected !== undefined)
              void apply({ kind: "mode", mode: selected });
            else {
              const prefix = rules[index - modes.length];
              if (prefix !== undefined)
                void apply({ kind: "remove-rule", prefix });
            }
          }
        }}
      />
      {rules.length === 0 ? (
        <text fg={colors.foreground} attributes={2}>
          No Always-allow rules in this project.
        </text>
      ) : null}
    </box>
  );
}

/** Human command door; Local remains the mode and project-rule authority. */
export function usePermissionsControls({
  source,
  commands,
  dialog,
  colors,
}: Readonly<{
  source: TuiSandboxSource | undefined;
  commands: Pick<WhistleRuntime, "contribute">;
  dialog: Pick<DialogController, "show">;
  colors: TuiPresentation["colors"];
}>) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: sandboxStatusKey(source?.identity),
    enabled: source !== undefined,
    staleTime: 0,
    queryFn: ({ signal }) => {
      if (source === undefined)
        throw new Error("Local permissions unavailable");
      return source.read(signal);
    },
  });
  useEffect(() => {
    if (status.error !== null)
      reportFailure("local-sandbox-status", status.error);
  }, [status.error]);
  const latestColors = useRef(colors);
  latestColors.current = colors;
  const show = dialog.show;
  useEffect(() => {
    if (source === undefined) return;
    const lifetime = new AbortController();
    let ownedDialog: ReturnType<typeof show> | undefined;
    const lease = commands.contribute({
      sourceId: "tui-frame",
      namespace: "tui",
      commands: [
        {
          id: "permissions",
          title: "Permissions",
          category: "Settings",
          description:
            "Choose Agent mode and remove project Always-allow rules",
          projections: {
            palette: {},
            help: {},
            slash: { aliases: ["permissions"], consumesDraft: true },
          },
          handler: async ({ interaction }) => {
            if (interaction === undefined)
              throw new Error("Managing permissions needs a person.");
            const [status, rules] = await Promise.all([
              source.read(lifetime.signal),
              source.rules.list(lifetime.signal),
            ]);
            lifetime.signal.throwIfAborted();
            ownedDialog = show((handle) => (
              <PermissionsPicker
                status={status}
                rules={rules}
                source={source}
                signal={lifetime.signal}
                refresh={async () => {
                  const filters = {
                    queryKey: sandboxStatusKey(source.identity),
                    exact: true,
                  };
                  // Invalidation alone reuses an initial fetch with no cached
                  // data. Retire that pre-write snapshot before reading again.
                  await queryClient.cancelQueries(filters);
                  await queryClient.invalidateQueries(filters);
                }}
                colors={latestColors.current}
                onClose={handle.dismiss}
              />
            ));
          },
        },
      ],
    });
    return () => {
      lifetime.abort();
      ownedDialog?.dismiss();
      lease.dispose();
    };
  }, [commands, show, source, queryClient]);
  return { status: status.data, refresh: status.refetch };
}
