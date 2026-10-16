// Fairy Ring's Fungi host entry: read-only Agent tools over the Fairy Ring
// core. The extension never sees a credential: it reads the core's
// non-secret replies from `fairy-ring --json list --no-fetch`.
import { execFile } from "node:child_process";
/** Ask the core for its read-only active-account observation. */
function cli(signal) {
  return new Promise((resolve, reject) => {
    execFile(
      "fairy-ring",
      ["--json", "list", "--no-fetch"],
      { signal, timeout: 20_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) resolve(undefined);
        else {
          try {
            resolve(JSON.parse(stdout).providers);
          } catch (cause) {
            reject(new Error("Fairy Ring returned malformed JSON", { cause }));
          }
        }
      },
    );
  });
}

/** Expose cached Fungi status and non-secret account views, never credentials or user IDs. */
function summarize(view) {
  return {
    provider: view.id,
    name: view.name,
    autoRotate: view.settings.enabled,
    threshold: view.settings.threshold,
    strategy: view.settings.strategy,
    activeAccount: view.activeNumber ?? null,
    observedActive: view.observedActive
      ? {
          name:
            view.observedActive.email ??
            view.observedActive.label ??
            "signed-in account",
          plan: view.observedActive.plan ?? null,
        }
      : null,
    cachedFungiStatus: view.cachedFungiStatus
      ? {
          status: view.cachedFungiStatus.status,
          hub: view.cachedFungiStatus.hub ?? null,
          selectedTeam: view.cachedFungiStatus.selectedTeam
            ? {
                name: view.cachedFungiStatus.selectedTeam.name,
                handle: view.cachedFungiStatus.selectedTeam.handle,
              }
            : null,
          teamCount: view.cachedFungiStatus.teamCount ?? null,
          accessExpiresAt: view.cachedFungiStatus.accessExpiresAt ?? null,
        }
      : null,
    observationError: view.observationError
      ? {
          kind: view.observationError.kind,
          message: view.observationError.message,
        }
      : null,
    accounts: view.accounts.map((account) => ({
      number: account.number,
      name:
        account.alias ??
        account.email ??
        account.label ??
        `account ${account.number}`,
      plan: account.plan ?? null,
      active: account.active,
      inRotation: account.inRotation,
      usagePercent: account.binding ?? null,
      windows: account.windows.map((window) => ({
        id: window.id,
        percent: window.pct ?? null,
        resetsAt: window.resetsAt ?? null,
        value: window.value ?? null,
        unit: window.unit ?? null,
      })),
    })),
  };
}

export default function fairyRingHost({ defineExtension, Mycelium, z }) {
  const read = (description, input, run) =>
    Mycelium.operation({
      replay: "safe",
      access: "read",
      description,
      input,
      execute: (args, context) => run(args, context.signal),
    });
  const missing = {
    available: false,
    reason: "Fairy Ring is not installed (install the fairy-ring CLI).",
  };
  return defineExtension({ id: "fairy-ring", version: "0.1.0" }).define({
    tools: () =>
      Mycelium.module({
        id: "fairy-ring",
        name: "fairy_ring",
        description:
          "Read-only view of Fairy Ring accounts and cached Fungi sign-in status. A saved Fungi Team is only the local selection, not fresh membership or billing; status does not validate access online. The tools cannot switch accounts.",
        operations: {
          status: read(
            "The active account or cached Fungi sign-in status, if any, per provider.",
            z.strictObject({}),
            async (_args, signal) => {
              const all = await cli(signal);
              if (all === undefined) return missing;
              return {
                available: true,
                providers: all.map(summarize).map((view) => ({
                  provider: view.provider,
                  name: view.name,
                  autoRotate: view.autoRotate,
                  threshold: view.threshold,
                  active:
                    view.accounts.find((account) => account.active) ??
                    view.observedActive,
                  cachedFungiStatus: view.cachedFungiStatus,
                  observationError: view.observationError,
                })),
              };
            },
          ),
          list: read(
            "Every registered account and cached usage, plus cached Fungi sign-in status where available; optionally filter by provider.",
            z.strictObject({ provider: z.string().max(32).optional() }),
            async ({ provider }, signal) => {
              const all = await cli(signal);
              if (all === undefined) return missing;
              return {
                available: true,
                providers: all
                  .filter(
                    (view) => provider === undefined || view.id === provider,
                  )
                  .map(summarize),
              };
            },
          ),
        },
      }),
  });
}
