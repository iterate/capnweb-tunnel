import { spawn } from "node:child_process";

export type ExecOptions = {
  cwd: string;
  silent?: boolean;
  tty?: boolean;
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
  const spawnConfig = options.tty && process.stdin.isTTY ? pseudoTtyCommand(command, args) : { command, args };
  const child = spawn(spawnConfig.command, spawnConfig.args, {
    cwd: options.cwd,
    stdio: [options.tty ? "inherit" : "ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk;
    if (!options.silent) process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk;
    if (!options.silent) process.stderr.write(chunk);
  });

  return new Promise<ExecResult>((resolvePromise, reject) => {
    child.on("error", (error) => {
      if ("code" in error && error.code === "ENOENT") {
        reject(new CommandNotFoundError(spawnConfig.command));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      const exitCode = code === null ? 1 : code;
      const result = {
        command: spawnConfig.command,
        args: spawnConfig.args,
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

function pseudoTtyCommand(command: string, args: string[]) {
  if (process.platform === "win32") return { command, args };
  if (process.platform === "darwin" || process.platform === "freebsd") {
    return { command: "script", args: ["-q", "/dev/null", command, ...args] };
  }
  return {
    command: "script",
    args: ["-q", "-e", "-c", [command, ...args].map(shellQuote).join(" "), "/dev/null"],
  };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
