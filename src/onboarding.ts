import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { Writable, type Readable } from "node:stream";
import { Cli } from "@fungi.computer/lantern";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { chooseSignInDoor, type SignInDoor } from "./sign-in-choice.js";

/** The stored door names predate the one-question setup; their meaning is fixed. */
const savedDoor = {
  later: "later",
  subscription: "subscription",
  api_key: "byok",
  fungi: "hosted",
} as const satisfies Record<SignInDoor | "later", string>;

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
  /** Terminal input; defaults to this process's stdin. */
  input?: Readable;
  write: (message: string) => void;
  /** Run the chosen sign-in on this same screen; the banner is already shown. */
  signIn: (door: SignInDoor, cli: Cli) => Promise<void>;
};

/** Return whether to open the first local Session. Cancel saves nothing. */
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
    input: options.input ?? process.stdin,
    output: new Writable({
      write(chunk: string | Uint8Array, _encoding, callback) {
        options.write(chunk.toString());
        callback();
      },
    }),
  });
  cli.welcome("Your ideas, growing.");
  const door = await chooseSignInDoor(cli, { allowSkip: true });
  if (door === undefined) return cancelled(cli);
  if (door !== "later") await options.signIn(door, cli);
  await saveSetup(options.path ?? setupPath(), savedDoor[door]);
  cli.outro("Ready to grow.");
  return true;
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
