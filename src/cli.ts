import { CapnwebTunnelClient } from "./client.ts";

const adjectives = ["apple", "amber", "bright", "cedar", "copper", "daisy", "ember", "forest", "ginger", "harbor", "indigo", "jolly", "kiwi", "lemon", "maple", "nova", "olive", "pearl", "quartz", "ruby"];
const speeds = ["fast", "swift", "quick", "rapid", "zippy", "brisk", "fleet", "nimble", "snappy", "speedy", "lively", "eager", "sharp", "ready", "active", "bold", "crisp", "fresh", "keen", "spry"];
const things = ["tree", "river", "stone", "cloud", "field", "bridge", "spark", "meadow", "tower", "trail", "garden", "island", "planet", "signal", "anchor", "valley", "window", "canyon", "summit", "harvest"];

const { port, name, secret } = parseArgs(process.argv.slice(2));
const baseUrl = process.env.TUNNEL_SERVER_URL ?? "http://localhost:8787";
const tunnel = tunnelUrl(baseUrl, name);
const origin = `http://localhost:${port}`;

const client = new CapnwebTunnelClient(tunnel, {
  secret,
  fetch: (request) => {
    const url = new URL(request.url);
    return fetch(new URL(url.pathname + url.search, origin), request);
  },
});

console.log(`tunneling ${tunnel} -> ${origin}`);
await client.connect();
await new Promise(() => {});

function tunnelUrl(baseUrl: string, name: string) {
  const url = new URL(baseUrl);
  if (url.hostname.match(/^[^.]+\.tunnels\./)) {
    url.pathname = "/";
  } else {
    url.pathname = `/${name}/`;
  }
  return url.toString();
}

function parseArgs(args: string[]) {
  const nameIndex = args.indexOf("--name");
  const secretIndex = args.indexOf("--secret");
  const name = nameIndex === -1 ? randomName() : args[nameIndex + 1];
  const secret = secretIndex === -1 ? process.env.TUNNEL_SECRET : args[secretIndex + 1];
  const flagArgs = new Set([nameIndex, secretIndex].filter((index) => index !== -1).flatMap((index) => [index, index + 1]));
  const port = args.find((_arg, index) => !flagArgs.has(index)) ?? "3000";
  if (!name) throw new Error("--name needs a value");
  if (secretIndex !== -1 && !secret) throw new Error("--secret needs a value");
  return { port, name, secret };
}

function randomName() {
  return [pick(adjectives), pick(speeds), pick(things)].join("-");
}

function pick(words: string[]) {
  const word = words[Math.floor(Math.random() * words.length)];
  if (!word) throw new Error("Cannot pick from an empty word list");
  return word;
}
