import type { PrivateLocalAgentChoice } from "@fungi.computer/truffle/service";

/** "fixer, made by Shiitake"; an Agent a human made has no suffix. */
export function agentLabel(
  agent: PrivateLocalAgentChoice,
  agents: readonly PrivateLocalAgentChoice[],
) {
  if (agent.unreadable !== undefined)
    return `${agent.agentId} (unreadable: ${agent.unreadable})`;
  const name = agent.name ?? agent.agentId;
  if (agent.createdBy === undefined || agent.createdBy === null) return name;
  const creator = agents.find(
    (candidate) => candidate.agentId === agent.createdBy,
  );
  return `${name}, made by ${creator?.name ?? agent.createdBy}`;
}
