"""Explicit local tool runner. Start with the configured target; never accepts URLs from cards."""

import argparse
import asyncio
import json
import secrets
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import jsonschema  # type: ignore[import-untyped]
import uvicorn
from addon_host import OAuthConfig, OAuthSession, connect_mcp
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from mcp import types
from pydantic import BaseModel, ConfigDict, Field
from referencing import Registry

CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts"


@dataclass
class Browser:
    csrf: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    oauth: OAuthSession | None = field(default=None, repr=False)
    events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=200))
    task: asyncio.Task[None] | None = None
    prompt: dict[str, Any] | None = None
    answer: asyncio.Future[dict[str, Any]] | None = None
    receipt: dict[str, Any] | None = None
    card: str | None = None

    def expired(self) -> bool:
        return (
            time.monotonic() - self.touched >= 1800
            or time.monotonic() - self.created >= 43200
        )


class Call(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    background: bool = False


class Answer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    action: Literal["accept", "decline", "cancel"]
    content: dict[str, str | int | float | bool] = Field(default_factory=dict)


def create_app(
    target: str, origin: str, oauth_config: OAuthConfig | None = None
) -> FastAPI:
    app = FastAPI()
    browsers: dict[str, Browser] = {}

    @app.middleware("http")
    async def guards(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if (
            request.headers.get("host") != urlsplit(origin).netloc
            or request.headers.get("sec-fetch-site") == "cross-site"
            and request.url.path != "/api/callback"
        ):
            return Response(status_code=403)
        if request.method == "POST" and request.headers.get("origin") != origin:
            return Response(status_code=403)
        if request.method == "POST":
            body = await request.body()
            if len(body) > 65536:
                return Response(status_code=413)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    def browser(request: Request, response: Response | None = None) -> Browser:
        for key, value in list(browsers.items()):
            if value.expired():
                if value.answer and not value.answer.done():
                    value.answer.set_result({"action": "cancel"})
                del browsers[key]
        key = request.cookies.get("addon_host", "")
        if key not in browsers:
            if response is None or len(browsers) >= 64:
                raise HTTPException(401, "Open the host again")
            key = secrets.token_urlsafe(32)
            browsers[key] = Browser(
                oauth=OAuthSession(oauth_config) if oauth_config else None
            )
            response.set_cookie(
                "addon_host", key, httponly=True, samesite="lax", max_age=43200
            )
        value = browsers[key]
        if request.method == "POST":
            if not secrets.compare_digest(
                request.headers.get("x-addon-csrf", ""), value.csrf
            ):
                raise HTTPException(403, "CSRF mismatch")
            value.touched = time.monotonic()
        return value

    async def ask(
        owner: Browser, message: str, schema: dict[str, Any]
    ) -> dict[str, Any]:
        if owner.expired():
            return {"action": "cancel"}
        owner.prompt = {
            "id": secrets.token_hex(16),
            "message": message,
            "schema": schema,
        }
        owner.answer = asyncio.get_running_loop().create_future()
        try:
            async with asyncio.timeout(300):
                answer = await owner.answer
            return {"action": "cancel"} if owner.expired() else answer
        except TimeoutError:
            return {"action": "cancel"}
        finally:
            owner.prompt = None
            owner.answer = None

    @app.get("/api/session")
    async def session(request: Request, response: Response) -> dict[str, Any]:
        owner = browser(request, response)
        return {
            "csrf": owner.csrf,
            "oauth": oauth_config is not None,
            "linked": owner.oauth is None or owner.oauth.tokens is not None,
            "busy": owner.task is not None and not owner.task.done(),
            "prompt": owner.prompt,
            "events": list(owner.events),
            "receipt": owner.receipt,
        }

    @app.post("/api/link")
    async def link(request: Request) -> dict[str, str]:
        owner = browser(request)
        if owner.oauth is None or owner.task and not owner.task.done():
            raise HTTPException(409, "OAuth unavailable or call still running")
        try:
            return {"url": await owner.oauth.begin()}
        except Exception:
            raise HTTPException(
                400, "OAuth discovery failed; check the configured registration"
            ) from None

    @app.get("/api/callback")
    async def callback(request: Request, state: str = "", code: str = "") -> Response:
        owner = browser(request)
        try:
            if owner.oauth is None:
                raise ValueError
            await owner.oauth.complete(state, code)
        except Exception:
            return RedirectResponse("/?link=failed")
        return RedirectResponse("/")

    @app.get("/api/tools")
    async def tools(request: Request) -> list[dict[str, Any]]:
        owner = browser(request)
        try:
            async with connect_mcp(target, oauth=owner.oauth) as client:
                return [
                    t.model_dump(mode="json", by_alias=True, exclude_none=True)
                    for t in (await client.list_tools()).tools
                ]
        except Exception:
            raise HTTPException(
                400, "Tool discovery failed; check linking and the configured server"
            ) from None

    async def execute(owner: Browser, call: Call, receipt_id: str) -> None:
        started = time.monotonic()
        waiting = 0.0

        async def question(message: str, schema: dict[str, Any]) -> dict[str, Any]:
            nonlocal waiting
            start = time.monotonic()
            try:
                return await ask(owner, message, schema)
            finally:
                waiting += time.monotonic() - start

        async def elicit(context: Any, params: Any) -> types.ElicitResult:
            schema = params.requestedSchema
            if any(
                p.get("type") not in {"string", "integer", "number", "boolean"}
                for p in schema.get("properties", {}).values()
            ):
                return types.ElicitResult(action="cancel")
            return types.ElicitResult(**await question(params.message, schema))

        try:
            async with connect_mcp(
                target, oauth=owner.oauth, elicitation_callback=elicit
            ) as client:
                catalog = {t.name: t for t in (await client.list_tools()).tools}
                tool = catalog[call.name]
                # Validate without fetching remote schema references.
                schema = tool.inputSchema
                if any(not str(value).startswith("#") for value in refs(schema)):
                    raise ValueError("External schema references unsupported")
                validator = jsonschema.validators.validator_for(schema)
                validator.check_schema(schema)
                validator(schema, registry=Registry()).validate(call.arguments)
                answer = await question(
                    "Review exact request: "
                    + call.name
                    + "\n"
                    + json.dumps(call.arguments, indent=2),
                    {
                        "type": "object",
                        "properties": {
                            "confirmed": {
                                "type": "boolean",
                                "title": "Submit this exact request?",
                            }
                        },
                        "required": ["confirmed"],
                    },
                )
                if answer.get("action") != "accept" or answer.get("content") != {
                    "confirmed": True
                }:
                    raise ValueError("Request not submitted")
                result = await client.call_tool(call.name, call.arguments)
                wire = result.model_dump(mode="json", by_alias=True, exclude_none=True)
                owner.receipt = {
                    "id": receipt_id,
                    "result": wire,
                    "arguments": call.arguments,
                }
                text = " ".join(
                    c.text for c in result.content if isinstance(c, types.TextContent)
                )
                owner.events.append(
                    {
                        "id": receipt_id,
                        "kind": "tool",
                        "tool": call.name,
                        "text": text,
                        "background": call.background,
                        "result": wire,
                        "elapsed_ms": round((time.monotonic() - started) * 1000),
                        "waiting_ms": round(waiting * 1000),
                        "processing_ms": round(
                            (time.monotonic() - started - waiting) * 1000
                        ),
                    }
                )
                uri = (tool.meta or {}).get("ui", {}).get("resourceUri")
                owner.card = None
                if uri:
                    try:
                        resource = await client.read_resource(uri)
                        html = next(
                            c
                            for c in resource.contents
                            if isinstance(c, types.TextResourceContents)
                            and c.mimeType == "text/html;profile=mcp-app"
                        )
                        csp = (html.meta or {}).get("ui", {}).get("csp", {})
                        if csp.get("resourceDomains") or csp.get("connectDomains"):
                            raise ValueError("Networked cards unsupported")
                        owner.card = html.text
                        owner.receipt["card"] = "/api/card/" + receipt_id
                    except Exception:
                        owner.events.append(
                            {
                                "id": secrets.token_hex(16),
                                "kind": "error",
                                "text": "Card unavailable or requires unsupported network access. The actual tool receipt remains above.",
                            }
                        )
        except Exception:
            if not owner.receipt or owner.receipt["id"] != receipt_id:
                owner.receipt = {
                    "id": receipt_id,
                    "error": "Call stopped or refused. No automatic retry was made; check the server before resubmitting.",
                }
                owner.events.append(
                    {"id": receipt_id, "kind": "error", "text": owner.receipt["error"]}
                )

    @app.post("/api/call")
    async def call(value: Call, request: Request) -> dict[str, str]:
        owner = browser(request)
        if owner.task and not owner.task.done():
            raise HTTPException(409, "A call is already running")
        key = secrets.token_hex(16)
        owner.task = asyncio.create_task(execute(owner, value, key))
        return {"id": key}

    @app.post("/api/answer")
    async def answer(value: Answer, request: Request) -> dict[str, str]:
        owner = browser(request)
        if (
            not owner.prompt
            or owner.prompt["id"] != value.id
            or owner.answer is None
            or owner.answer.done()
        ):
            raise HTTPException(409, "Prompt expired")
        if value.action == "accept":
            try:
                jsonschema.Draft202012Validator(
                    owner.prompt["schema"], registry=Registry()
                ).validate(value.content)
            except jsonschema.ValidationError:
                raise HTTPException(422, "Supply the requested scalar values") from None
        owner.answer.set_result(
            {
                "action": value.action,
                "content": value.content if value.action == "accept" else None,
            }
        )
        return {"status": "accepted"}

    @app.get("/api/card/{receipt_id}")
    async def card(receipt_id: str, request: Request) -> Response:
        owner = browser(request)
        if not owner.card or not owner.receipt or owner.receipt["id"] != receipt_id:
            raise HTTPException(404)
        return Response(
            owner.card, media_type="text/html", headers={"Content-Security-Policy": CSP}
        )

    app.mount(
        "/", StaticFiles(directory=Path(__file__).parent / "dist", html=True), name="ui"
    )
    return app


def refs(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return ([value[k] for k in ("$ref", "$dynamicRef") if k in value]) + [
            r for v in value.values() for r in refs(v)
        ]
    if isinstance(value, list):
        return [r for v in value for r in refs(v)]
    return []


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--issuer")
    parser.add_argument("--client-id")
    parser.add_argument("--scope", action="append", default=[])
    args = parser.parse_args()
    origin = f"http://127.0.0.1:{args.port}"
    if bool(args.issuer) != bool(args.client_id):
        parser.error("--issuer and --client-id are required together")
    config = (
        OAuthConfig(
            server_url=args.server,
            issuer=args.issuer,
            client_id=args.client_id,
            redirect_uri=origin + "/api/callback",
            scopes=tuple(args.scope),
        )
        if args.issuer
        else None
    )
    uvicorn.run(
        create_app(args.server, origin, config),
        host="127.0.0.1",
        port=args.port,
        access_log=False,
    )
