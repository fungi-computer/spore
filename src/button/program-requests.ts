import { constants, watch } from "node:fs";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { reportFailure } from "./log-event.js";

/** What an installed program may ask of the shell, as one JSON file. */
const programRequest = z.strictObject({
  /** Open a conversation beside the program's pane. */
  open: z.literal("conversation"),
  agentId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
});
/** A request file is tiny; anything larger is not one. */
const maximumRequestBytes = 4 * 1024;
/** Files taken from a request folder in one pass. */
const maximumPerPass = 16;

/**
 * The folder one program pane's program writes requests into, and the shell
 * reads. The folder lives in the extension's 0700 runtime directory, so only
 * the person's own processes can write it; a request names a conversation to
 * open and nothing else, and the shell opens it exactly as a row's Enter
 * would, through the registry's ordinary path.
 */
export type ProgramRequests = Readonly<{
  /** Where this pane's program writes its requests. */
  directory: string;
  /** Stop reading and remove the folder. */
  close: () => Promise<void>;
}>;

/** Serve one program pane's request folder until `close`. */
export async function serveProgramRequests(
  runtimeDirectory: string,
  openConversation: (
    target: Readonly<{ agentId: string; sessionId: string }>,
  ) => Promise<void>,
): Promise<ProgramRequests> {
  const directory = await mkdtemp(join(runtimeDirectory, "pane-"));
  let closed = false;
  // Closing can happen at any await, which flow analysis cannot see.
  const isClosed = () => closed;
  const wantsAnother = () => again;
  let passing = false;
  let again = false;
  async function pass(): Promise<void> {
    if (passing) {
      again = true;
      return;
    }
    passing = true;
    try {
      do {
        again = false;
        const names = (await readdir(directory))
          .filter((name) => name.endsWith(".json"))
          .slice(0, maximumPerPass);
        for (const name of names) {
          const path = join(directory, name);
          let text: string;
          try {
            // A request is a plain file: a link or a pipe is never followed or waited on.
            const handle = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              if (!(await handle.stat()).isFile())
                throw new Error("not a plain file");
              const bytes = Buffer.alloc(maximumRequestBytes + 1);
              const { bytesRead } = await handle.read(
                bytes,
                0,
                bytes.length,
                0,
              );
              if (bytesRead > maximumRequestBytes) throw new Error("too large");
              text = bytes.subarray(0, bytesRead).toString("utf8");
            } finally {
              await handle.close();
            }
          } catch (cause) {
            reportFailure("program-request-read", cause);
            await rm(path, { force: true });
            continue;
          }
          // The request is consumed before it is acted on, so it runs once.
          await rm(path, { force: true });
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (cause) {
            reportFailure("program-request-json", cause);
            continue;
          }
          const request = programRequest.safeParse(parsed);
          if (!request.success) {
            reportFailure("program-request-invalid", request.error);
            continue;
          }
          if (!isClosed())
            await openConversation({
              agentId: request.data.agentId,
              sessionId: request.data.sessionId,
            }).catch((cause: unknown) => {
              reportFailure("program-request-open", cause);
            });
        }
      } while (wantsAnother() && !isClosed());
    } finally {
      passing = false;
    }
  }
  const watcher = watch(directory, () => {
    void pass().catch((cause: unknown) => {
      reportFailure("program-request-pass", cause);
    });
  });
  return {
    directory,
    close: async () => {
      closed = true;
      watcher.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
