import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createQueryClient } from "@fungi.computer/agar/query";
import { createWhistle } from "@fungi.computer/whistle";
import { basename } from "node:path";
import { createElement } from "react";
import { createLocalShippingSources } from "@fungi.computer/truffle/board-shipping";
import { loadThemePreference } from "../button/theme-preferences.js";
import { openTerminalApplication } from "../terminal-application.js";
import { BoardApp } from "./app.js";
import { createBoardController } from "./controller.js";
import { requestConversation } from "./request.js";

/**
 * `fungi board`: run the Board in this terminal until the person quits. Opened
 * from a pane, Enter on a row asks that pane's shell to open the conversation.
 */
export async function runBoardProgram(
  options: Readonly<{
    root: string;
    home: string;
    environment: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<void> {
  const application = await openTerminalApplication({
    signals: process,
    createQueryClient,
    createRenderer: createCliRenderer,
    createRoot,
    createWhistle,
    enableKeymap: false,
  });
  if (application === undefined) throw new Error("A terminal is required");
  // This program has no composer to hand early typing to; its keys are its own.
  application.inputHandoff?.pause();
  const preference = await loadThemePreference();
  const controller = createBoardController({
    root: options.root,
    shipping: createLocalShippingSources({
      cwd: options.root,
      home: options.home,
    }),
  });
  try {
    application.root.render(
      createElement(BoardApp, {
        controller,
        title: basename(options.root),
        theme: preference.theme,
        quit: application.exit,
        open: async (target) => {
          try {
            return (await requestConversation(options.environment, target)) ===
              "asked"
              ? undefined
              : "Open this from Open pane to open conversations here";
          } catch (cause) {
            return cause instanceof Error
              ? `Could not open it: ${cause.message}`
              : "Could not open it";
          }
        },
      }),
    );
    await new Promise<void>((resolve) => {
      application.signal.addEventListener("abort", () => {
        resolve();
      });
    });
  } finally {
    controller.close();
    await application.close();
  }
}
