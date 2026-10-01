"""Small server-side primitives. Browser sessions and execution consent belong to hosts."""

import asyncio
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from urllib.parse import urlencode, urlsplit

import httpx
from mcp import ClientSession
from mcp.client.auth.oauth2 import PKCEParameters
from mcp.client.auth.utils import (
    build_oauth_authorization_server_metadata_discovery_urls,
    build_protected_resource_metadata_discovery_urls,
    extract_resource_metadata_from_www_auth,
    extract_scope_from_www_auth,
    handle_auth_metadata_response,
    handle_protected_resource_response,
    validate_metadata_issuer,
)
from mcp.client.session import ElicitationFnT
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthMetadata, OAuthToken

__all__ = ["OAuthConfig", "OAuthSession", "connect_mcp"]


def _origin(url: str) -> tuple[str, str | None, int | None]:
    parsed = urlsplit(url)
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or not (
            parsed.scheme == "https"
            or parsed.scheme == "http"
            and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        )
    ):
        raise ValueError(
            "Use HTTPS or an HTTP loopback URL without credentials or fragments"
        )
    return (
        parsed.scheme,
        parsed.hostname,
        parsed.port
        if parsed.port is not None
        else (443 if parsed.scheme == "https" else 80),
    )


@dataclass(frozen=True)
class OAuthConfig:
    server_url: str
    issuer: str
    client_id: str
    redirect_uri: str
    scopes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for url in (self.server_url, self.issuer, self.redirect_uri):
            _origin(url)
        if not self.client_id or urlsplit(self.issuer).query:
            raise ValueError("Configure a client ID and an issuer without a query")


