import type { PrivateLocalRuntimeHostOptions } from "@fungi.computer/truffle";
import {
  createPrivateLocalServiceManager,
  type PrivateLocalServiceConnection,
  type PrivateLocalServiceManager,
} from "@fungi.computer/truffle/service";
import type { TuiCliDependencies } from "./cli-runtime.js";
import { runOneShot, type OneShotRunOptions } from "./one-shot-run.js";
import { asCliFailure, combinedCliFailure } from "./cli-failure.js";

export type OneShotCliOptions = Readonly<{
  invocationRoot: string;
  databasePath?: string | undefined;
  requireSandbox?: boolean | undefined;
  /** Agent id from `--agent`; resolved to its saved store through discovery. */
  agentId?: string | undefined;
  fungiMcp?: Parameters<PrivateLocalServiceManager["connect"]>[0]["fungiMcp"];
  providerId?: string | undefined;
  modelId?: string | undefined;
  reasoning?: PrivateLocalRuntimeHostOptions["reasoning"];
  prompt?: string | undefined;
  stdin?: OneShotRunOptions["stdin"];
  stdout?: OneShotRunOptions["stdout"];
  signals?: OneShotRunOptions["signals"];
  requestId?: string;
  connect?: string | undefined;
}>;

/** The saved store of the folder's Agent named by `--agent`. */
async function agentDatabasePath(
  manager: PrivateLocalServiceManager,
  invocationRoot: string,
  agentId: string,
  signal: AbortSignal,
) {
  const { agents } = await manager.discover(invocationRoot, { signal });
  const agent = agents.find((candidate) => candidate.agentId === agentId);
  if (agent === undefined)
    throw new Error(
      agents.length === 0
        ? `No Agent ${agentId} in this folder; it has no saved Agents`
        : `No Agent ${agentId} in this folder; choose one of ${agents.map((candidate) => candidate.agentId).join(", ")}`,
    );
  return agent.databasePath;
}

/** Open one private local Session, run one prompt, then close this client. */
export async function runOneShotCli(
  options: OneShotCliOptions,
  overrides: Partial<TuiCliDependencies> = {},
): Promise<void> {
  const dependencies = {
    createServiceManager: () => createPrivateLocalServiceManager(),
    runOneShot,
    ...overrides,
  };
  let host: PrivateLocalServiceConnection | undefined;
  let initiating: Error | undefined;
  const connectAbort = new AbortController();
  const onConnectSignal = () => {
    connectAbort.abort();
  };
  try {
    if (options.connect === undefined) {
      if (
        options.providerId !== undefined ||
        options.modelId !== undefined ||
        options.reasoning !== undefined
      )
        throw new Error(
          "Session model selection requires the shared Local preference contract",
        );
      const manager = dependencies.createServiceManager();
      const signals = options.signals ?? process;
      signals.on("SIGINT", onConnectSignal);
      signals.on("SIGTERM", onConnectSignal);
      try {
        const databasePath =
          options.agentId === undefined
            ? options.databasePath
            : await agentDatabasePath(
                manager,
                options.invocationRoot,
                options.agentId,
                connectAbort.signal,
              );
        const selection: Parameters<PrivateLocalServiceManager["connect"]>[0] =
          databasePath === undefined
            ? {
                invocationRoot: options.invocationRoot,
                requireSandbox: options.requireSandbox,
                fungiMcp: options.fungiMcp,
              }
            : {
                invocationRoot: options.invocationRoot,
                databasePath,
                requireSandbox: options.requireSandbox,
                fungiMcp: options.fungiMcp,
              };
        host = await manager.connect(selection, {
          signal: connectAbort.signal,
        });
      } finally {
        signals.off("SIGINT", onConnectSignal);
        signals.off("SIGTERM", onConnectSignal);
      }
      if (connectAbort.signal.aborted) throw new Error("fungi run cancelled");
    } else {
      throw new Error(
        "--connect is unavailable; fungi uses the persistent Local service",
      );
    }
    const activeHost = host;
    await dependencies.runOneShot(activeHost.session, {
      prompt: options.prompt,
      stdin: options.stdin,
      stdout: options.stdout,
      signals: options.signals,
      requestId: options.requestId,
      abortOnSignal: true,
    });
  } catch (cause) {
    initiating = asCliFailure(cause, "Local one-shot run failed");
  }
  const cleanupFailures: Error[] = [];
  try {
    await host?.close();
  } catch (cause) {
    cleanupFailures.push(asCliFailure(cause, "Local TUI host close failed"));
  }
  if (initiating !== undefined || cleanupFailures.length > 0)
    throw combinedCliFailure(initiating, cleanupFailures);
}
