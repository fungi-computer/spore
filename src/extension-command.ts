import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocalExtensions } from "@fungi.computer/truffle/extensions";
import type { LocalProgram } from "./panes/terminal/index.js";

export const extensionCommandHelp = `Usage: fungi extension add <git-url | npm-spec | path> [--skills | --no-skills]
       fungi extension list
       fungi extension remove <id>
       fungi extension enable project <id>
       fungi extension enable agent <id> [<agent-store>]
       fungi extension enable skills <id> [<agent-store>]
       fungi extension disable project|agent|skills <id> [<agent-store>]

Install an extension once for your user, then enable its parts where you want
them. "project" adds its client part and programs to Open pane in this folder,
for whichever Agent you chat with. "agent" grants one Agent store the tools and
capabilities the extension declares; that Agent uses them from its next start.
Installed extensions are trusted code that runs as you. A Git source is pinned
to the commit it resolved; run add again to update.
An extension may ship skills. add lists them and asks whether to add them for
this folder's Agent (--skills says yes and --no-skills says no, without asking).
Skills are read in place from the installed extension, show as "from <id>", and
yours with the same name win. "disable agent" and "remove" take them away too.
`;

export type ExtensionCommandInput = Readonly<{
  action: "add" | "list" | "remove" | "enable" | "disable";
  arguments: readonly string[];
  cwd: string;
  stdout: Readonly<{ write: (text: string) => void }>;
  /** `add`: true or false answers the skills question without asking. */
  skills?: boolean | undefined;
  /** `add`: asks the skills question; absent when there is no terminal. */
  confirm?: ((question: string) => Promise<boolean>) | undefined;
}>;

/** The folder's one Agent store, or the store the person named. */
async function agentStore(cwd: string, named: string | undefined) {
  if (named !== undefined) return resolve(cwd, named);
  const stores = join(cwd, ".fungi", "agents");
  const entries = await readdir(stores, { withFileTypes: true }).catch(
    (cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return [];
      throw cause;
    },
  );
  const found = entries.filter((entry) => entry.isDirectory());
  const [only] = found;
  if (only === undefined || found.length !== 1)
    throw new Error(
      found.length === 0
        ? "This folder has no Agent yet; run fungi here first"
        : `This folder has ${String(found.length)} Agents; name one: ${found.map((entry) => join(".fungi", "agents", entry.name)).join(", ")}`,
    );
  return join(stores, only.name);
}

