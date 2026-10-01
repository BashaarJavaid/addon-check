# Explicit local MCP host

This local FastAPI/React example consumes both `addon-host` packages. It uses no
Hirz imports, household fixtures, model or paid inference. Use Node 24/Python 3.12.

From the repository root:

```sh
npm ci
npm run build:host
uv sync --project packages/python --locked --group example
node examples/host/reference.mjs
```

In another terminal:

```sh
packages/python/.venv/bin/python examples/host/server.py --server http://127.0.0.1:3001/mcp
```

Open `http://127.0.0.1:8090`. Discover tools, select `get-time`, review `{}`,
then confirm the exact call. The returned timestamp renders in the official card.
Its Get Server Time button requests a second, independently reviewed MCP call.
Switch to Echo Dot to remove the iframe; results remain in the transcript.

For an OAuth server, replace `--server` and add `--issuer`, `--client-id` and one
`--scope` per configured scope. Register the exact callback
`http://127.0.0.1:8090/api/callback` with that issuer, or match a chosen `--port`.
Click Link with consent before discovery. All targets are startup configuration;
the browser cannot edit them. The host binds loopback, keeps tokens only in Python
memory and uses HttpOnly cookies and exact Origin/CSRF validation.

Every call, including card requests, requires exact review; read-only annotations
do not grant permission. Arguments use JSON with schema validation and local
references only. Scalar elicitation has labeled fields with accept/decline/cancel.
Unsupported elicitation shapes cancel. Requests serialize per browser; stopping
or losing a conversation does not undo an accepted server action. There is no
automatic retry after an ambiguous failure.

Push to talk fills a selected string field or answers a single scalar prompt.
The Speak responses checkbox reads foreground MCP text; it never speaks JSON,
replayed receipts or background card results. Typed/visible text remains available
without a microphone or browser speech support. No language model selects tools.

Only self-contained `text/html;profile=mcp-app` resources are supported. The host
reads `_meta.ui.resourceUri`, enforces a no-network CSP and an opaque sandbox, and
never passes tokens into cards. Network-dependent cards report unavailable while
preserving the actual tool receipt. Additional MCP Apps capabilities such as
opening external links or sending conversational messages are unsupported.

## Verification

```sh
npm test --workspace addon-host-example
```

Playwright starts fresh loopback servers and checks rendering, reviewed card calls,
Dot mode, theme context, keyboard focus, replay silence, invalid JSON, CSRF and
browser isolation. Install its pinned Chromium with
`npm exec --workspace addon-host-example -- playwright install chromium` if needed.
The test captures `test-results/reference-card.png`. Human microphone and physical
passkey evidence for Hirz is a separate gate, never inferred from these tests.

The fixture is the MIT-licensed official
[`basic-server-vanillajs`](https://github.com/modelcontextprotocol/ext-apps/tree/352f6ced4d80772e92b4e7a311854481a8d65b04/examples/basic-server-vanillajs),
published as `@modelcontextprotocol/server-basic-vanillajs@2.0.0` and integrity-pinned
in the npm lockfile. `reference.mjs` wraps its unchanged `createServer` export so
the test binds loopback rather than the upstream CLI's all-interface listener.
No upstream server or card source is modified. This verifies scoped host behavior,
not Amazon certification or a general-purpose production host.
