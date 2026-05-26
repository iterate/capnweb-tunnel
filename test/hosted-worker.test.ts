import { expect, test } from "vitest";
import { createHostedCaptunWorkerFixture } from "./miniflare.js";

test("Hosted Captun redirects the apex hostname to www", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://captun.sh/docs?x=1", {
    redirect: "manual",
  });

  expect(response).toMatchObject({ status: 308 });
  expect(response.headers.get("location")).toBe("https://www.captun.sh/docs?x=1");
});

test("Hosted Captun serves a static landing page on www", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://www.captun.sh/");

  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();

  expect(html).toEqual(
    expect.stringContaining(
      'cap[<a href="https://github.com/cloudflare/capnweb">nweb</a>] tun[nel]',
    ),
  );
  expect(html).toEqual(
    expect.stringContaining('<a href="https://github.com/iterate/captun#performance">fast</a>'),
  );
  expect(html).toEqual(expect.stringContaining("Run this with something listening on port 3000:"));
  expect(html).toEqual(expect.stringContaining("npx captun 3000"));
  expect(html).toEqual(
    expect.stringContaining("You don't need to run a local server. Just a fetch function:"),
  );
});

test("Hosted Captun serves the browser demo module on www", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://www.captun.sh/captun.browser.js");

  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toContain("application/javascript");
  const module = await response.text();
  expect(module).toEqual(expect.stringContaining("createCaptunTunnel"));
  expect(module).toEqual(expect.stringContaining("captun-connect"));
  expect(module).not.toEqual(expect.stringContaining("__captun-connect"));
});

test("Hosted Captun landing page includes an in-browser tunnel demo", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://www.captun.sh/");

  const html = await response.text();

  expect(html.indexOf("<h2>Try it in this tab</h2>")).toBeLessThan(
    html.indexOf("<h2>Bring your own Cloudflare account</h2>"),
  );
  expect(
    html.indexOf(
      'This works in <em>any</em> environment supported by <a href="https://github.com/cloudflare/capnweb">capnweb</a>',
    ),
  ).toBeLessThan(
    html.indexOf("Edit the fetch function, create a tunnel, then the iframe below will load"),
  );
  expect(html).toEqual(
    expect.stringContaining(
      'This works in <em>any</em> environment supported by <a href="https://github.com/cloudflare/capnweb">capnweb</a>',
    ),
  );
  expect(html).toEqual(expect.stringContaining('// your "server" is this browser tab!'));
  expect(html).toEqual(expect.stringContaining("window.chatMessages"));
  expect(html).toEqual(expect.stringContaining("document.cookie"));
  expect(html).toEqual(expect.stringContaining("username ||= "));
  expect(html).toEqual(expect.stringContaining("function send(form)"));
  expect(html).toEqual(expect.stringContaining('onsubmit="send(this); return false"'));
  expect(html).toEqual(expect.stringContaining("<button>send</button>"));
  expect(html).toEqual(expect.stringContaining("Response.json({ ok: true })"));
  expect(html).toEqual(expect.stringContaining('<textarea id="demo-source" spellcheck="false">'));
  expect(html).toEqual(
    expect.stringContaining(
      '<button id="demo-reload" class="icon-button" type="button" aria-label="reload iframe" title="reload iframe" disabled>&#8635;</button>',
    ),
  );
  expect(html).toEqual(expect.stringContaining("text-size-adjust: 100%"));
  expect(html).toEqual(expect.stringContaining('style="font-size:16px" autofocus'));
  expect(html).toEqual(expect.stringContaining("function currentSource()"));
  expect(html).toEqual(expect.stringContaining('frame.src = tunnel.url + "/"'));
  expect(html).toEqual(expect.stringContaining("void enhanceEditor();"));
  expect(html).toEqual(
    expect.stringContaining('const captunBrowser = import("/captun.browser.js");'),
  );
  expect(html).not.toContain('import { createCaptunTunnel } from "/captun.browser.js";');
});

test("Hosted Captun landing page loads CodeMirror for the browser demo editor", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://www.captun.sh/");

  const html = await response.text();

  expect(html).toEqual(expect.stringContaining("codemirror@6.0.1"));
  expect(html).toEqual(expect.stringContaining('id="from-code-source"'));
  expect(html).toEqual(expect.stringContaining("EditorView.editable.of(false)"));
  expect(html).not.toContain("EditorView.lineWrapping");
  expect(html).toEqual(
    expect.stringContaining("CodeMirror failed to load; using textarea editor."),
  );
});

test.each([
  "account",
  "accounts",
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "captun",
  "dash",
  "dashboard",
  "docs",
  "gateway",
  "gateways",
  "iterate",
  "login",
  "payment",
  "payments",
  "status",
  "support",
  "tunnel",
  "tunnels",
])("Hosted Captun reserves %s.captun.sh", async (subdomain) => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch(`https://${subdomain}.captun.sh/`);

  expect(response).toMatchObject({ status: 404 });
  expect(await response.text()).toBe("Reserved Captun tunnel name\n");
});
