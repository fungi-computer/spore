import type { LocalAuthCliOptions } from "@fungi.computer/truffle/auth";
import { Cli } from "@fungi.computer/lantern";
import { Writable } from "node:stream";
import process from "node:process";
import { z } from "zod";
import { reportFailure } from "./button/log-event.js";
import type { PrivateLocalServiceManager } from "@fungi.computer/truffle";

/** Report public account metadata and provider readiness without displaying credentials. */
export async function runDoctor(options: {
  models: NonNullable<LocalAuthCliOptions["models"]>;
  fungiAccount: () => ReturnType<
    typeof import("@fungi.computer/truffle").readFungiAccountStatus
  >;
  endpoint?: string | undefined;
  version: string;
  /** Read only: doctor must never start or restart the Local service. */
  localServiceStatus: PrivateLocalServiceManager["status"];
  interactive?: boolean;
  write: (message: string) => void;
  connect?: (url: string) => Promise<boolean>;
}): Promise<boolean> {
  let passed = true;
  const cli = new Cli({
    brand: "fungi",
    output: new Writable({
      write(chunk: string | Uint8Array, _encoding, callback) {
        options.write(chunk.toString());
        callback();
      },
    }),
    interactive: options.interactive ?? false,
  });
  const check = cli.checklist();
  const report = (label: string, ok: boolean, detail: string) => {
    if (!ok) passed = false;
    check(label, ok, detail);
  };
  // Setup the person has not done yet is not a failure: it is listed as SETUP
  // and does not fail the run.
  const unfinished: string[] = [];
  const setup = (label: string, detail: string) => {
    unfinished.push(label);
    options.write(`SETUP ${label}: ${detail}\n`);
  };
  options.write("fungi doctor\n");
  try {
    const service = await options.localServiceStatus();
    if (service === undefined) {
      setup(
        "Local service",
        "Not running yet. It starts the first time you run fungi.",
      );
    } else {
      const diagnostics = service.diagnostics;
      report(
        "Local diagnostics",
        diagnostics.state === "active",
        diagnostics.state === "active"
          ? "ACTIVE"
          : `FAILED ${diagnostics.code} since ${diagnostics.since}`,
      );
    }
  } catch (cause) {
    reportFailure("doctor-local-service-check", cause);
    report("Local service", false, "Could not read live service status");
  }
  const { header } = z
    .object({
      header: z.object({ glibcVersionRuntime: z.string().optional() }),
    })
    .parse(process.report.getReport());
  options.write(`Platform: ${process.platform} ${process.arch}\n`);
  options.write(
    `glibc: ${process.platform === "linux" ? (header.glibcVersionRuntime ?? "not detected") : "not applicable"}\n`,
  );
  try {
    const account = await options.fungiAccount();
    if (account === undefined)
      setup("Fungi sign-in", "Not signed in to Fungi. Optional.");
    else
      report(
        "sign-in",
        true,
        account.team !== undefined
          ? `Saved Fungi login · ${account.team.name}`
          : "Saved Fungi login; select a Team with fungi login --provider fungi",
      );
  } catch (cause) {
    reportFailure("doctor-team-auth-check", cause);
    report("sign-in", false, "Could not read saved login");
  }
  try {
    const account = await options.fungiAccount();
    const configured =
      account?.team !== undefined &&
      (await options.models.checkAuth("fungi")) !== undefined;
    if (configured) report("Fungi models", true, "selected Team ready");
    else if (account === undefined)
      setup("Fungi models", "Not set up. Optional.");
    else
      report(
        "Fungi models",
        false,
        "Sign in to Fungi with fungi login --provider fungi",
      );
  } catch (cause) {
    reportFailure("doctor-model-check", cause);
    report("Fungi models", false, "Could not check provider configuration");
  }
  const url =
    options.endpoint === undefined
      ? "https://fungi.computer"
      : new URL(options.endpoint).origin;
  try {
    const reachable = await (
      options.connect ??
      (async (address) => {
        const response = await fetch(address, {
          method: "HEAD",
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        return response.status < 500;
      })
    )(url);
    report(
      "connectivity",
      reachable,
      reachable
        ? "HTTP endpoint reachable"
        : "Endpoint unavailable. Check your network connection, then run fungi doctor.",
    );
  } catch (cause) {
    reportFailure("doctor-connectivity-check", cause);
    report(
      "connectivity",
      false,
      "Check your network connection, then run fungi doctor.",
    );
  }
  report("version", true, options.version + " (installed)");
  if (unfinished.length > 0)
    options.write(
      "Next: run fungi login to use your Claude or ChatGPT subscription, an API key or Fungi models, then run fungi.\n",
    );
  return passed;
}
