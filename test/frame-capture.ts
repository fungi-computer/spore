import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { testRender } from "@opentui/react/test-utils";

export type Setup = Awaited<ReturnType<typeof testRender>>;

/** Write one rendered test frame as ANSI, plain text and span JSON. */
export async function captureFrame(
  setup: Pick<Setup, "captureSpans" | "captureCharFrame">,
  output: string | undefined,
  name: string,
) {
  if (!output) return;
  const frame = setup.captureSpans();
  const ansi = frame.lines
    .map(
      (line) =>
        line.spans
          .map((span) => {
            const fg = span.fg.toInts().slice(0, 3).join(";");
            const bg = span.bg.toInts().slice(0, 3).join(";");
            return `\x1b[0;38;2;${fg};48;2;${bg}${span.attributes & 1 ? ";1" : ""}${span.attributes & 2 ? ";2" : ""}m${span.text}`;
          })
          .join("") + "\x1b[0m",
    )
    .join("\n");
  await writeFile(join(output, `${name}.ansi`), ansi);
  await writeFile(join(output, `${name}.txt`), setup.captureCharFrame());
  await writeFile(
    join(output, `${name}.json`),
    JSON.stringify({
      ...frame,
      lines: frame.lines.map((line) => ({
        spans: line.spans.map((span) => ({
          ...span,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
        })),
      })),
    }),
  );
}
