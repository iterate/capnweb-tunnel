const enabled = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

function wrap(open: string, close: string) {
  return (value: string | number) => (enabled ? `${open}${value}${close}` : String(value));
}

export const color = {
  cyan: wrap("\x1b[36m", "\x1b[39m"),
  dim: wrap("\x1b[2m", "\x1b[22m"),
  green: wrap("\x1b[32m", "\x1b[39m"),
  red: wrap("\x1b[31m", "\x1b[39m"),
  yellow: wrap("\x1b[33m", "\x1b[39m"),
};
