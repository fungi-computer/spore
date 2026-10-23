import type { PrivateLocalServiceConnection } from "@fungi.computer/truffle/service";

export type TuiSandboxStatus = Awaited<
  ReturnType<PrivateLocalServiceConnection["sandboxStatus"]>
>;
export type TuiSandboxSource = Readonly<{
  identity: string;
  read(signal: AbortSignal): Promise<TuiSandboxStatus>;
  takeUnavailableNotice(): boolean;
}>;

/** One TUI application's notice custody, independent of pane remounts. */
export function createSandboxNoticeClaims() {
  const shown = new Set<string>();
  return (agentId: string, sessionId: string): boolean => {
    const key = JSON.stringify([agentId, sessionId]);
    if (shown.has(key)) return false;
    shown.add(key);
    return true;
  };
}
