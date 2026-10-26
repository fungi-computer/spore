import type { PrivateLocalServiceConnection } from "@fungi.computer/truffle/service";

export type TuiSandboxStatus = Awaited<
  ReturnType<PrivateLocalServiceConnection["sandboxStatus"]>
>;
export type TuiSandboxSource = Readonly<{
  identity: string;
  read(signal: AbortSignal): Promise<TuiSandboxStatus>;
}>;
