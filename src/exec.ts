import { spawn } from "node:child_process";

export type ExecOptions = {
  cwd: string;
};

export type ExecResult = {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number;
};

export class CommandNotFoundError extends Error {
  command: string;

  constructor(command: string) {
    super(`Command not found: ${command}`);
    this.command = command;
  }
}

export class ExecError extends Error {
  result: ExecResult;

  constructor(result: ExecResult) {
    super(`${result.command} exited with code ${result.exitCode}`);
    this.result = result;
  }
}

export function exec(command: string, args: string[], options: ExecOptions) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  return new Promise<ExecResult>((resolvePromise, reject) => {
    child.on("error", (error) => {
      if ("code" in error && error.code === "ENOENT") {
        reject(new CommandNotFoundError(command));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      const exitCode = code === null ? 1 : code;
      const result = {
        command,
        args,
        cwd: options.cwd,
        stdout,
        stderr,
        output: stdout + stderr,
        exitCode,
      };
      if (exitCode === 0) {
        resolvePromise(result);
        return;
      }
      reject(new ExecError(result));
    });
  });
}
