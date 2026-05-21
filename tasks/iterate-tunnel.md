We may as well have an iterate-hosted one soon
It could be what gets used if you haven't run `npx captun deploy`
It's an ngrok-level happy path. Zero install/auth/ceremony, just: `npx captun 3000`
We could probably have subdomain based routing for that but need to set up the wildcard subdomain cert for `*.captun.sh`
We'd also need some kind of DO-based (global?) rate limiting
