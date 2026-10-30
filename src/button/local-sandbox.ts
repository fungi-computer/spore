import type { PrivateLocalServiceConnection } from "@fungi.computer/truffle/service";

export type TuiSandboxStatus = Awaited<
  ReturnType<PrivateLocalServiceConnection["sandboxStatus"]>
>;
export type TuiSandboxSource = Readonly<{
  identity: string;
  read(signal: AbortSignal): Promise<TuiSandboxStatus>;
  setMode(mode: TuiSandboxStatus["mode"], signal: AbortSignal): Promise<void>;
  rules: Readonly<{
    list(signal: AbortSignal): Promise<readonly (readonly string[])[]>;
    remove(
      prefix: readonly string[],
      signal: AbortSignal,
    ): Promise<readonly (readonly string[])[]>;
  }>;
}>;
