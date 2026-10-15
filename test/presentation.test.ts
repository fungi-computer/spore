import { describe, expect, test } from "bun:test";

import { formatToolCode } from "../src/button/presentation.js";

describe("tool display formatting", () => {
  test("indents minified code for the terminal without changing string values", async () => {
    const source =
      'return await files.read({path:"/home/levi/src/Botanical-next/apps/tui/src/cli.tsx"});';
    const formatted = await formatToolCode(source, 42);
    expect(formatted).toEqual({
      status: "formatted",
      content:
        "return await files.read({\n  path: '/home/levi/src/Botanical-next/apps/tui/src/cli.tsx',\n});",
    });
    expect(source).not.toContain("\n");
  });

  test("keeps incomplete code and large source readable without formatting", async () => {
    const originalError = console.error;
    const reports: unknown[][] = [];
    console.error = (...values: unknown[]) => reports.push(values);
    try {
      expect(await formatToolCode("return await files.read({", 42)).toEqual({
        status: "original",
        content: "return await files.read({",
        reason: "format-unavailable",
      });
    } finally {
      console.error = originalError;
    }
    // Incomplete streamed code is expected; reporting it painted over the TUI.
    expect(reports).toEqual([]);
    const large = "// untouched\n".repeat(1000);
    expect(await formatToolCode(large, 42)).toEqual({
      status: "original",
      content: large,
      reason: "size-limit",
    });
  });

  test("formatter failure returns the source without writing outside the renderer", async () => {
    // This is valid model-authored code below the size ceiling. Prettier's
    // recursive printer exhausts its stack; it is not a SyntaxError.
    const source = `const value = ${"[".repeat(4000)}0${"]".repeat(4000)};`;
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalError = process.stderr.write.bind(process.stderr);
    const originalConsoleError = console.error;
    const writes: unknown[] = [];
    console.error = (...values) => {
      writes.push(values);
    };
    process.stdout.write = process.stderr.write = (chunk) => {
      writes.push(chunk);
      return true;
    };
    let result;
    try {
      result = await formatToolCode(source, 80);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalError;
      console.error = originalConsoleError;
    }
    expect(writes).toEqual([]);
    expect(result).toEqual({
      status: "original",
      content: source,
      reason: "format-unavailable",
    });
  });
});
