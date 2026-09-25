# addon-check

Independent black-box MCP add-on checks. **Passing is not Amazon certification.**
The CLI reports observed transport, authentication metadata, schema and explicitly
authorized tool-call evidence. It knows nothing about household data or Hirz internals.
Node 22 or later. Apache-2.0.

```sh
npm install --global addon-check@0.1.0
addon-check https://example.org/mcp
addon-check https://example.org/mcp --token-env MCP_TOKEN --cases cases.json --require-complete
addon-check https://example.org/mcp --token-env MCP_TOKEN --cases cases.json --json
```

Set `MCP_TOKEN` privately through your shell or secret manager; never put a real
bearer token on the command line. URL-only execution initializes and discovers
tools and inspects public metadata, but **never calls a tool**. It reports the
missing execution evidence. Resource reads for declared UI references are read-only
MCP requests; the checker does not execute HTML or load resources in a browser.

## Explicit execution cases

A cases file authorizes the exact calls below. Every field is required; unknown
fields are rejected. Tool annotations never grant permission to call or repeat.
Choose safe fixtures or a disposable environment before authorizing mutations.

```json
{
  "version": 1,
  "cases": [{
    "tool": "get_household_context",
    "arguments": {"scope": "all"},
    "speechPointers": [
      "/structuredContent/speakable/headline",
      "/structuredContent/speakable/details",
      "/structuredContent/speakable/options"
    ],
    "repeatable": true,
    "expectError": false,
    "authProbe": true
  }]
}
```

- `arguments` are validated against the discovered input schema before **any**
  case calls run. Invalid arguments/unknown tools are configuration errors. An
  unsupported input schema skips its calls rather than bypassing validation.
- `repeatable: false` executes once. `true` explicitly authorizes one warm-up and
  exactly 20 additional sequential calls; a transport/result failure stops the
  case. No automatic retry occurs. Retain request IDs when testing durable retries.
- `authProbe: true` explicitly permits two additional calls with the same arguments:
  one without a token and one with a fixed malformed token. These must be protected
  calls. They must return HTTP 401 with a Bearer challenge naming resource metadata
  and nonempty scope; the malformed-token challenge must say `invalid_token`.
- `expectError` checks MCP `isError`, not a JSON-RPC/HTTP error. An expected MCP
  error need not match a successful-output schema. It does not supply successful
  output evidence for completeness.
- `speechPointers` are RFC 6901 pointers into the **complete CallToolResult**.
  Selected values must be strings or arrays of strings. Empty pointer lists
  explicitly leave speech untested. Every returned result, including warm-up,
  is checked; private arguments, selected text and raw payloads are never printed.
  This example uses Hirz's shape; other servers may select any fields, such as
  `/content/0/text`. No `speakable` or flat-input convention is imposed.

## Scope and sources

Each JSON check includes its source category and URL. A pass describes this
specific endpoint, cases, sample and invocation, not every tool path or deployment.

