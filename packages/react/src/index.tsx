import { useCallback, useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

type ToolResult = Parameters<AppBridge["sendToolResult"]>[0];
type ToolCall = Parameters<NonNullable<AppBridge["oncalltool"]>>[0];

export function McpAppFrame({ url, args = {}, result, theme, callTool, title = "MCP App card", name = "Add-on host" }: {
  url: string; args?: Record<string, unknown>; result?: ToolResult;
  theme: "light" | "dark"; callTool: (call: ToolCall) => Promise<ToolResult>;
  title?: string; name?: string;
}) {
  const iframe = useRef<HTMLIFrameElement>(null), container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const active = useRef<AppBridge | null>(null);
  const current = useRef({ args, result, theme, callTool });
  current.current = { args, result, theme, callTool };
  useEffect(() => {
    setError("");
    const frame = iframe.current!;
    const bridge = new AppBridge(null, { name, version: "0.1.0" }, { serverTools: {} }, {
      hostContext: { theme: current.current.theme, displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], locale: "en-US", containerDimensions: { width: 1280, height: 800 } },
    });
    active.current = bridge;
    bridge.oninitialized = () => { void (async () => {
      await bridge.sendToolInput({ arguments: current.current.args });
      if (current.current.result) await bridge.sendToolResult(current.current.result);
    })().catch(() => setError("Card initialization failed. The text result remains available.")); };
    bridge.oncalltool = params => current.current.callTool(params);
    bridge.onrequestdisplaymode = async ({ mode }) => {
      bridge.setHostContext({ displayMode: mode });
      container.current?.classList.toggle("expanded", mode === "fullscreen");
      return { mode };
    };
    const size = new ResizeObserver(() => bridge.setHostContext({ containerDimensions: { width: frame.clientWidth, height: frame.clientHeight } }));
    size.observe(frame);
    let closed = false;
    void bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!))
      .then(() => { if (!closed) frame.src = url; })
      .catch(() => { if (!closed) setError("Card bridge unavailable."); });
    return () => { closed = true; size.disconnect(); active.current = null; void bridge.close(); };
  }, [url, name]);
  useEffect(() => { active.current?.setHostContext({ theme }); }, [theme]);
  return <div className="sim-frame" ref={container}>{error && <p role="alert">{error}</p>}<iframe ref={iframe} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" /></div>;
}

export type TranscriptEvent = {
  id: string; kind: string; text?: string; tool?: string;
  elapsed_ms?: number; waiting_ms?: number; processing_ms?: number; prompt_latency_ms?: number;
  status?: string; prompt?: { message: string }; result?: ToolResult;
};

export function Transcript({ events }: { events: readonly TranscriptEvent[] }) {
  return <aside className="sim-transcript" aria-label="Conversation and tool transcript" aria-live="polite"><h2>Conversation</h2>
    {events.filter(e => e.kind !== "settled").map(e => <article key={e.id}>
      <small>{e.tool ?? e.kind}{e.kind === "wait" ? ` · ${e.waiting_ms} ms human wait` : ""}{e.prompt_latency_ms != null ? ` · ${e.prompt_latency_ms} ms to question` : ""}{e.status ? ` · ${e.status}` : ""}{e.elapsed_ms !== undefined ? ` · ${e.processing_ms ?? e.elapsed_ms} ms processing · ${e.waiting_ms ?? 0} ms waiting` : ""}</small>
      <p>{e.text ?? e.prompt?.message}</p>
      {e.result && <details><summary>Response details</summary><pre>{JSON.stringify(e.result.structuredContent ?? e.result.content, null, 2)}</pre></details>}
    </article>)}
  </aside>;
}

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((event: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
};

export function useVoice({ onText, onError }: { onText: (text: string) => void; onError: (message: string) => void }) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const handlers = useRef({ onText, onError }); handlers.current = { onText, onError };
  const stop = useCallback(() => {
    const old = recognition.current; recognition.current = null;
    if (old) { old.onresult = null; old.onerror = null; old.onend = null; old.abort(); }
    window.speechSynthesis?.cancel(); setListening(false);
  }, []);
  useEffect(() => stop, [stop]);
  const speak = useCallback((text: string) => {
    stop();
    if (!("speechSynthesis" in window) || !text) return;
    const line = new SpeechSynthesisUtterance(text); line.lang = "en-US";
    line.voice = window.speechSynthesis.getVoices().find(v => v.lang === "en-US") ?? window.speechSynthesis.getVoices().find(v => v.lang.startsWith("en")) ?? null;
    window.speechSynthesis.speak(line);
  }, [stop]);
  function listen() {
    if (listening) { recognition.current?.stop(); return; }
    const api = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Constructor = api.SpeechRecognition ?? api.webkitSpeechRecognition;
    if (!Constructor) { handlers.current.onError("Speech recognition is unavailable. Type your request below."); return; }
    stop();
    const r = new Constructor(); recognition.current = r;
    r.lang = "en-US"; r.continuous = false; r.interimResults = false;
    r.onresult = event => {
      if (recognition.current !== r) return;
      const text = Array.from(event.results).filter(v => v.isFinal).map(v => v[0].transcript).join(" ");
      if (text) handlers.current.onText(text);
    };
    r.onerror = () => { setListening(false); handlers.current.onError("Microphone unavailable. Typed input remains available."); };
    r.onend = () => setListening(false);
    try { r.start(); setListening(true); }
    catch { setListening(false); handlers.current.onError("Microphone unavailable. Typed input remains available."); }
  }
  return { listening, listen, stop, speak };
}
