import asyncio
from urllib.parse import parse_qs, urlsplit

import addon_host
import httpx
import pytest
from addon_host import OAuthConfig, OAuthSession, connect_mcp
from mcp.client.auth.exceptions import OAuthFlowError


def configured():
    return OAuthConfig(
        "http://127.0.0.1:9000/mcp",
        "http://127.0.0.1:9001",
        "registered",
        "http://127.0.0.1:9002/callback",
        ("read",),
    )


def fixture(monkeypatch, fault=None):
    requests = []
    config = configured()

    def handle(request):
        requests.append(request)
        assert "authorization" not in request.headers
        path = request.url.path
        if path == "/mcp":
            return httpx.Response(
                401,
                headers={
                    "WWW-Authenticate": 'Bearer resource_metadata="http://127.0.0.1:9000/metadata", scope="read"'
                },
            )
        if path in {
            "/metadata",
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-protected-resource",
        }:
            if fault == "missing":
                return httpx.Response(404)
            if fault == "metadata_error":
                return httpx.Response(503)
            return httpx.Response(
                200,
                json={
                    "resource": config.server_url
                    if fault != "resource"
                    else "https://wrong.test/mcp",
                    "authorization_servers": [
                        config.issuer if fault != "issuer" else "https://wrong.test"
                    ],
                },
            )
        if path in {
            "/.well-known/oauth-authorization-server",
            "/.well-known/openid-configuration",
        }:
            if (
                fault == "no_as"
                or fault == "oidc"
                and path.endswith("oauth-authorization-server")
            ):
                return httpx.Response(404)
            return httpx.Response(
                200,
                json={
                    "issuer": config.issuer
                    if fault != "as_issuer"
                    else "https://wrong.test",
                    "authorization_endpoint": config.issuer + "/authorize",
                    "token_endpoint": config.issuer + "/token"
                    if fault != "endpoint"
                    else "https://wrong.test/token",
                    "response_types_supported": ["code"],
                    "code_challenge_methods_supported": ["S256"]
                    if fault != "pkce"
                    else ["plain"],
                    "registration_endpoint": config.issuer + "/register",
                },
            )
        if path == "/token":
            data = parse_qs(request.content.decode())
            assert data["resource"] == [config.server_url] and data["client_id"] == [
                "registered"
            ]
            if data["grant_type"] == ["authorization_code"]:
                assert (
                    data["redirect_uri"] == [config.redirect_uri]
                    and len(data["code_verifier"][0]) >= 43
                )
            if fault == "exchange":
                return httpx.Response(400)
            return httpx.Response(
                200,
                json={
                    "access_token": "synthetic-access",
                    "refresh_token": "synthetic-refresh",
                    "token_type": "Bearer",
                    "expires_in": 300,
                    "scope": "read" if fault != "scope" else "admin",
                },
            )
        pytest.fail(f"Unexpected request: {request.method} {request.url}")

    constructor = httpx.AsyncClient
    monkeypatch.setattr(
        addon_host.httpx,
        "AsyncClient",
        lambda **kwargs: constructor(transport=httpx.MockTransport(handle), **kwargs),
    )
    return requests


@pytest.mark.parametrize("fault", [None, "oidc"])
def test_oauth_discovery_pkce_refresh_no_registration(monkeypatch, fault):
    requests = fixture(monkeypatch, fault)

    async def run():
        session = OAuthSession(configured())
        url = await session.begin()
        query = parse_qs(urlsplit(url).query)
        assert query["code_challenge_method"] == ["S256"]
        await session.complete(query["state"][0], "synthetic-code")
        assert await session.token() == "synthetic-access"
        assert "synthetic" not in repr(session)
        session._received -= 300
        assert (
            await asyncio.gather(session.token(), session.token())
            == ["synthetic-access"] * 2
        )
        exchanges = [r for r in requests if r.method == "POST"]
        assert len(exchanges) == 2
        assert all(r.url.path == "/token" for r in exchanges)
        with pytest.raises(ValueError):
            await session.complete(query["state"][0], "synthetic-code")
        with pytest.raises(ValueError):
            async with connect_mcp("https://different.test/mcp", oauth=session):
                pytest.fail("Must reject endpoint before connection")

    asyncio.run(run())


