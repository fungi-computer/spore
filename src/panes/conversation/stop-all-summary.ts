import type { StopAllResult, ToastInput } from "../../button/index.js";

/** One summary, never a notification per helper. Counts reflect confirmed stops. */
export function stopAllSummary(result: StopAllResult) {
  const root = result.agents.find(
    ({ agentId }) => agentId === result.rootAgentId,
  );
  const helpers = result.agents.filter(
    ({ agentId, outcome }) =>
      agentId !== result.rootAgentId && outcome === "stopped",
  ).length;
  const helperText = `${String(helpers)} helper${helpers === 1 ? "" : "s"}`;
  const stopped =
    root?.outcome === "stopped"
      ? `Stopped ${root.name}${helpers > 0 ? ` and ${helperText}` : ""}`
      : helpers > 0
        ? `Stopped ${helperText}${root?.outcome === "idle" ? `; ${root.name} already idle` : ""}`
        : "No running turns to stop";
  const failures = [
    ...result.agents.flatMap((agent) =>
      agent.outcome === "failed" ? [`${agent.name}: ${agent.reason}`] : [],
    ),
    ...result.discoveryFailures.map(
      ({ agentId, reason }) => `${agentId}: ${reason}`,
    ),
  ];
  return failures.length === 0
    ? ({ variant: "success", message: stopped } satisfies ToastInput)
    : ({
        variant: "warning",
        duration: "until-dismissed",
        message: `${stopped}. ${String(failures.length)} not confirmed: ${failures.join("; ")}`,
      } satisfies ToastInput);
}

/** A rejected request confirms no stop; keep that unresolved attention visible. */
export function stopAllFailure(cause: unknown) {
  return {
    variant: "warning",
    duration: "until-dismissed",
    message: `Stop-all unconfirmed: 1 request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  } satisfies ToastInput;
}
