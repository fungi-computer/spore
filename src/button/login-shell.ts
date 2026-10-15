import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";

const unusable = new Set(["ENOENT", "ENOTDIR", "EACCES", "ELOOP"]);

/** Absent or not ours to run means "use the next shell"; other faults surface. */
function refused(cause: unknown): false {
  if (
    cause instanceof Error &&
    "code" in cause &&
    unusable.has(String(cause.code))
  )
    return false;
  throw cause;
}

/** An absolute path to an existing executable file, or nothing. */
async function executable(path: string | null | undefined) {
  if (path === undefined || path === null || !isAbsolute(path))
    return undefined;
  const file = await stat(path).then((entry) => entry.isFile(), refused);
  if (!file) return undefined;
  const runnable = await access(path, constants.X_OK).then(() => true, refused);
  return runnable ? path : undefined;
}

/**
 * The person's login shell: $SHELL, else their passwd entry (getpwuid
 * through Node's userInfo), else /bin/sh. Each must be an absolute path to an
 * existing executable.
 */
export async function loginShell(
  sources: Readonly<{
    shell?: string | undefined;
    passwd?: (() => string | null) | undefined;
  }> = {},
): Promise<string> {
  const passwd = sources.passwd ?? (() => userInfo().shell);
  return (
    (await executable(sources.shell)) ??
    (await executable(passwd())) ??
    "/bin/sh"
  );
}