/** `fungi extension`: the install and activation owner's typed operations. */
export async function runExtensionCommand(
  input: ExtensionCommandInput,
  owner: LocalExtensions,
) {
  const { stdout } = input;
  const [first, second, third] = input.arguments;
  switch (input.action) {
    case "add": {
      const installed = await owner.add(first ?? "");
      stdout.write(
        `Installed ${installed.id} ${installed.version} (${installed.commit ?? installed.revision}).\n` +
          `Declares: ${installed.capabilities.join(", ") || "no Agent capabilities"}; programs: ${installed.terminals.join(", ") || "none"}.\n` +
          `Enable it with fungi extension enable project ${installed.id} or fungi extension enable agent ${installed.id}.\n`,
      );
      if (installed.skills.length === 0) return;
      const count = installed.skills.length;
      stdout.write(
        `Skills (${String(count)}): ${installed.skills.join(", ")}.\n`,
      );
      const question = `Add its ${String(count)} ${count === 1 ? "skill" : "skills"}?`;
      const accepted =
        input.skills ??
        (input.confirm === undefined
          ? undefined
          : await input.confirm(question));
      if (accepted === undefined) {
        stdout.write(
          `Not added: no terminal to ask. Run fungi extension enable skills ${installed.id} or re-run add with --skills.\n`,
        );
        return;
      }
      if (!accepted) {
        stdout.write(
          `Skills not added. Add them later with fungi extension enable skills ${installed.id}.\n`,
        );
        return;
      }
      const store = await agentStore(input.cwd, undefined).then(
        (found) => ({ found }),
        (cause: unknown) => ({
          missing: cause instanceof Error ? cause.message : String(cause),
        }),
      );
      if ("missing" in store) {
        stdout.write(
          `Skills not added: ${store.missing}. Then run fungi extension enable skills ${installed.id}.\n`,
        );
        return;
      }
      await owner.enableAgentSkills(store.found, installed.id);
      stdout.write(
        `Added ${String(count)} ${count === 1 ? "skill" : "skills"} for the Agent in ${store.found}. They apply when that Agent next starts.\n`,
      );
      return;
    }
    case "list": {
      const installed = await owner.list();
      if (installed.length === 0) stdout.write("No extensions installed.\n");
      for (const extension of installed)
        stdout.write(
          `${extension.id} ${extension.version} ${extension.commit ?? extension.revision} · ${extension.source}\n`,
        );
      return;
    }
    case "remove": {
      stdout.write(
        (await owner.remove(first ?? ""))
          ? `Removed ${first ?? ""} and its activations. Running programs and Agent runs finish unchanged.\n`
          : `${first ?? ""} is not installed.\n`,
      );
      return;
    }
    case "enable":
    case "disable": {
      if (second === undefined) throw new Error(extensionCommandHelp);
      if (first === "project") {
        if (input.action === "enable") {
          const revision = await owner.enableProject(input.cwd, second);
          stdout.write(
            `Enabled ${second} (${revision}) for ${input.cwd}. Restart fungi here to see its programs in Open pane.\n`,
          );
        } else
          stdout.write(
            (await owner.disableProject(input.cwd, second))
              ? `Disabled ${second} for ${input.cwd} from the next fungi start; open panes keep running.\n`
              : `${second} was not enabled for ${input.cwd}.\n`,
          );
        return;
      }
      if (first === "agent") {
        const store = await agentStore(input.cwd, third);
        if (input.action === "enable") {
          const granted = await owner.enableAgent(store, second);
          stdout.write(
            `Granted ${second} (${granted.revision}) ${granted.capabilities.join(", ")} for the Agent in ${store}. It applies when that Agent next starts; running work is not interrupted.\n`,
          );
        } else
          stdout.write(
            (await owner.disableAgent(store, second))
              ? `Withdrew ${second} from the Agent in ${store} from its next start; a running turn finishes unchanged.\n`
              : `${second} was not enabled for the Agent in ${store}.\n`,
          );
        return;
      }
      if (first === "skills") {
        const store = await agentStore(input.cwd, third);
        if (input.action === "enable") {
          const revision = await owner.enableAgentSkills(store, second);
          stdout.write(
            `Added the skills of ${second} (${revision}) for the Agent in ${store}. They apply when that Agent next starts.\n`,
          );
        } else
          stdout.write(
            (await owner.disableAgentSkills(store, second))
              ? `Removed the skills of ${second} from the Agent in ${store} from its next start.\n`
              : `The skills of ${second} were not added for the Agent in ${store}.\n`,
          );
        return;
      }
      throw new Error(extensionCommandHelp);
    }
  }
}

/** The project's enabled client entries and program pane kinds. */
export async function projectExtensionParts(
  owner: LocalExtensions,
  invocationRoot: string,
  report: (error: Error) => void,
): Promise<
  Readonly<{ clients: readonly string[]; programs: readonly LocalProgram[] }>
> {
  const parts = await owner.project(invocationRoot);
  for (const diagnostic of parts.diagnostics) report(diagnostic);
  return {
    clients: parts.clients,
    programs: parts.terminals.map((terminal) => ({
      kind: `extension:${terminal.extensionId}.${terminal.terminalId}`,
      name: terminal.name,
      description: terminal.description,
      command: terminal.command,
      cwd: terminal.cwd,
      env: terminal.env,
    })),
  };
}
