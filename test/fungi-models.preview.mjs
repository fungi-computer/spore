// Served proof: real browser PKCE, Local SQLite, native OpenTUI and hosted inference.
// Run with Bun after building Local/TUI and deploying the named Preview revision.
// bun apps/tui/test/fungi-models.preview.mjs --pr 17 --revision <40-hex-sha>
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import process from "node:process";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = parseArgs({
  options: { pr: { type: "string" }, revision: { type: "string" } },
}).values;
const deployment = (name) =>
  import(pathToFileURL(resolve(root, "tooling/deployment", name)).href);
const deploymentRequire = createRequire(
  resolve(root, "tooling/deployment/package.json"),
);
const { chromium } = await import(
  pathToFileURL(deploymentRequire.resolve("playwright")).href
);
const { z } = await import(
  pathToFileURL(deploymentRequire.resolve("zod")).href
);
const { accessHeaders, operatorSession } = await deployment("pr-operator.mjs");
const { readEmailCode } = await deployment("email-code-test.mjs");
const { prResources, parsePrNumber } = await deployment("pr-resources.mjs");
const { cloudflareApi } = await deployment("pr-cloudflare.mjs");
import {
  createPrivateModels,
  createPrivateCredentialStore,
  signInFungiAccount,
  readFungiAccountStatus,
  openPrivateLocalRuntimeHost,
} from "@fungi.computer/local";
import { runFungiCli } from "@fungi.computer/tui/cli";
import { TuiFrame } from "@fungi.computer/tui/frame";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { testRender } from "@opentui/react/test-utils";
import { createElement, act } from "react";
import { createWhistle } from "@fungi.computer/whistle";
import { pressDecodedKey } from "./native-readiness.js";
const number = parsePrNumber(args.pr);
const revision = z
  .string()
  .regex(/^[a-f0-9]{40}$/u)
  .parse(args.revision);
if (number === 1) throw new Error("pr-1 is reserved for the CTO");
const resources = prResources(number);
const origin = resources.hubOrigin;
const directory =
  process.env.BOTANICAL_CREDENTIAL_DIR ??
  "/home/levi/src/Botanical-next/.botanical/credentials";