@dataclass(repr=False)
class OAuthSession:
    """One linked principal; credentials are never serialized to a browser.

    Discovery uses the pinned MCP SDK's RFC 9728/RFC 8414/OIDC helpers.
    v0.1 supports pre-registered public clients and configured origins only.
    No dynamic registration, persistent tokens or automatic tool retries.
    """

    config: OAuthConfig
    tokens: OAuthToken | None = field(default=None, repr=False)
    _received: float = field(default_factory=time.monotonic, repr=False)
    _metadata: OAuthMetadata | None = field(default=None, repr=False)
    _pending: tuple[str, str, float] | None = field(default=None, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def _endpoint(self, url: str, base: str) -> str:
        if _origin(url) != _origin(base):
            raise ValueError("Discovered endpoint is outside its configured origin")
        return url

    async def _discover(self, http: httpx.AsyncClient) -> OAuthMetadata:
        config = self.config
        async with http.stream("GET", config.server_url) as challenge:
            if challenge.status_code not in (200, 400, 401, 403, 405, 406):
                challenge.raise_for_status()
            challenged = extract_scope_from_www_auth(challenge)
            if challenged and not set(challenged.split()).issubset(config.scopes):
                raise ValueError(
                    "The server requires scopes outside the configured registration"
                )
            urls = build_protected_resource_metadata_discovery_urls(
                extract_resource_metadata_from_www_auth(challenge), config.server_url
            )
        for url in urls:
            response = await http.get(self._endpoint(url, config.server_url))
            if response.status_code != 404:
                response.raise_for_status()
            resource = await handle_protected_resource_response(response)
            if resource is not None:
                if str(resource.resource).rstrip("/") != config.server_url.rstrip("/"):
                    raise ValueError(
                        "Protected resource does not match the configured MCP endpoint"
                    )
                if config.issuer.rstrip("/") not in {
                    str(issuer).rstrip("/") for issuer in resource.authorization_servers
                }:
                    raise ValueError(
                        "Protected resource does not name the configured issuer"
                    )
                break
        else:
            raise ValueError("Protected resource metadata unavailable")
        for url in build_oauth_authorization_server_metadata_discovery_urls(
            config.issuer, config.server_url
        ):
            response = await http.get(self._endpoint(url, config.issuer))
            if response.status_code != 404:
                response.raise_for_status()
            _, metadata = await handle_auth_metadata_response(response)
            if metadata is not None:
                validate_metadata_issuer(metadata, config.issuer)
                self._endpoint(str(metadata.authorization_endpoint), config.issuer)
                self._endpoint(str(metadata.token_endpoint), config.issuer)
                if "S256" not in (metadata.code_challenge_methods_supported or []):
                    raise ValueError("Issuer must support PKCE S256")
                return metadata
        raise ValueError("Authorization server metadata unavailable")

    async def begin(self) -> str:
        """Return the consent URL. A new attempt invalidates the previous state."""
        self._pending = None
        async with httpx.AsyncClient(trust_env=False, follow_redirects=False) as http:
            self._metadata = await self._discover(http)
        pkce, state = PKCEParameters.generate(), secrets.token_urlsafe(32)
        self._pending = state, pkce.code_verifier, time.monotonic()
        params = {
            "response_type": "code",
            "client_id": self.config.client_id,
            "redirect_uri": self.config.redirect_uri,
            "resource": self.config.server_url,
            "scope": " ".join(self.config.scopes),
            "state": state,
            "code_challenge": pkce.code_challenge,
            "code_challenge_method": "S256",
        }
        endpoint = str(self._metadata.authorization_endpoint)
        return endpoint + ("&" if "?" in endpoint else "?") + urlencode(params)

    async def _exchange(self, data: dict[str, str]) -> OAuthToken:
        if self._metadata is None:
            raise ValueError("Begin OAuth before exchanging tokens")
        async with httpx.AsyncClient(trust_env=False, follow_redirects=False) as http:
            response = await http.post(
                str(self._metadata.token_endpoint),
                data=data
                | {
                    "client_id": self.config.client_id,
                    "resource": self.config.server_url,
                },
            )
            response.raise_for_status()
            tokens = OAuthToken.model_validate(response.json())
        if (
            tokens.token_type.casefold() != "bearer"
            or tokens.expires_in is None
            or tokens.expires_in <= 0
        ):
            raise ValueError("Issuer must supply an expiring bearer token")
        if tokens.scope and not set(tokens.scope.split()).issubset(self.config.scopes):
            raise ValueError("Issuer returned unconfigured scopes")
        self._received = time.monotonic()
        return tokens

    async def complete(self, state: str, code: str) -> None:
        """Consume one callback. The host must also bind it to its browser session."""
        pending, self._pending = self._pending, None
        if (
            pending is None
            or not secrets.compare_digest(state, pending[0])
            or time.monotonic() - pending[2] >= 300
            or not code
        ):
            raise ValueError("OAuth callback is invalid or expired")
        self.tokens = await self._exchange(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": pending[1],
                "redirect_uri": self.config.redirect_uri,
            }
        )

    async def token(self) -> str:
        """Refresh once under a lock; failure removes authority until relinking."""
        async with self._lock:
            if self.tokens is None:
                raise ValueError("Link this connection first")
            if time.monotonic() - self._received >= (self.tokens.expires_in or 0) - 30:
                old, self.tokens = self.tokens, None
                if not old.refresh_token:
                    raise ValueError("Token expired; link again")
                self.tokens = await self._exchange(
                    {"grant_type": "refresh_token", "refresh_token": old.refresh_token}
                )
                if self.tokens.refresh_token is None:
                    self.tokens = self.tokens.model_copy(
                        update={"refresh_token": old.refresh_token}
                    )
            return self.tokens.access_token


@asynccontextmanager
async def connect_mcp(
    server_url: str,
    *,
    oauth: OAuthSession | None = None,
    elicitation_callback: ElicitationFnT | None = None,
) -> AsyncIterator[ClientSession]:
    """Open one initialized Streamable HTTP session; execute only caller requests."""
    _origin(server_url)
    if oauth is not None and server_url != oauth.config.server_url:
        raise ValueError("OAuth credentials belong to a different MCP endpoint")
    headers = {"Authorization": "Bearer " + await oauth.token()} if oauth else {}
    async with httpx.AsyncClient(
        headers=headers, trust_env=False, follow_redirects=False, timeout=360
    ) as http:
        async with streamable_http_client(server_url, http_client=http) as (
            read,
            write,
            _,
        ):
            async with ClientSession(
                read, write, elicitation_callback=elicitation_callback
            ) as client:
                await client.initialize()
                yield client
