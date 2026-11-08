import process from "node:process";
import { spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { access } from "node:fs/promises";
import { limaInstall, type VmRunner } from "./vm-command.js";

/** The real runner: native commands share this terminal. */
export const nativeVmRunner: VmRunner = {
  run: (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: "inherit" });
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") resolve("missing");
        else reject(error);
      });
      child.once("exit", (code, signal) => {
        resolve(code ?? (signal === null ? 1 : 128));
      });
    }),
  runLogged: (command, args, log) =>
    new Promise((resolve, reject) => {
      const output = createWriteStream(log, { flags: "a" });
      output.once("open", () => {
        const child = spawn(command, [...args], {
          stdio: ["ignore", output, output],
        });
        child.once("error", (error: NodeJS.ErrnoException) => {
          output.end();
          if (error.code === "ENOENT") resolve("missing");
          else reject(error);
        });
        child.once("exit", (code, signal) => {
          output.end();
          resolve(code ?? (signal === null ? 1 : 128));
        });
      });
      output.once("error", reject);
    }),
  kvmUsable: () =>
    process.platform !== "linux"
      ? Promise.resolve(true)
      : access("/dev/kvm", constants.R_OK | constants.W_OK).then(
          () => true,
          () => false,
        ),
  capture: (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code !== "ENOENT"
            ? error
            : new Error(
                command === "limactl"
                  ? limaInstall
                  : `${command} is not installed`,
              ),
        );
      });
      child.once("exit", (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`${command} ${args.join(" ")} failed`));
      });
    }),
};
