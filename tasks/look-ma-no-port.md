support `npx captun server.ts`
where server.ts contains something like `export default { fetch: (req: Request) => new Response("hello world" + req.url) }`
basically whne the "target" looks like a file that exists relative to cwd, just do `const {default: fetcher} = await import(filepath)` an if that's a function, assume it's a fetch function.

also allow `npx captun -e '(req) => new Response("hello world" + req.url)'`, why not
