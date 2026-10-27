import type {
  WhistleContribution,
  WhistleInteraction,
} from "@fungi.computer/whistle";
import type { PrivateLocalServiceManager } from "@fungi.computer/truffle/service";
import type { LocalExtensions } from "@fungi.computer/truffle/extensions";
import { oneLine } from "@fungi.computer/parakeet/headless";
import {
  runExtensionCommand,
  type ExtensionCommandInput,
} from "./extension-command.js";

const agentName = (agent: Readonly<{ name?: string | undefined }>) =>
  agent.name ?? "Unnamed Agent";

const conversations = (count: number) =>
  `${String(count)} conversation${count === 1 ? "" : "s"}`;

/** Human command doors into the existing Local archive and extension owners. */
export function localManagementCommands(
  invocationRoot: string,
  manager: Pick<PrivateLocalServiceManager, "discover" | "archive">,
  extensions: () => LocalExtensions,
): WhistleContribution["commands"] {
  return [
    {
      id: "archive",
      title: "Archive an Agent",
      category: "Conversation",
      description:
        "Hide an Agent from this folder's lists; keep its conversations and files.",
      projections: {
        palette: {},
        help: {},
        slash: { aliases: ["archive"], consumesDraft: true },
      },
      handler: async ({ interaction }) => {
        if (interaction === undefined)
          throw new Error("Archiving an Agent needs a person.");
        const { agents } = await manager.discover(invocationRoot, {
          signal: interaction.signal,
        });
        if (agents.length === 0) {
          interaction.notify({
            type: "info",
            message: "No Agents to archive.",
          });
          return;
        }
        if (agents.length > 256)
          throw new Error(
            "Use fungi agents list, then fungi agents archive <agent-id>.",
          );
        const agentId = await interaction.prompt({
          type: "choice",
          message: "Archive which Agent?",
          summary: "Its conversations and files stay.",
          options: agents.map((agent) => ({
            value: agent.agentId,
            label: agentName(agent),
            description: conversations(agent.sessionCount),
          })),
        });
        const agent = agents.find((candidate) => candidate.agentId === agentId);
        if (agent === undefined) throw new Error("Choose a listed Agent.");
        const confirmed = await interaction.prompt({
          type: "confirmation",
          message: `Archive ${oneLine(agentName(agent), 40)}?`,
          summary:
            "Its conversations and files stay. You can restore it later.",
          facts: [
            {
              label: "Chats",
              value: String(agent.sessionCount),
            },
          ],
          details: [{ label: "Agent ID", value: agentId }],
          confirmLabel: "Archive",
          cancelLabel: "Keep Agent",
          destructive: true,
        });
        if (!confirmed) return { cancelled: true };
        await interaction.run(() =>
          manager.archive(
            { invocationRoot, agentId, archived: true },
            { signal: interaction.signal },
          ),
        );
        interaction.notify({
          type: "success",
          message: `Archived ${agentName(agent)}. Restore with fungi agents unarchive ${agentId}.`,
        });
        return undefined;
      },
    },
    {
      id: "extensions",
      title: "Manage extensions",
      category: "Settings",
      description:
        "List, add, remove, enable or disable installed extensions and skills.",
      projections: {
        palette: {},
        help: {},
        slash: { aliases: ["extensions"], consumesDraft: true },
      },
      handler: async ({ interaction }) => {
        if (interaction === undefined)
          throw new Error("Managing extensions needs a person.");
        await manageExtensions(invocationRoot, interaction, extensions);
      },
    },
  ];
}

/** Presentation only: the CLI command and Local owner keep all mutation policy. */
async function manageExtensions(
  cwd: string,
  interaction: WhistleInteraction,
  extensions: () => LocalExtensions,
) {
  const actions: readonly ExtensionCommandInput["action"][] = [
    "list",
    "add",
    "remove",
    "enable",
    "disable",
  ];
  const selected = await interaction.prompt({
    type: "choice",
    message: "Manage extensions",
    summary: "Extensions add tools, programs and skills to your Agents.",
    options: [
      { value: "list", label: "List installed extensions" },
      {
        value: "add",
        label: "Add an extension",
        description: "Install trusted code from Git, npm or a local path",
      },
      { value: "remove", label: "Remove an extension" },
      { value: "enable", label: "Enable an extension or its skills" },
      { value: "disable", label: "Disable an extension or its skills" },
    ],
  });
  const action = actions.find((candidate) => candidate === selected);
  if (action === undefined) throw new Error("Choose a listed action.");
  const installedOwner = extensions();
  // Retry owner operations, not the CLI flow: adding may already have
  // succeeded when a later skills activation fails.
  const owner: LocalExtensions = {
    ...installedOwner,
    add: (...args) => interaction.run(() => installedOwner.add(...args)),
    list: (...args) => interaction.run(() => installedOwner.list(...args)),
    remove: (...args) => interaction.run(() => installedOwner.remove(...args)),
    enableProject: (...args) =>
      interaction.run(() => installedOwner.enableProject(...args)),
    disableProject: (...args) =>
      interaction.run(() => installedOwner.disableProject(...args)),
    enableAgent: (...args) =>
      interaction.run(() => installedOwner.enableAgent(...args)),
    disableAgent: (...args) =>
      interaction.run(() => installedOwner.disableAgent(...args)),
    enableAgentSkills: (...args) =>
      interaction.run(() => installedOwner.enableAgentSkills(...args)),
    disableAgentSkills: (...args) =>
      interaction.run(() => installedOwner.disableAgentSkills(...args)),
  };
  const args: string[] = [];
  if (action === "add") {
    args.push(
      await interaction.prompt({
        type: "text",
        message: "Add an extension",
        summary: "Extensions run inside Fungi with access to every Agent.",
        placeholder: "Git URL, npm package or folder path",
      }),
    );
  } else if (action !== "list") {
    const installed = await owner.list();
    if (installed.length === 0) {
      interaction.notify({ type: "info", message: "No extensions installed." });
      return;
    }
    if (installed.length > 256)
      throw new Error(
        "Use fungi extension list to manage this many extensions.",
      );
    if (action === "enable" || action === "disable")
      args.push(
        await interaction.prompt({
          type: "choice",
          message:
            action === "enable" ? "Turn it on where?" : "Turn it off where?",
          options: [
            { value: "project", label: "This folder's client and programs" },
            { value: "agent", label: "This folder's Agent tools" },
            { value: "skills", label: "This folder's Agent skills" },
          ],
        }),
      );
    const id = await interaction.prompt({
      type: "choice",
      message:
        action === "remove" ? "Remove which extension?" : "Which extension?",
      options: installed.map((extension) => ({
        value: extension.id,
        label: extension.id,
        description: extension.version,
      })),
    });
    if (
      action === "remove" &&
      !(await interaction.prompt({
        type: "confirmation",
        message: `Remove ${oneLine(id, 40)}?`,
        summary: "It stops working in every folder where it was turned on.",
        details: [{ label: "Extension", value: id }],
        confirmLabel: "Remove",
        cancelLabel: "Keep extension",
        destructive: true,
      }))
    )
      return;
    args.push(id);
  }
  let output = "";
  await runExtensionCommand(
    {
      action,
      arguments: args,
      cwd,
      stdout: {
        write: (text) => {
          output += text;
        },
      },
      confirm: (message) =>
        interaction.prompt({
          type: "confirmation",
          message,
          confirmLabel: "Add skills",
          cancelLabel: "Skip",
        }),
    },
    owner,
  );
  // A listing is information; mutation receipts only echo the person's action.
  interaction.notify({
    type: action === "list" ? "info" : "success",
    message: output.trim(),
  });
}
