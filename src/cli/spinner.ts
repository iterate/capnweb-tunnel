import { color } from "./ansi.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type Spinner = {
  update(message: string): void;
  stop(success?: boolean): void;
};

export function startSpinner(initial: string): Spinner {
  if (!process.stdout.isTTY) {
    console.log(`  ${initial}...`);
    let label = initial;
    return {
      update: (message) => {
        label = message;
        console.log(`  ${message}`);
      },
      stop: (success = true) => {
        console.log(`  ${success ? "done" : "failed"}: ${label}`);
      },
    };
  }
  let label = initial;
  let frame = 0;
  const render = () => {
    process.stdout.write(
      `\r${color.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "")} ${label}\x1b[K`,
    );
    frame += 1;
  };
  render();
  const interval = setInterval(render, 80);
  return {
    update: (message) => {
      label = message;
      render();
    },
    stop: (success = true) => {
      clearInterval(interval);
      const mark = success ? color.green("✓") : color.red("✗");
      process.stdout.write(`\r${mark} ${label}\x1b[K\n`);
    },
  };
}

export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const spinner = startSpinner(message);
  try {
    const result = await fn();
    spinner.stop(true);
    return result;
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}
