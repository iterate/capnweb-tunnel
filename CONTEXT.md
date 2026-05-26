# Captun

Captun exposes HTTP request handlers through public tunnel URLs. Its domain separates the low-level Cap'n Web fetcher capability from the gateway, deployment, hosted product, and future control-plane concerns built on top of it.

## Language

**Fetcher**:
A `fetch(request)` request handler that can produce a `Response`.
_Avoid_: Server, app

**Fetcher Capability**:
A **Fetcher** exposed over Cap'n Web so another runtime can call it.
_Avoid_: Fetch Tunnel, transport, client/server connection

**Fetcher Stub**:
The local Cap'n Web proxy for a remote **Fetcher Capability**.
_Avoid_: Tunnel, client, fetcher

**Tunnel**:
An active **Tunnel Gateway** registration with a public URL, lifecycle, and optional reusable **Connect Token**.
_Avoid_: Fetcher Capability, WebSocket session

**Tunnel Client**:
The process, browser tab, test, or agent environment that exposes a **Fetcher Capability** to a **Tunnel Gateway**.
_Avoid_: Local server, node process

**Tunnel Gateway**:
A public ingress that resolves incoming HTTP requests to active **Tunnels**.
_Avoid_: Server, Worker, hosted server

**Cloudflare Tunnel Gateway**:
A **Tunnel Gateway** implemented with a Cloudflare Worker and Durable Object.
_Avoid_: Server, Worker

**Tunnel Name**:
The public routing key a **Tunnel Gateway** uses to select an active **Tunnel**.
_Avoid_: Subdomain, path segment, slug

**Reserved Tunnel Name**:
A **Tunnel Name** held back for gateway, product, documentation, or future control-plane use.
_Avoid_: Blocked subdomain, reserved subdomain

**Tunnel Addressing**:
The **Tunnel Gateway**'s own scheme for turning a **Tunnel Name** into a public tunnel URL.
_Avoid_: Client routing mode, URL pattern

**Gateway Connect Request**:
The internal WebSocket request a **Tunnel Client** opens to a **Gateway** with Captun query parameters that register a **Tunnel**.
_Avoid_: Magic connect path, server URL

**Gateway Policy**:
Rules a **Tunnel Gateway** applies to **Gateway Connect Requests**, active **Tunnels**, and forwarded public requests.
_Avoid_: Hosted safety, middleware

**Trusted Gateway Policy**:
**Gateway Policy** for cooperative **Self-Hosted Deployments**, usually based on a **Gateway Secret**.
_Avoid_: Self-hosted policy, private policy

**Public Gateway Policy**:
**Gateway Policy** for untrusted public tunnel creation, including reserved names, anonymous ownership, and rate limits.
_Avoid_: Hosted policy, safety policy

**Tunnel Admission**:
The **Tunnel Gateway** policy decision that accepts, rejects, or diagnoses a **Gateway Connect Request** before it becomes an active **Tunnel**.
_Avoid_: Hosted admission, auth check

**Connect Token**:
A credential carried on a **Gateway Connect Request** and interpreted by **Tunnel Admission**.
_Avoid_: Secret, owner token

**Gateway Secret**:
A **Connect Token** that authorizes use of a whole **Self-Hosted Deployment**.
_Avoid_: Captun secret, auth secret

**Ownership Token**:
A **Connect Token** that preserves claim over one active anonymous **Tunnel Name**.
_Avoid_: User token, auth token

**Gateway**:
The public API option naming a **Tunnel Gateway** by URL.
_Avoid_: serverUrl, gatewayUrl

**Runtime Adapter**:
An integration that accepts **Fetcher Capabilities** in a specific WebSocket runtime without necessarily providing a full **Tunnel Gateway**.
_Avoid_: Gateway, server

**Self-Hosted Deployment**:
A user-controlled **Tunnel Gateway** deployment.
_Avoid_: Private hosted service, user server

**Hosted Service**:
The Iterate-operated `captun.sh` **Tunnel Gateway** for public, untrusted tunnel creation.
_Avoid_: Default server, public Worker

**Hosted Site**:
The `www.captun.sh` documentation and browser-demo surface for the **Hosted Service**.
_Avoid_: Landing page, marketing site

**Control Plane**:
The future account, authentication, billing, reservation, and policy system for the **Hosted Service**.
_Avoid_: Dashboard, app, auth layer

**Agent Preview Use Case**:
A use case where an agent creates a public URL through the **Hosted Service** so a human can inspect work quickly.
_Avoid_: Agent layer, agent product

## Relationships

