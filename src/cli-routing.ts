import { usesFolderRouting } from "./worker-routing.js";

export function tunnelBrowserRootUrl(baseUrl: string, name: string) {
  if (baseUrl.includes("{name}")) return undefined;

  const url = new URL(baseUrl);
  if (!usesFolderRouting(url.hostname)) return undefined;
  url.pathname = `${url.pathname.replace(/\/$/, "")}/__captun/t/${encodeURIComponent(name)}`;
  url.search = "";
  url.hash = "";
  return removeTrailingSlash(url.toString());
}

function removeTrailingSlash(url: string) {
  return url.replace(/\/$/, "");
}