| Check | Authority | Limits |
|---|---|---|
| Streamable HTTP, JSON/SSE, initialization and 2025-11-25 negotiation | [MCP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) | POST streams only; no persistent GET needed; no resumability or client sampling/elicitation tests |
| Tools, schemas and naming | [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Paginate up to 100 pages; repeated cursors fail. Missing descriptions/output schemas and naming guidance violations warn. snake_case is checker policy |
| Input/output JSON Schema | MCP tools; checker dialect policy | Default 2020-12 or explicit `http://json-schema.org/draft-07/schema#`; local fragment references only; formats are annotations. Unsupported dialects/external references are SKIP, never fetched. Schema details are withheld on errors |
| PRM identity, issuer metadata, advertised S256 and scoped 401 probes | [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | Metadata and supplied-token probes only; no OAuth login, PKCE exchange, refresh, audience/signature or production identity certification. Metadata GETs carry no token |
| Every measured call <500 ms | [Amazon quickstart](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html) | 20 sequential round trips per explicitly repeatable case; warm-up separate. Report lists exactly which tools were timed; not the full server workload, cold start, concurrency or isolation |
| Speech <75 words at 150 words/minute | Checker policy informed by [Amazon functional guidance](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | Amazon calls <30 seconds a best practice. Whitespace word count is an English **text estimate**, not measured Alexa audio; numbers, pronunciation and TTS speed vary |
| Selected speech formatting | Amazon functional guidance; checker text heuristic | Pipes, backticks, Markdown links/images/headings/list markers and paired emphasis; ordinary punctuation is preserved. Serialized payloads are never treated as speech |
| UI references and metadata | [MCP Apps 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) | `_meta.ui.resourceUri` (legacy alias warns), visibility, matching `resources/read` content/MIME and documented metadata types. Data-only tools are not applicable. HTML validity, actual rendering, security enforcement and display modes require MANUAL browser review |

**Authentication documentation conflict (checked 2026-09-23):** Amazon's
[authentication guidance](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html)
lists `WWW-Authenticate` headers in 401 responses among unsupported features.
MCP specifies challenge-based discovery and requires clients to parse that header.
This checker deliberately tests the scoped MCP behavior; it does not test Amazon's
service-level client-credentials flow or claim Amazon authentication compatibility.
Display-mode support is exchanged by browser apps/hosts during `ui/initialize`,
not invented as a server tool declaration.

## Reports and exit status

`--json` emits a versioned object containing `version: 1`, `summary`, and `checks`.
Each check has `id`, `status`, `source`, and `message`; `tool`, zero-based `caseIndex`,
and `metrics` appear only when relevant. Statuses are `PASS`, `FAIL`, `WARN`, `SKIP`,
and `MANUAL`. Summary includes counts, completeness, missing evidence, and timed
names. Latency metrics retain the warm-up and all 20 samples; speech metrics contain
counts only. Failure messages identify the check/cause without response data.

- Exit **0**: requested checks passed; WARN/MANUAL and disclosed incomplete evidence
  are allowed unless `--require-complete` is set.
- Exit **1**: a requested check failed (takes precedence over incomplete evidence).
- Exit **2**: invalid configuration, or `--require-complete` lacks evidence.

Completeness requires successful output and selected speech for every discovered
tool, a passing protected auth probe paired with a successful authorized call,
a passing repeatable latency case, and no skipped required check. Warnings and
manual browser review remain visible without failing completeness.

HTTPS is required except loopback HTTP. Every response has a 10-second deadline
and 1 MiB bound. Redirects and automatic retries are disabled. Authentication goes
only to the exact supplied MCP URL; UI resources are read through that endpoint.
Authorization metadata uses documented well-known fallbacks on 404/405 only,
without credentials. Discovery follows server-provided public metadata URLs, so
run against endpoints you intend to inspect. No payload, server error text or
bearer token is logged. Tool names and timing/count metrics are public report data.

## Synthetic fixture and development

The included fixture has **no real users, devices, OAuth login or side effects**.
Its fixed token is synthetic test data, not a secret. It supports passing and broken
variants for protocol, auth, schemas, speech and latency regression tests.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
node examples/fixture.mjs
# Copy the printed loopback URL into this command in another terminal:
FIXTURE_TOKEN=synthetic-token node dist/cli.js http://127.0.0.1:PORT/mcp --token-env FIXTURE_TOKEN --cases examples/cases.json --require-complete
# Restart the fixture with --broken: the same checker fails speech.estimate (75 words).
```

Tests exercise the compiled CLI over real HTTP, including SSE, broken variants,
call authorization/counts, deadlines, response bounds, token isolation, schema
references, speech boundaries, UI review and exit codes. The MCP SDK supplies wire
result/envelope validators; native fetch controls transport bounds without the
SDK client's optional GET/retry behavior. Ajv validates schemas independently.

## Publishing

Use Node 24, run all checks, and inspect `npm pack --dry-run`. Create the artifact
with `npm pack`, inspect its file list, install that exact tarball in a clean
temporary directory and run the installed CLI against passing/broken fixtures
(`node test/package.mjs ./addon-check-0.1.0.tgz`).
Recheck `npm view addon-check versions` before first publication; an absent
package does not reserve its name. Authenticate interactively with `npm login`,
then publish **the tested tarball** using `npm publish ./addon-check-0.1.0.tgz
--access public`, following the [npm publication procedure](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
Never put a login credential or OTP in a report. Finally install
`addon-check@0.1.0` in another clean directory and rerun fixture checks.
Git source publication and a packed local install are distinct from npm publication.
