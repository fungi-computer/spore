import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { Writable } from "node:stream";
import { Cli, isCancel } from "@fungi.computer/lantern";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

const setupSchema = z.strictObject({
  version: z.literal(1),
  door: z.enum(["later", "subscription", "byok", "hosted"]),
});
const setupPath = () => join(homedir(), ".fungi/onboarding.json");

export async function hasOnboarding(path = setupPath()): Promise<boolean> {
  try {
    setupSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

export type OnboardingOptions = {
  interactive: boolean;
  yes: boolean;
  path?: string;
  write: (message: string) => void;
  login: (authType?: "oauth" | "api_key") => Promise<void>;
  signIn: (endpoint: string) => Promise<void>;
};

/** Return whether to open the ordinary first local Session. Cancel saves nothing. */
export async function runOnboarding(
  options: OnboardingOptions,
): Promise<boolean> {
  if (!options.interactive || options.yes) {
    options.write(
      "Welcome to fungi. Sign in to Fungi to use models.\nNext: fungi login · fungi doctor · fungi\n",
    );
    // A pipe must not silently accept or persist setup choices.
    if (!options.yes) return false;
    await saveSetup(options.path ?? setupPath(), "later");
    return false;
  }
  const cli = new Cli({
    brand: "fungi",
    interactive: options.interactive,
    columns: process.stdout.columns,
    output: new Writable({
      write(chunk: string | Uint8Array, _encoding, callback) {
        options.write(chunk.toString());
        callback();
      },
    }),
  });
  cli.welcome("Your ideas, growing.");
  const account = await cli.select({
    message: "Connect your Fungi Team?",
    options: [
      { value: "local", label: "Continue local-only" },
      { value: "signin", label: "Sign in through your Team MCP endpoint" },
    ],
  });
  if (isCancel(account)) return cancelled(cli);
  if (account === "signin") {
    const endpoint = await cli.text({
      message: "Team MCP URL (leave blank to skip)",
      defaultValue: "",
      validate(value) {
        if (!value) return;
        if (URL.canParse(value) && new URL(value).protocol === "https:") return;
        return "Enter an https:// Team MCP URL.";
      },
    });
    if (isCancel(endpoint)) return cancelled(cli);
    if (endpoint) await options.signIn(endpoint);
  }
  const door = await cli.select({
    message: "How will your agent reach a model?",
    options: [
      { value: "later", label: "Choose later" },
      { value: "subscription", label: "Use a provider subscription" },
      { value: "byok", label: "Bring a provider API key" },
      {
        value: "hosted",
        label: "Use Fungi hosted models",
        hint: "Your selected Team pays for models",
      },
    ],
  });
  if (isCancel(door)) return cancelled(cli);
  if (door === "subscription" || door === "byok")
    await options.login(door === "subscription" ? "oauth" : "api_key");
  if (door === "hosted") await options.login();
  const first = await cli.confirm({
    message: "Start your first local agent Session now?",
    initialValue: false,
  });
  if (isCancel(first)) return cancelled(cli);
  await saveSetup(options.path ?? setupPath(), door);
  cli.outro(
    "Ready to grow. Next: fungi · fungi login · fungi doctor · fungi --help",
  );
  return first;
}

function cancelled(cli: Cli): false {
  cli.cancel("Setup skipped. Run fungi again whenever you're ready.");
  return false;
}

async function saveSetup(
  path: string,
  door: z.infer<typeof setupSchema>["door"],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify({ version: 1, door }) + "\n", {
    mode: 0o600,
  });
}
