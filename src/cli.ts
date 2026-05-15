import { CapnwebTunnelClient } from "./client.ts";

const { port, tunnelName } = parseArgs(process.argv.slice(2));
const baseUrl = process.env.TUNNEL_SERVER_URL ?? "http://localhost:8787";
const tunnel = new URL(`/${tunnelName}`, baseUrl).toString();
const origin = `http://localhost:${port}`;

const client = new CapnwebTunnelClient(tunnel, {
  headers: authHeaders(),
  fetch: (request) => {
    const url = new URL(request.url);
    return fetch(new URL(url.pathname + url.search, origin), request);
  },
});

console.log(`tunneling ${tunnel} -> ${origin}`);
await client.connect();
await new Promise(() => {});

function parseArgs(args: string[]): { port: string; tunnelName: string } {
  const nameIndex = args.indexOf("--name");
  const tunnelName = nameIndex === -1 ? randomTunnelName() : args[nameIndex + 1];
  const port = args.find((arg, index) => index !== nameIndex && index !== nameIndex + 1) ?? "3000";
  if (!tunnelName) throw new Error("--name needs a value");
  return { port, tunnelName };
}

function authHeaders(): Record<string, string> | undefined {
  if (!process.env.TUNNEL_USERNAME || !process.env.TUNNEL_PASSWORD) return undefined;
  const token = Buffer.from(`${process.env.TUNNEL_USERNAME}:${process.env.TUNNEL_PASSWORD}`).toString("base64");
  return { authorization: `Basic ${token}` };
}

function randomTunnelName(): string {
  return [pick(adjectives), pick(speeds), pick(things)].join("-");
}

function pick(words: string[]): string {
  return words[Math.floor(Math.random() * words.length)]!;
}

const adjectives = ["apple", "amber", "bright", "cedar", "copper", "daisy", "ember", "forest", "ginger", "harbor", "indigo", "jolly", "kiwi", "lemon", "maple", "nova", "olive", "pearl", "quartz", "ruby"];
const speeds = ["fast", "swift", "quick", "rapid", "zippy", "brisk", "fleet", "nimble", "snappy", "speedy", "lively", "eager", "sharp", "ready", "active", "bold", "crisp", "fresh", "keen", "spry"];
const things = ["tree", "river", "stone", "cloud", "field", "bridge", "spark", "meadow", "tower", "trail", "garden", "island", "planet", "signal", "anchor", "valley", "window", "canyon", "summit", "harvest"];
