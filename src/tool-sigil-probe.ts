/**
 * Observe complete sequences from OpenTUI's input parser. Its native startup
 * query uses image 31337; support must arrive before its DA1 barrier. The
 * observer never consumes input, so OpenTUI retains capability ownership.
 */
export function createToolSigilProbe(timeoutMs = 300) {
  const reply = Promise.withResolvers<boolean>();
  let settled = false;
  const finish = (supported: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reply.resolve(supported);
  };
  const timeout = setTimeout(() => {
    finish(false);
  }, timeoutMs);
  return {
    result: reply.promise,
    observe: (sequence: string): boolean => {
      if (sequence === "\u001b_Gi=31337;OK\u001b\\") finish(true);
      else if (sequence.startsWith("\u001b[?") && sequence.endsWith("c"))
        finish(false);
      return false;
    },
    close: () => {
      finish(false);
    },
  };
}
