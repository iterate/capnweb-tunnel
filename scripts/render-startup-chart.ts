import { mkdir, readFile, writeFile } from "node:fs/promises";

type Result = {
  provider: string;
  count: number;
  successes: number;
  failures: number;
  p50?: number;
  p90?: number;
  p99?: number;
};

const input = process.env.INPUT ?? "docs/performance/capnweb-startup.json";
const output = process.env.OUTPUT ?? "docs/performance/startup.svg";

const data = JSON.parse(await readFile(input, "utf8")) as { results: Result[] };
const rows = data.results.filter((row) => row.provider === "capnweb" && row.p50 && row.p90 && row.p99);
const width = 920;
const height = 520;
const margin = { top: 42, right: 116, bottom: 72, left: 86 };
const plotWidth = width - margin.left - margin.right;
const plotHeight = height - margin.top - margin.bottom;
const maxX = Math.max(...rows.map((row) => row.count));
const maxY = Math.max(...rows.flatMap((row) => [row.p50 ?? 0, row.p90 ?? 0, row.p99 ?? 0])) * 1.08;
const series = [
  { key: "p50", label: "p50", color: "#2563eb" },
  { key: "p90", label: "p90", color: "#f59e0b" },
  { key: "p99", label: "p99", color: "#dc2626" },
] as const;

await mkdir("docs/performance", { recursive: true });
await writeFile(output, svg());
console.log(`wrote ${output}`);

function svg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Capnweb tunnel startup time by concurrency</title>
  <desc id="desc">Line chart showing p50, p90, and p99 time to first successful fetch as simultaneous tunnel creation increases.</desc>
  <rect width="${width}" height="${height}" fill="white"/>
  <text x="${margin.left}" y="28" font-family="system-ui, sans-serif" font-size="20" font-weight="700" fill="#111827">Time to first successful fetch</text>
  <text x="${margin.left}" y="50" font-family="system-ui, sans-serif" font-size="13" fill="#4b5563">Capnweb tunnel startup under simultaneous tunnel creation</text>
  ${grid()}
  ${series.map(line).join("\n")}
  ${rows.map(points).join("\n")}
  ${legend()}
  <text x="${margin.left + plotWidth / 2}" y="${height - 20}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#374151">simultaneous tunnels requested</text>
  <text transform="translate(22 ${margin.top + plotHeight / 2}) rotate(-90)" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#374151">milliseconds</text>
</svg>
`;
}

function grid() {
  const xTicks = [1, 10, 100, 500, 1000, 2000];
  const yTicks = [0, 10_000, 20_000, 30_000, 40_000];
  return `
  <line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="#111827"/>
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#111827"/>
  ${xTicks.map((tick) => `<g>
    <line x1="${x(tick)}" y1="${margin.top}" x2="${x(tick)}" y2="${margin.top + plotHeight}" stroke="#e5e7eb"/>
    <text x="${x(tick)}" y="${margin.top + plotHeight + 24}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#4b5563">${tick}</text>
  </g>`).join("\n")}
  ${yTicks.map((tick) => `<g>
    <line x1="${margin.left}" y1="${y(tick)}" x2="${margin.left + plotWidth}" y2="${y(tick)}" stroke="#e5e7eb"/>
    <text x="${margin.left - 10}" y="${y(tick) + 4}" text-anchor="end" font-family="system-ui, sans-serif" font-size="12" fill="#4b5563">${tick / 1000}s</text>
  </g>`).join("\n")}
  `;
}

function line(item: (typeof series)[number]) {
  const d = rows.map((row, index) => `${index === 0 ? "M" : "L"} ${x(row.count)} ${y(row[item.key] ?? 0)}`).join(" ");
  return `<path d="${d}" fill="none" stroke="${item.color}" stroke-width="3"/>`;
}

function points(row: Result) {
  const failure = row.failures ? `<text x="${x(row.count)}" y="${y(row.p99 ?? 0) - 12}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#991b1b">${row.successes}/${row.count} ok</text>` : "";
  return `${series.map((item) => `<circle cx="${x(row.count)}" cy="${y(row[item.key] ?? 0)}" r="4" fill="${item.color}"/>`).join("\n")}${failure}`;
}

function legend() {
  return series.map((item, index) => {
    const y = margin.top + index * 24;
    return `<g><line x1="${width - margin.right + 20}" y1="${y}" x2="${width - margin.right + 46}" y2="${y}" stroke="${item.color}" stroke-width="3"/><text x="${width - margin.right + 54}" y="${y + 4}" font-family="system-ui, sans-serif" font-size="13" fill="#111827">${item.label}</text></g>`;
  }).join("\n");
}

function x(value: number) {
  return margin.left + (value / maxX) * plotWidth;
}

function y(value: number) {
  return margin.top + plotHeight - (value / maxY) * plotHeight;
}
