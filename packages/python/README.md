# addon-host

Python 3.12, async throughout, Apache-2.0. Install `addon-host==0.1.0`.

```python
from addon_host import OAuthConfig, OAuthSession, connect_mcp

config = OAuthConfig(
    server_url="https://mcp.example.test/mcp",
    issuer="https://issuer.example.test",
    client_id="your-pre-registered-public-client",
    redirect_uri="http://127.0.0.1:8090/api/callback",
    scopes=("read",),
)
oauth = OAuthSession(config)
# In a browser-session-bound link handler:
consent_url = await oauth.begin()
# After the actual user-consent redirect, in that same browser session:
await oauth.complete(state, code)
# Only execute explicit, reviewed calls:
async with connect_mcp(config.server_url, oauth=oauth) as client:
    tools = await client.list_tools()
```

An anonymous connection omits `oauth`; a failed authenticated connection never
falls back to anonymous. `connect_mcp` returns the official SDK `ClientSession`,
including tool/resource operations, and forwards `elicitation_callback` to it.
The host owns execution consent and UI prompts.

OAuth uses pinned SDK discovery helpers for protected-resource challenges and
well-known metadata, OAuth authorization-server metadata and OIDC fallback.
The issuer, public client ID, scopes and callback are configured explicitly.
Discovered metadata and endpoints must remain within the configured resource/issuer
origins. PKCE S256 is required, callback state is single-use and expires after
five real-time minutes, and credentials are bound to the exact MCP URL. HTTP is
permitted only for loopback development. Redirects and dynamic registration are
not followed. Providers with additional endpoint origins are unsupported in v0.1.

Access/refresh tokens stay in memory. The issuer must return an expiring bearer
token within configured scopes. Refresh is serialized per connection; failure
removes that connection's authority until relinking. Restart requires consent
again. Never serialize the OAuthSession or its tokens to a browser, card, log or
transcript. Browser cookie/CSRF checks and any domain account verification belong
to the embedding host, as demonstrated by the example.

No tool selection, retries of submitted calls, database, persistent credential
store, model, stdio adapter or hosted service is included.

Development: `uv sync --locked --group example`, `uv run pytest`,
`uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy src`, `uv build`.
Tests retain an 80% coverage gate. The [example](../../examples/host/README.md)
supplies independent browser/card checks.