@pytest.mark.parametrize(
    "fault",
    [
        "missing",
        "metadata_error",
        "resource",
        "issuer",
        "as_issuer",
        "endpoint",
        "pkce",
        "no_as",
    ],
)
def test_discovery_fails_closed(monkeypatch, fault):
    requests = fixture(monkeypatch, fault)

    async def run():
        with pytest.raises((ValueError, httpx.HTTPError, OAuthFlowError)):
            await OAuthSession(configured()).begin()
        assert not any(r.method == "POST" for r in requests)

    asyncio.run(run())


@pytest.mark.parametrize(
    "fault", ["wrong_state", "expired", "denied", "exchange", "scope"]
)
def test_callback_failure_and_refresh_revocation(monkeypatch, fault):
    requests = fixture(monkeypatch, fault)

    async def run():
        session = OAuthSession(configured())
        url = await session.begin()
        state = parse_qs(urlsplit(url).query)["state"][0]
        if fault == "expired":
            s, verifier, at = session._pending
            session._pending = s, verifier, at - 301
        with pytest.raises((ValueError, httpx.HTTPError, OAuthFlowError)):
            await session.complete(
                "wrong" if fault == "wrong_state" else state,
                "" if fault == "denied" else "code",
            )
        assert session.tokens is None
        if fault in {"wrong_state", "expired", "denied"}:
            assert not any(r.method == "POST" for r in requests)
        with pytest.raises(ValueError):
            await session.token()

    asyncio.run(run())


@pytest.mark.parametrize(
    "url",
    [
        "http://remote.test/mcp",
        "https://user:password@example.test",
        "https://example.test/#fragment",
        "file:///tmp/mcp",
    ],
)
def test_unsafe_configuration(url):
    with pytest.raises(ValueError):
        OAuthConfig(url, "https://issuer.test", "id", "http://127.0.0.1/callback")


def test_explicit_port_is_not_default_origin():
    session = OAuthSession(configured())
    with pytest.raises(ValueError, match="configured origin"):
        session._endpoint("https://issuer.test/token", "https://issuer.test:0")


def test_refresh_retains_optional_token_and_failure_removes_authority(monkeypatch):
    fixture(monkeypatch)

    async def run():
        session = OAuthSession(configured())
        url = await session.begin()
        await session.complete(parse_qs(urlsplit(url).query)["state"][0], "code")
        original = session._exchange

        async def refresh(data):
            result = await original(data)
            return result.model_copy(update={"refresh_token": None})

        monkeypatch.setattr(session, "_exchange", refresh)
        session._received -= 300
        await session.token()
        assert session.tokens.refresh_token == "synthetic-refresh"

        async def revoked(data):
            raise ValueError("revoked")

        monkeypatch.setattr(session, "_exchange", revoked)
        session._received -= 300
        with pytest.raises(ValueError, match="revoked"):
            await session.token()
        assert session.tokens is None

    asyncio.run(run())


def test_connect_uses_sdk_and_forwards_elicitation(monkeypatch):
    from contextlib import asynccontextmanager

    calls = []

    @asynccontextmanager
    async def transport(url, *, http_client):
        assert url == configured().server_url
        assert "authorization" not in http_client.headers
        yield "read", "write", None

    class Client:
        def __init__(self, read, write, *, elicitation_callback):
            assert (read, write, elicitation_callback) == ("read", "write", callback)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def initialize(self):
            calls.append("initialize")

    async def callback(*args):
        pass

    monkeypatch.setattr(addon_host, "streamable_http_client", transport)
    monkeypatch.setattr(addon_host, "ClientSession", Client)

    async def run():
        async with connect_mcp(configured().server_url, elicitation_callback=callback):
            assert calls == ["initialize"]

    asyncio.run(run())