const access = accessHeaders(directory);
const originalFetch = globalThis.fetch;
const completionRequests = [];
const realFetch = (input, init) => {
  const request = new globalThis.Request(input, init);
  if (new URL(request.url).pathname.endsWith("/chat/completions"))
    completionRequests.push(request.url);
  if (new URL(request.url).origin === origin)
    for (const [name, value] of Object.entries(access))
      request.headers.set(name, value);
  return originalFetch(request);
};
const startedAt = Date.now();
const suffix = `${startedAt}-${randomBytes(4).toString("hex")}`;
const fixtureRoot = await mkdtemp(join(tmpdir(), "fungi-models-preview-"));
const credentialPath = join(fixtureRoot, "credentials.json");
const outputDirectory = resolve(root, ".botanical/fungi-models");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const receiptPath = join(outputDirectory, `preview-${startedAt}.json`);
const receipt = {
  origin,
  revision,
  model: "@fungi/luna",
  startedAt,
  steps: [],
};
let phase = "operator";
let browser;
let context;
let host;
let setup;
let queryClient;
let commands;
let browserTask = Promise.resolve();
let clientId;
let browserFailure;
const loginController = new globalThis.AbortController();
async function waitForFrame(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
    await pause(50);
  }
  await writeFile(
    join(outputDirectory, "preview-frame-failure.private.txt"),
    setup.captureCharFrame(),
    { mode: 0o600 },
  );
  throw new Error(`Native frame deadline: ${label}`);
}
const step = (name) => {
  receipt.steps.push({ name, status: "pass" });
  process.stdout.write(`PASS ${name}\n`);
};
function status(response, expected) {
  assert.equal(response.status(), expected, `HTTP status during ${phase}`);
}
try {
  const operator =
    process.env.BOTANICAL_HUB_SESSION_COOKIE === undefined
      ? await operatorSession({ directory, origin, headers: access })
      : {
          cookie: z
            .string()
            .min(1)
            .parse(process.env.BOTANICAL_HUB_SESSION_COOKIE),
        };
  const minted = await realFetch(`${origin}/operator/invites`, {
    method: "POST",
    redirect: "error",
    headers: {
      cookie: operator.cookie,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      count: 1,
      amountUsd: "25",
      maxUses: 1,
      expiresInDays: 1,
    }),
  });
  assert.equal(minted.status, 201);
  const invite = z
    .object({ codes: z.array(z.object({ code: z.string().min(1) })).length(1) })
    .parse(await minted.json()).codes[0].code;
  phase = "email-code signup";
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.route("**/*", (route) => {
    const request = route.request();
    const headers = { ...request.headers() };
    if (new URL(request.url()).origin === origin)
      Object.assign(headers, access);
    return route.continue({ headers });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(`${origin}/?mode=signup`, { waitUntil: "domcontentloaded" });
  const email = `models-preview-${suffix}@example.com`;
  const form = page.getByRole("form", { name: "Create account with email" });
  await form.getByLabel("Name").fill("Fungi models proof");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Invite code", { exact: true }).fill(invite);
  await form
    .getByRole("checkbox", { name: /accept the current Terms of Service/iu })
    .check();
  const issued = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/auth/email-otp/send-verification-otp",
  );
  await form.getByRole("button", { name: "Send code", exact: true }).click();
  status(await issued, 200);
  await form.getByLabel(/^Code/).waitFor();
  const otp = await readEmailCode({
    origin,
    directory,
    email,
    headers: access,
  });
  await form.getByLabel(/^Code/).fill(otp);
  await form
    .getByRole("button", { name: "Continue with code", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Choose your personal Team" })
    .waitFor();
  step("real email-code signup");
  phase = "funded Team";
  await page.getByLabel("Name").fill("Fungi models proof");
  await page.getByLabel("Handle").fill(`models-${suffix}`);
  const createdPromise = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/teams" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Team", exact: true }).click();
  const created = await createdPromise;
  assert.ok(created.ok());
  const teamId = z
    .object({
      kind: z.literal("accepted"),
      team: z.object({ teamId: z.string().min(1) }),
    })
    .parse(await created.json()).team.teamId;
  const request = async (path, method = "GET", data) =>
    context.request.fetch(`${origin}${path}`, {
      method,
      data,
      headers: { ...access, origin },
      maxRedirects: 0,
    });
  const accountResponse = await request("/api/account");
  status(accountResponse, 200);
  const userId = z
    .object({ actor: z.object({ userId: z.string().min(1) }) })
    .parse(await accountResponse.json()).actor.userId;
  step("funded Team created through UI");
  phase = "CLI OAuth";
  globalThis.fetch = realFetch;
  let cliOutput = "";
  const openBrowser = (url) => {
    browserTask = browserTask.then(async () => {
      const tab = await context.newPage();
      await tab.goto(url.href, { waitUntil: "domcontentloaded" });
      if (url.pathname === "/oauth/local-client") {
        await tab
          .getByRole("button", { name: "Continue to Local", exact: true })
          .click();
        await tab.waitForURL((current) => current.hostname === "127.0.0.1", {
          waitUntil: "domcontentloaded",
        });
      } else {
        await tab
          .getByRole("heading", { name: "Authorize Fungi access" })
          .waitFor();
        assert.ok(
          (await tab.locator("body").innerText()).includes(
            "Use your Teams' Fungi models",
          ),
        );
        const callback = tab.waitForRequest((r) => {
          const target = new URL(r.url());
          return (
            target.hostname === "127.0.0.1" &&
            target.pathname === "/oauth/callback"
          );
        });
        const responsePromise = tab.waitForResponse(
          (r) => new URL(r.url()).pathname === "/api/auth/oauth2/consent",
        );
        await tab.getByRole("button", { name: "Allow", exact: true }).click();
        const response = await responsePromise;
        status(response, 200);
        await callback;
      }
    });
    // Retain the browser failure for the joined login outcome below.
    browserTask = browserTask.catch(async (cause) => {
      process.stderr.write(
        `FAIL OAuth browser (${cause instanceof Error ? cause.name : "Unknown"}); diagnostic retained privately\n`,
      );
      await writeFile(
        join(outputDirectory, "preview-browser-failure.log"),
        cause instanceof Error ? cause.stack : "Unknown browser failure",
        { mode: 0o600 },
      );
      browserFailure = cause;
      loginController.abort(cause);
    });
  };
  const login = runFungiCli(
    ["login", "--provider", "fungi", "--hub", origin],
    {
      stdout: {
        write: (value) => {
          cliOutput += value;
        },
      },
    },
    {
      signInFungi: (endpoint, options) =>
        signInFungiAccount(endpoint, {
          ...options,
          credentialPath,
          openBrowser,
          fetch: realFetch,
          signal: globalThis.AbortSignal.any([
            loginController.signal,
            globalThis.AbortSignal.timeout(90000),
          ]),
        }),
    },
  );
  // Wait for each browser task to be enqueued without losing browser failures.
  let loginDone = false;
  const loginOutcome = login
    .then(
      () => ({ kind: "completed" }),
      (cause) => ({ kind: "failed", cause }),
    )
    .finally(() => {
      loginDone = true;
    });
  while (!loginDone) {
    await browserTask;
    await pause(100);
  }
  const outcome = await loginOutcome;
  if (outcome.kind === "failed") {
    if (browserFailure !== undefined)
      throw new AggregateError(
        [outcome.cause, browserFailure],
        "CLI login and browser callback failed",
      );
    throw outcome.cause;
  }
  if (browserFailure !== undefined) throw browserFailure;
  assert.match(cliOutput, /Fungi login complete/u);
  const signedIn = await readFungiAccountStatus({ credentialPath });
  assert.equal(signedIn?.team?.teamId, teamId);
  const credential = z
    .object({ clientId: z.string().min(1) })
    .parse(await createPrivateCredentialStore(credentialPath).read("fungi"));
  clientId = credential.clientId;
  step("CLI PKCE, browser consent and selected paying Team");
  phase = "Local native terminal";
  const models = createPrivateModels(credentialPath);
  host = await openPrivateLocalRuntimeHost(
    { invocationRoot: fixtureRoot, modelId: "@fungi/luna" },
    models,
  );
  const sessionId = await host.createSession(`preview-${suffix}`);
  const session = host.getSession(sessionId);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  commands = createWhistle();
  setup = await testRender(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TuiFrame, {
        commands,
        session,
        initialTheme: "terminal",
        modelSource: {
          identity: host.databasePath,
          models: async () =>
            models.getModels("fungi").map((m) => ({
              providerId: m.provider,
              providerName: "Fungi",
              id: m.id,
              name: m.name,
              reasoning: [],
            })),
          effectiveModel: (signal) => host.effectiveModel(sessionId, signal),
          modelPreference: session.modelPreference,
        },
      }),
    ),
    { width: 120, height: 32 },
  );
  await waitForFrame((frame) => frame.includes("· Fungi"), "Fungi footer");
  receipt.footer = setup
    .captureCharFrame()
    .split("\n")
    .find((line) => line.includes("· Fungi"))
    ?.trim();
  step("native terminal footer · Fungi");
  phase = "real inference";
  await act(async () => setup.mockInput.typeText("Reply with exactly OK"));
  await pressDecodedKey(setup, () => setup.mockInput.pressEnter());
  const deadline = Date.now() + 120000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await session.read();
    if (snapshot.terminals.length > 0) break;
    await pause(200);
  }
  await writeFile(
    join(outputDirectory, `preview-session-${startedAt}.private.json`),
    JSON.stringify(snapshot, null, 2),
    { mode: 0o600 },
  );
  assert.equal(snapshot?.terminals.length, 1, "one completed terminal");
  assert.equal(snapshot.terminals[0].outcome, "completed");
  const assistant = snapshot.messages.filter(
    (m) => m.value.role === "assistant",
  );
  const text = assistant
    .flatMap((m) => m.value.content)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
  assert.equal(text, "OK");
  await waitForFrame(
    (frame) => /(?:^|\n)\s*OK\s*(?:\n|$)/u.test(frame),
    "native OK reply",
  );
  receipt.reply = text;
  step("native composer → Local → Preview @fungi/luna → OK");
  phase = "Billing usage";
  const cf = z
    .object({
      CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
      CLOUDFLARE_API_TOKEN: z.string().min(1),
    })
    .parse(parseEnv(await readFile(join(directory, "cloudflare.env"), "utf8")));
  const call = cloudflareApi({
    accountId: cf.CLOUDFLARE_ACCOUNT_ID,
    token: cf.CLOUDFLARE_API_TOKEN,
  });
  const databases = z
    .array(z.object({ name: z.string(), uuid: z.string() }))
    .parse(await call("GET", "/d1/database?per_page=100"));
  const database = databases.find((d) => d.name === resources.teamDatabase);
  assert.ok(database);
  const rows = z
    .array(
      z.object({
        results: z.array(
          z.object({
            status: z.string(),
            actorKind: z.string(),
            actorId: z.string(),
            modelId: z.string(),
            measuredCoefficient: z.number().nullable(),
          }),
        ),
      }),
    )
    .parse(
      await call("POST", `/d1/database/${database.uuid}/query`, {
        sql: "SELECT status, actor_kind AS actorKind, actor_id AS actorId, model_id AS modelId, measured_coefficient AS measuredCoefficient FROM billing_usage_executions WHERE account_id = ? AND model_id = ? AND created_at >= ? LIMIT 2",
        params: [teamId, "@fungi/luna", startedAt],
      }),
    )
    .flatMap((r) => r.results);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "settled");
  assert.equal(rows[0].actorKind, "user");
  assert.equal(rows[0].actorId, userId);
  assert.ok(rows[0].measuredCoefficient > 0);
  receipt.billing = {
    status: rows[0].status,
    actorKind: rows[0].actorKind,
    model: rows[0].modelId,
    measuredCoefficient: rows[0].measuredCoefficient,
  };
  step("one settled Billing usage row for the member and paying Team");
  phase = "remote revocation";
  status(
    await request("/api/account/oauth-clients/revoke", "POST", { clientId }),
    200,
  );
  const model = models.getModel("fungi", "@fungi/luna");
  assert.ok(model);
  const revoked = await models.completeSimple(model, {
    messages: [
      { role: "user", content: "Reply with exactly OK", timestamp: Date.now() },
    ],
  });
  assert.equal(revoked.stopReason, "error");
  assert.match(revoked.errorMessage, /Sign in to Fungi again/u);
  receipt.revocation = "Sign in to Fungi again";
  assert.deepEqual(
    completionRequests,
    [1, 2].map(
      () =>
        `${origin}/api/v1/teams/${encodeURIComponent(teamId)}/chat/completions`,
    ),
  );
  const afterRevoke = z
    .array(z.object({ results: z.array(z.object({ count: z.number() })) }))
    .parse(
      await call("POST", `/d1/database/${database.uuid}/query`, {
        sql: "SELECT COUNT(*) AS count FROM billing_usage_executions WHERE account_id = ? AND created_at >= ?",
        params: [teamId, startedAt],
      }),
    );
  assert.equal(
    afterRevoke[0].results[0].count,
    1,
    "revoked attempt creates no usage execution",
  );
  step(
    "revoked grant refuses cached Local credential with Sign in to Fungi again",
  );
  phase = "native revoked transcript";
  await act(async () => setup.mockInput.typeText("Reply with exactly OK"));
  await pressDecodedKey(setup, () => setup.mockInput.pressEnter());
  await waitForFrame(
    (frame) => frame.includes("Sign in to Fungi again"),
    "revoked credential refusal",
  );
  step("native terminal shows Sign in to Fungi again after revocation");
  receipt.status = "pass";
} catch (cause) {
  receipt.status = "fail";
  receipt.failedPhase = phase;
  receipt.errorClass = cause instanceof Error ? cause.name : "Unknown";
  process.stderr.write(
    `FAIL ${phase} (${cause instanceof Error ? cause.name : "Unknown"}); provider, auth and HTTP bodies withheld\n`,
  );
  // Private diagnostics are retained for diagnosis, never sent to stdout.
  await writeFile(
    resolve(root, ".botanical/fungi-models/preview-failure.log"),
    cause instanceof Error ? cause.stack : "Unknown failure",
    { mode: 0o600 },
  );
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  const cleanup = async (name, close) => {
    try {
      await close();
    } catch (cause) {
      receipt.status = "fail";
      receipt.steps.push({
        name: `cleanup ${name}`,
        status: "fail",
        errorClass: cause instanceof Error ? cause.name : "Unknown",
      });
      process.stderr.write(
        `FAIL cleanup ${name}; diagnostic retained privately\n`,
      );
      await writeFile(
        resolve(root, `.botanical/fungi-models/preview-cleanup-${name}.log`),
        cause instanceof Error ? cause.stack : "Unknown cleanup failure",
        { mode: 0o600 },
      );
      process.exitCode = 1;
    }
  };
  if (clientId === undefined)
    await cleanup("credential-metadata", async () => {
      const current =
        await createPrivateCredentialStore(credentialPath).read("fungi");
      if (current !== undefined)
        clientId = z
          .looseObject({ clientId: z.string().min(1).optional() })
          .parse(current).clientId;
    });
  if (
    clientId !== undefined &&
    context !== undefined &&
    receipt.revocation === undefined
  )
    await cleanup("grant", async () => {
      status(
        await context.request.post(
          `${origin}/api/account/oauth-clients/revoke`,
          {
            data: { clientId },
            headers: { ...access, origin },
            maxRedirects: 0,
          },
        ),
        200,
      );
    });
  await cleanup("renderer", () => act(async () => setup?.renderer.destroy()));
  await cleanup("queries", () => queryClient?.clear());
  await cleanup("commands", () => commands?.close());
  await cleanup("host", () => host?.close());
  await cleanup("browser", () => browser?.close());
  await cleanup("credentials", () =>
    rm(fixtureRoot, { recursive: true, force: true }),
  );
  receipt.finishedAt = Date.now();
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
}
