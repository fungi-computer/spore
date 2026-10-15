import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type CliRenderer,
  type ClipboardService,
} from "@opentui/core";

export type CopyResult = "copied" | "sent" | "failed";

/** tmux's DCS wrapper lets a nested tmux forward OSC 52 to the outer terminal. */
export function tmuxClipboardPassthrough(text: string): string {
  const osc52 = `\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`;
  return `\u001bPtmux;\u001b${osc52}\u001b\\`;
}

export async function copyWithService(
  service: Pick<ClipboardService, "writeText">,
  text: string,
  tmux: string | undefined,
  writeTerminal: (text: string) => void,
): Promise<CopyResult> {
  // Kitty placeholders are display cells, not clipboard content.
  text = text.replace(/\u{10eeee}\u0305[\u0305\u030d]/gu, "");
  const result = await service.writeText(text, {
    destination: "all-available",
  });
  const usedTmux = tmux !== undefined && tmux.length > 0;
  if (usedTmux) writeTerminal(tmuxClipboardPassthrough(text));
  if (result.host.status === "written") return "copied";
  return usedTmux || result.terminal.status === "attempted" ? "sent" : "failed";
}

/** Use OpenTUI's bounded terminal and native host clipboard backends. */
export function createSelectionCopy(
  renderer: CliRenderer,
  options: Readonly<{
    service?: ClipboardService;
    tmux?: string | undefined;
    writeTerminal?: (text: string) => void;
  }> = {},
) {
  const service =
    options.service ??
    createClipboard({
      host: createHostClipboard(),
      terminal: createRendererClipboardAdapter(renderer),
    });
  const tmux = options.tmux ?? process.env.TMUX;
  const writeTerminal =
    options.writeTerminal ?? ((text: string) => process.stdout.write(text));
  return {
    async copy(text: string): Promise<CopyResult> {
      return copyWithService(service, text, tmux, writeTerminal);
    },
    dispose: () => service.dispose(),
  };
}
