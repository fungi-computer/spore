import { access } from "node:fs/promises";

export function isMissingFileError(cause) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

export async function expectFileAccess(path, mode, message) {
  try {
    await access(path, mode);
  } catch (cause) {
    if (isMissingFileError(cause)) throw new Error(message, { cause });
    throw cause;
  }
}
