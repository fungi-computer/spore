import { beforeAll, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { TerminalMarkdown } from "../src/button/terminal-markdown.js";
import { useTerminalTheme } from "../src/button/terminal-theme.js";

function Markdown({ content }: Readonly<{ content: string }>) {
  const presentation = useTerminalTheme("mocha");
  return (
    <TerminalMarkdown
      content={content}
      streaming
      presentation={presentation}
      foreground={presentation.colors.foreground}
    />
  );
}

// Owner: S7b: streamed render linear via OpenTUI 0.7.0.
// Runs in test:nightly; focus with
// pnpm --filter @fungi.computer/spore proof:streamed-render.
// Recorded in shared .botanical/lanes-next/KNOWN-REDS.md.
describe.each(["one paragraph", "many paragraphs"] as const)(
  "S7b: streamed native reply CPU (%s)",
  (paragraphs) => {
    let smallCpu: number;
    let largeCpu: number;
    // Keep setup, measurement and cleanup outside the expected-failure test:
    // a broken native harness must remain an ordinary failure, not a known red.
    beforeAll(async () => {
      let update: ((content: string) => void) | undefined;
      function Reply() {
        const [content, setContent] = useState("Warm up");
        update = setContent;
        return <Markdown content={content} />;
      }
      const setup = await testRender(<Reply />, { width: 100, height: 30 });
      const render = async (bytes: number) => {
        await act(async () => {
          update?.("");
          await setup.renderOnce();
        });
        const paragraph = "reply ".repeat(80);
        const unit =
          paragraphs === "one paragraph" ? paragraph : `${paragraph}\n\n`;
        const content = unit
          .repeat(Math.ceil(bytes / unit.length))
          .slice(0, bytes);
        const start = process.cpuUsage();
        // Count every parser → React → native update, not one finished render.
        for (let end = 8_192; end < bytes + 8_192; end += 8_192) {
          await act(async () => {
            update?.(content.slice(0, Math.min(end, bytes)));
            await setup.renderOnce();
          });
        }
        const cpu = process.cpuUsage(start);
        return cpu.user + cpu.system;
      };
      try {
        await render(500_000);
        expect(update).toBeDefined();
        const small: number[] = [];
        const large: number[] = [];
        for (let sample = 0; sample < 3; sample += 1) {
          small.push(await render(250_000));
          large.push(await render(500_000));
        }
        const median = (values: number[]) =>
          values.sort((a, b) => a - b)[1] ?? 0;
        smallCpu = median(small);
        largeCpu = median(large);
        expect(smallCpu).toBeGreaterThan(0);
        expect(largeCpu).toBeGreaterThan(0);
        console.log(
          `Streamed reply CPU (${paragraphs}): 250 KB=${String(smallCpu)}µs; 500 KB=${String(largeCpu)}µs; ratio=${String(largeCpu / smallCpu)}`,
        );
      } finally {
        act(() => {
          setup.renderer.destroy();
        });
      }
    }, 60_000);

    test.failing("S7b: cumulative 500 KB CPU is at most 2.4x 250 KB", () => {
      expect(largeCpu).toBeLessThanOrEqual(2.4 * smallCpu);
    });
  },
);