- A **Tunnel Client** exposes a **Fetcher Capability**.
- A **Tunnel Gateway** receives a **Fetcher Stub** for the **Tunnel Client**'s **Fetcher Capability**.
- A **Tunnel** is backed by one active **Fetcher Stub**.
- A **Tunnel Gateway** stores active **Tunnels**; the **Fetcher Stub** is the backing capability, not the gateway's domain object.
- Low-level accepting APIs should be named `acceptFetcherCapability` and `acceptFetcherCapabilityFromSocket`.
- `createCaptunTunnel` is the high-level public API for creating a **Tunnel**.
- `connectFetcherCapability` is the preferred internal name for the client-side primitive that opens a **Gateway Connect Request** and exposes the **Fetcher Capability**.
- Do not export `connectFetcherCapability` until there is a concrete non-gateway use case.
- A **Tunnel Gateway** maps each active **Tunnel Name** to at most one **Tunnel**.
- The current concrete **Tunnel Gateway** implementation is the **Cloudflare Tunnel Gateway**.
- A **Tunnel Gateway** owns **Tunnel Addressing**; **Tunnel Clients** should not need to know whether public tunnel URLs use paths or subdomains.
- A **Tunnel Client** builds a **Gateway Connect Request** from the user-supplied **Gateway** URL, the optional **Tunnel Name**, and Captun-owned query parameters.
- **Tunnel Admission** is **Gateway Policy** for **Gateway Connect Requests**.
- **Self-Hosted Deployments** created by the wizard use **Trusted Gateway Policy** by default.
- The **Hosted Service** uses **Public Gateway Policy**.
- **Gateway Policy** must be configured explicitly and not inferred from **Tunnel Addressing** or hostnames such as `captun.sh`.
- Renaming the current `CUSTOM_HOSTNAME` addressing env var is deferred. The priority is separating **Gateway Policy** from **Tunnel Addressing** first.
- Public Captun APIs should call the user-supplied **Tunnel Gateway** URL `gateway`.
- Public Captun APIs should call the user-supplied **Connect Token** `token`. **Tunnel Admission** decides whether that token is a **Gateway Secret**, **Ownership Token**, or future **Control Plane** credential.
- `createCaptunTunnel` should return a reusable `token` when the **Tunnel Gateway** provides or accepts one.
- New code should not support `/__captun-connect`; connect intent belongs in Captun query parameters on the **Gateway Connect Request**.
- Default custom-domain **Self-Hosted Deployments** should choose a **Gateway** hostname inside the wildcard tunnel route and make that hostname a **Reserved Tunnel Name**.
- `captun`, `gateway`, and `tunnel` should be **Reserved Tunnel Names** by default, along with a small set of likely future **Control Plane** names.
- **Reserved Tunnel Names** apply to the **Hosted Service** and to wizard-generated **Self-Hosted Deployments**. Manual/custom deployments may change the list.
- A **Self-Hosted Deployment** runs a **Tunnel Gateway** in a user's own infrastructure.
- The current deploy wizard creates a **Cloudflare Tunnel Gateway**, but future runtime gateways could also be **Self-Hosted Deployments**.
- The **Hosted Service** is a public **Tunnel Gateway** operated for untrusted users.
- The **Hosted Service** is currently the **Cloudflare Tunnel Gateway** running with public hosted policy and the `captun.sh` product surface.
- The **Hosted Site** is part of the **Hosted Service** product surface, but it is not tunnel routing or **Tunnel Admission**.
- **Hosted Site** code should not live in **Cloudflare Tunnel Gateway** core. A real browser package can wait until the demo surface needs it.
- **Hosted Service** entrypoints may compose the **Cloudflare Tunnel Gateway**, but **Cloudflare Tunnel Gateway** core should remain understandable as a **Self-Hosted Deployment** with **Trusted Gateway Policy**.
- **Public Gateway Policy** implementation for `captun.sh` should live under `src/hosted/`; `src/worker.ts` should stay readable as the deployable **Cloudflare Tunnel Gateway** core.
- The **Control Plane** governs future **Hosted Service** accounts, reservations, billing, and policy.
- The **Agent Preview Use Case** uses the **Hosted Service** and may later use the **Control Plane**.
- The **Agent Preview Use Case** should not shape the current gateway/core split until **Control Plane** support exists.
- A **Runtime Adapter** can be used to build a **Tunnel Gateway**, but accepting a WebSocket and producing a **Fetcher Stub** is not the same as managing named **Tunnels**.

## Example Dialogue

> **Dev:** "Does the Node adapter make Node a Tunnel Gateway?"
> **Domain expert:** "No. The adapter accepts a Fetcher Capability in Node and produces a Fetcher Stub, but a Tunnel Gateway also needs named public routing and active tunnel management."

> **Dev:** "When `npx captun 3000` has no local config, is that still self-hosted?"
> **Domain expert:** "No. That uses the Hosted Service. Self-Hosted Deployment starts after `npx captun deploy` writes a user-controlled gateway URL and token."

## Flagged Ambiguities

- "Server" has meant the **Tunnel Gateway**, the **Fetcher**, and the **Hosted Service**. Use the precise term.
- "Hosted" has meant both **Self-Hosted Deployment** and the public **Hosted Service**. Use **Self-Hosted Deployment** for user-owned infrastructure and **Hosted Service** for `captun.sh`.
- Node, Bun, and Deno support should be described as **Runtime Adapters** unless they also provide named public routing and active tunnel management.
- "Fetch Tunnel" sounded natural but conflicts with Cap'n Web vocabulary. Use **Fetcher Capability** and **Fetcher Stub** for the low-level Cap'n Web layer, and **Tunnel** for the gateway/product registration.
- "serverUrl" currently means a client-side tunnel URL construction pattern. The preferred model is a **Gateway** URL plus gateway-owned **Tunnel Addressing**.
- "secret" and "ownerToken" are implementation-specific kinds of **Connect Token**. Public APIs should prefer `token`.
- `/__captun-connect` encoded connect intent as a path. This is rejected for the pre-user API because it makes the public gateway URL model harder to understand.
- Apex gateway URLs such as `https://example.com` are not the default deploy-wizard path. Users who want them can compose the exported pieces and Cloudflare routes themselves.
