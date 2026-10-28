import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createWhistle } from "@fungi.computer/whistle";
import { createWhistleInteractionHost } from "@fungi.computer/whistle/interaction";
import { createPrivateModels } from "@fungi.computer/truffle";
import { runLocalAuthCli } from "@fungi.computer/truffle/auth";
import { localAccountOwner } from "@fungi.computer/truffle/login";
import { contributeAccountCommands } from "@fungi.computer/parakeet/headless";
import { loginAllowed } from "@fungi.computer/veil/model-credentials";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

/** A temp HOME whose Local credential file holds sign-ins for `providerIds`. */
async function signedInHome(providerIds: readonly string[]) {
  const home = await mkdtemp(join(tmpdir(), "fungi-logout-picker-"));
  homes.push(home);
  const directory = join(home, ".config", "fungi");
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700);
  const credentialPath = join(directory, "credentials.json");
  await writeFile(
    credentialPath,
    JSON.stringify(
      Object.fromEntries(
        providerIds.map((id) => [
          id,
          { type: "api_key", key: `fixture-${id}` },
        ]),
      ),
    ),
    { mode: 0o600 },
  );
  return credentialPath;
}

/** Open `/logout` against the Local owner reading that credential file. */
async function openLogout(credentialPath: string) {
  const models = createPrivateModels(credentialPath);
  const owner = localAccountOwner(
    {
      auth: (request, interaction) =>
        runLocalAuthCli([request.command], {
          models,
          interaction,
          output: new PassThrough(),
        }),
    },
    () => models.getProviders(),
  );
  const whistle = createWhistle();
  contributeAccountCommands(whistle, owner, {
    sourceId: "test",
    namespace: "account",
    host: "local",
    scope: "user",
    policy: { loginAllowed },
  });
  const choices: string[][] = [];
  const messages: string[] = [];
  whistle.present(({ title }) => {
    const host = createWhistleInteractionHost({ title });
    host.subscribe(() => {
      const snapshot = host.snapshot();
      if (
        snapshot.message !== undefined &&
        messages.at(-1) !== snapshot.message.message
      )
        messages.push(snapshot.message.message);
      const pending = snapshot.prompt;
      if (pending?.request.type !== "choice") return;
      choices.push(pending.request.options.map((option) => option.label));
      queueMicrotask(() => {
        host.cancel();
      });
    });
    return host.begin();
  });
  await whistle.execute(
    { namespace: "account", id: "logout" },
    { origin: "slash" },
  );
  return { choices, messages };
}

test("the sign-out picker lists only providers with a saved sign-in", async () => {
  const { choices } = await openLogout(
    await signedInHome(["openrouter", "anthropic"]),
  );
  expect(choices).toEqual([["Anthropic", "OpenRouter"]]);
});

test("with no saved sign-in, sign-out shows the notice instead of a picker", async () => {
  const { choices, messages } = await openLogout(await signedInHome([]));
  expect(choices).toEqual([]);
  expect(messages).toEqual([
    "No model provider is signed in. Use /login to add one.",
  ]);
});
