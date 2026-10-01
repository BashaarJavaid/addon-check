import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { McpAppFrame, Transcript, useVoice, type TranscriptEvent } from "addon-host";
import "addon-host/style.css";
import "./style.css";

type Scalar = { type: string; title?: string; enum?: (string | number)[]; default?: string | number | boolean };
type Prompt = { id: string; message: string; schema: { properties: Record<string, Scalar>; required?: string[] } };
type Receipt = { id: string; result?: NonNullable<TranscriptEvent["result"]>; card?: string; arguments?: Record<string, unknown>; error?: string };
type Session = { csrf: string; oauth: boolean; linked: boolean; busy: boolean; prompt: Prompt | null; events: (TranscriptEvent & { background?: boolean })[]; receipt: Receipt | null };
type Tool = { name: string; description?: string; inputSchema: { properties?: Record<string, Scalar> } };

function Host() {
  const [session, setSession] = useState<Session>(), [tools, setTools] = useState<Tool[]>([]), [name, setName] = useState(""), [args, setArgs] = useState("{}"), [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("dark"), [mode, setMode] = useState("show"), [voice, setVoice] = useState(false), [field, setField] = useState("");
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const promptRef = useRef<HTMLElement>(null), current = useRef<Session | undefined>(undefined), seen = useRef(new Set<string>()), initialized = useRef(false);
  const voiceEnabled = useRef(voice); voiceEnabled.current = voice;
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Addon-CSRF": current.current?.csrf ?? "" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw Error(`Request refused (${response.status}). Check linking or the pending prompt.`);
    return await response.json() as T;
  }
  async function safely(action: () => Promise<void>) { try { setError(""); await action(); } catch (e) { setError(String(e)); } }
  const { listening, listen, stop, speak } = useVoice({ onError: setError, onText: text => {
    const prompt = current.current?.prompt;
    if (prompt) {
      const normalized = text.toLowerCase().replace(/[.!?]/g, "").trim();
      if (["no", "decline", "cancel"].includes(normalized)) { void safely(() => answer(normalized === "cancel" ? "cancel" : "decline")); return; }
      const props = Object.entries(prompt.schema.properties);
      if (props.length !== 1) { setError("Use the response form for multiple fields."); return; }
      const [key, prop] = props[0];
      const value = prop.type === "boolean" ? ["yes", "confirm", "yes confirm"].includes(normalized) : ["integer", "number"].includes(prop.type) ? Number(normalized) : text;
      if (prop.type === "boolean" && !value || typeof value === "number" && !Number.isFinite(value)) { setError("Say yes, no, or the requested value."); return; }
      void safely(() => answer("accept", { [key]: value }));
    } else {
      if (!field) { setError("Select a string field before speaking."); return; }
      try { setArgs(JSON.stringify({ ...JSON.parse(args), [field]: text }, null, 2)); }
      catch { setError("Enter valid JSON arguments first."); }
    }
  }});
  useEffect(() => {
    let closed = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await request<Session>("session");
        if (closed) return;
        current.current = next; setSession(next);
        for (const event of next.events) {
          if (!seen.current.has(event.id) && initialized.current && voiceEnabled.current && event.kind === "tool" && !event.background && event.text) speak(event.text);
          seen.current.add(event.id);
        }
        initialized.current = true;
      } catch (e) { if (!closed) setError(String(e)); }
      if (!closed) timer = setTimeout(() => void poll(), 300);
    }
    void poll();
    return () => { closed = true; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const prompt = session?.prompt;
    setValues(Object.fromEntries(Object.entries(prompt?.schema.properties ?? {}).map(([key, p]) => [key, p.default ?? (p.type === "boolean" ? false : "")])));
    if (prompt) { promptRef.current?.focus(); if (voiceEnabled.current) speak(prompt.message); }
  }, [session?.prompt?.id]);
  async function answer(action: string, content = values) { await request("answer", { id: current.current?.prompt?.id, action, content }); }
  async function discover() { const list = await request<Tool[]>("tools"); setTools(list); setName(list[0]?.name ?? ""); }
  async function call(tool: string, arguments_: Record<string, unknown>, background = false) {
    const started = await request<{ id: string }>("call", { name: tool, arguments: arguments_, background });
    // A pending human review may take five minutes. Never resubmit on interruption.
    for (let i = 0; i < 1300; i++) {
      const next = await request<Session>("session");
      if (!next.busy && next.receipt?.id === started.id) {
        if (!next.receipt.result) throw Error(next.receipt.error);
        return next.receipt.result;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw Error("Call is still unresolved. Check the server before submitting again.");
  }
  const prompt = session?.prompt, receipt = session?.receipt;
  const properties = tools.find(t => t.name === name)?.inputSchema.properties ?? {};
  return <main className={theme}><h1>Add-on host</h1><p>Local MCP test host · explicit tool calls · no model · self-contained cards only</p>
    {error && <p role="alert">{error}</p>}<div className="controls">
      {session?.oauth && <button onClick={() => void safely(async () => { const result = await request<{ url: string }>("link", {}); window.location.assign(result.url); })}>{session.linked ? "Relink" : "Link with consent"}</button>}
      <button disabled={!session?.linked || session.busy} onClick={() => void safely(discover)}>Discover tools</button>
      <label>Display<select value={mode} onChange={e => { stop(); setMode(e.target.value); }}><option value="show">Echo Show</option><option value="dot">Echo Dot · voice only</option></select></label>
      <label>Theme<select value={theme} onChange={e => setTheme(e.target.value as "light" | "dark")}><option>dark</option><option>light</option></select></label>
      <label><input type="checkbox" checked={voice} onChange={e => { setVoice(e.target.checked); if (!e.target.checked) stop(); }} />Speak responses</label>
    </div><div className="sim-layout"><section><div className="sim-display">{mode === "show" && receipt?.card && receipt.result ? <McpAppFrame key={receipt.id} url={receipt.card} args={receipt.arguments} result={receipt.result} theme={theme} callTool={params => call(params.name, params.arguments ?? {}, true)} /> : <div className="sim-empty"><div className="sim-orb" aria-hidden="true" /><p>{mode === "dot" ? "Voice-only mode. No card is mounted." : "Run a tool to display its card."}</p></div>}</div>
    {prompt && <section aria-label="Pending question" tabIndex={-1} ref={promptRef}><h2>Review request</h2><pre>{prompt.message}</pre><form onSubmit={e => { e.preventDefault(); void safely(() => answer("accept")); }}>{Object.entries(prompt.schema.properties).map(([key, p]) => <label key={key}>{p.title ?? key}{p.enum ? <select value={String(values[key] ?? "")} onChange={e => setValues({ ...values, [key]: p.type === "integer" || p.type === "number" ? Number(e.target.value) : e.target.value })}><option value="">Choose</option>{p.enum.map(v => <option key={v}>{v}</option>)}</select> : <input type={p.type === "boolean" ? "checkbox" : ["integer", "number"].includes(p.type) ? "number" : "text"} checked={p.type === "boolean" ? values[key] === true : undefined} value={p.type === "boolean" ? undefined : String(values[key] ?? "")} onChange={e => setValues({ ...values, [key]: p.type === "boolean" ? e.target.checked : ["integer", "number"].includes(p.type) ? Number(e.target.value) : e.target.value })} />}</label>)}<div className="controls"><button>Submit response</button>{["decline", "cancel"].map(action => <button type="button" key={action} onClick={() => void safely(() => answer(action))}>{action}</button>)}</div></form></section>}
    <form onSubmit={e => { e.preventDefault(); void safely(async () => { await call(name, JSON.parse(args)); }); }}><label>Tool<select value={name} onChange={e => { setName(e.target.value); setField(""); }}>{tools.map(t => <option key={t.name}>{t.name}</option>)}</select></label><label>Arguments (JSON)<textarea value={args} onChange={e => setArgs(e.target.value)} /></label><button disabled={!name || session?.busy}>Review call</button></form>
    <div className="controls"><label>Voice string field<select value={field} onChange={e => setField(e.target.value)}><option value="">Choose a field</option>{Object.entries(properties).filter(([, p]) => p.type === "string").map(([key]) => <option key={key}>{key}</option>)}</select></label><button onClick={listen}>{listening ? "Finish listening" : "Push to talk"}</button></div></section><Transcript events={session?.events ?? []} /></div></main>;
}
createRoot(document.getElementById("root")!).render(<Host />);
