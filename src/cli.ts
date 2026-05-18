#!/usr/bin/env node
import { CaptunClient } from "./client.ts";

const words = [
  ["apple", "amber", "bright", "cedar", "copper", "daisy", "ember", "forest", "ginger", "harbor", "indigo", "jolly", "kiwi", "lemon", "maple", "nova", "olive", "pearl", "quartz", "ruby"],
  ["fast", "swift", "quick", "rapid", "zippy", "brisk", "fleet", "nimble", "snappy", "speedy", "lively", "eager", "sharp", "ready", "active", "bold", "crisp", "fresh", "keen", "spry"],
  ["tree", "river", "stone", "cloud", "field", "bridge", "spark", "meadow", "tower", "trail", "garden", "island", "planet", "signal", "anchor", "valley", "window", "canyon", "summit", "harvest"],
];

const args = process.argv.slice(2);
const name = args.includes("--name") ? args[args.indexOf("--name") + 1] : words.map((list) => list[Math.floor(Math.random() * list.length)]).join("-");
const secret = args.includes("--secret") ? args[args.indexOf("--secret") + 1] : process.env.CAPTUN_SECRET;
const port = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--name" && args[index - 1] !== "--secret") ?? "3000";
const base = new URL(process.env.CAPTUN_SERVER_URL ?? "http://localhost:8787");
base.pathname = base.hostname.match(/^[^.]+\.tunnels\./) ? "/" : `/${name}/`;

using tunnel = await CaptunClient.connect({
  serverUrl: base,
  secret,
  fetch: (request) => {
    const url = new URL(request.url);
    return fetch(new URL(url.pathname + url.search, `http://localhost:${port}`), request);
  },
});

console.log(`tunneling ${base} -> http://localhost:${port}`);
await new Promise(() => {});
