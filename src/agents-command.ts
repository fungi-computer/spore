import type { PrivateLocalServiceManager } from "@fungi.computer/truffle/service";
import { agentLabel } from "./agent-label.js";
import { displayText } from "./shell/display-text.js";

export const agentsCommandHelp = `Usage: fungi agents list [--archived] [-C dir]
       fungi agents archive <agent-id> [-C dir]
       fungi agents unarchive <agent-id> [-C dir]

List this folder's Agents with their ids, or archive one to tidy up. An archived
Agent leaves fungi, the Agent picker, agents.list and delegation, and cannot be
sent work; its conversations and files stay on disk. fungi agents list
--archived shows the archived Agents, and unarchive restores one everywhere.
Archiving is refused while the Agent has a running command; cancel it first.
`;

export type AgentsCommandInput = Readonly<{
  action: "list" | "archive" | "unarchive";
  agentId?: string | undefined;
  /** `list`: show the archived Agents instead of the ones in use. */
  archived: boolean;
  invocationRoot: string;
  manager: Pick<PrivateLocalServiceManager, "discover" | "archive">;
  stdout: Readonly<{ write: (text: string) => void }>;
}>;

/** `fungi agents`: any Agent of the folder may be listed, archived or restored. */
export async function runAgentsCommand(input: AgentsCommandInput) {
  const { action, agentId, archived, invocationRoot, manager, stdout } = input;
  if (action === "list") {
    const { agents } = await manager.discover(invocationRoot, { archived });
    if (agents.length === 0) {
      stdout.write(
        `No ${archived ? "archived " : ""}Agents in ${invocationRoot}.\n`,
      );
      return;
    }
    for (const agent of agents)
      stdout.write(
        `${agent.agentId}  ${displayText(agentLabel(agent, agents))}  ${String(agent.sessionCount)} conversation${agent.sessionCount === 1 ? "" : "s"}\n`,
      );
    return;
  }
  if (agentId === undefined) throw new Error(agentsCommandHelp);
  await manager.archive({
    invocationRoot,
    agentId,
    archived: action === "archive",
  });
  stdout.write(
    action === "archive"
      ? `Archived ${agentId}. Its conversations and files stay; fungi agents unarchive ${agentId} restores it.\n`
      : `Restored ${agentId}.\n`,
  );
}
