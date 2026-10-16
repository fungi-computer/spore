import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePrivateLocalGitExclude,
  parseFungiMcpEndpoint,
} from "@fungi.computer/truffle";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

const savedConnection = z.strictObject({ endpoint: z.string() });

function connectionPath(projectRoot: string): string {
  return join(projectRoot, ".fungi", "team-mcp.json");
}

/** A project saves only its Team MCP address; Local owns login credentials. */
export async function readProjectMcpConnection(
  projectRoot: string,
): Promise<string | undefined> {
  let body: string;
  try {
    body = await readFile(connectionPath(projectRoot), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
  try {
    const { endpoint } = savedConnection.parse(JSON.parse(body));
    return parseFungiMcpEndpoint(endpoint).href;
  } catch {
    throw new Error(
      `Invalid saved Team MCP connection in ${connectionPath(projectRoot)}; run fungi mcp forget -C ${projectRoot} to remove it`,
    );
  }
}

export async function saveProjectMcpConnection(
  projectRoot: string,
  endpoint: string,
): Promise<string> {
  const canonical = parseFungiMcpEndpoint(endpoint).href;
  await ensurePrivateLocalGitExclude(projectRoot);
  await mkdir(join(projectRoot, ".fungi"), { recursive: true });
  await writeFileAtomic(
    connectionPath(projectRoot),
    `${JSON.stringify({ endpoint: canonical })}\n`,
    { mode: 0o600 },
  );
  return canonical;
}

export async function forgetProjectMcpConnection(
  projectRoot: string,
): Promise<void> {
  await rm(connectionPath(projectRoot), { force: true });
}
