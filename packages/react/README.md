# addon-host

React 19.2.0 components extracted from Hirz's local simulator. Apache-2.0.
Node 24 builds; the consumer bundles for its target browser (Hirz uses Safari 15.4).
Install `addon-host`, `react@19.2.0` and `react-dom@19.2.0`. React peers are exact
because this is the tested v0.1 combination.

```tsx
import { McpAppFrame, Transcript, useVoice } from "addon-host";
import "addon-host/style.css";

<McpAppFrame
  url={sameOriginCardUrl}
  args={reviewedArguments}
  result={actualMcpResult}
  theme="dark"
  callTool={reviewAndCallThroughBackend}
/>
```

Place the frame inside `.sim-display`. Its logical canvas is 1280×800, and its
user-requested fullscreen dimensions follow the actual iframe. A `.sim-layout`
container gives the frame a 280-pixel transcript rail that stacks on narrow screens.
For voice-only mode, do not mount `McpAppFrame`; keep your text/voice controls and
`<Transcript events={events} />` available. Light/dark host styling can set
`--host-muted-text` and `--host-canvas`. Theme is also sent to the card.

`McpAppFrame` takes `url`, optional SDK `args`/`result`, `theme`, `callTool` and
optional `title`/host `name`. Remount with a receipt key when a new result arrives.
It forwards SDK messages through `AppBridge`; it never receives credentials.
The host must serve card HTML with a no-network CSP and review calls before
executing its callback. The opaque iframe uses `sandbox="allow-scripts"`. External
network/assets, links and model messages are not supported host capabilities.

`Transcript` accepts events with `id`, `kind`, optional text/tool/status, timing,
prompt message and SDK result; it displays actual results in collapsed details.
It does not derive a domain status or narrate JSON.

`useVoice({ onText, onError })` returns `listening`, `listen`, `stop`, `speak`.
US-English recognition has a text fallback. Recognition interrupts synthesis and
synthesis interrupts recognition. Call `stop` on account/turn changes and pass
only foreground, non-replayed approved text to `speak`; the consumer owns identity
and event transport. The hook stops voice activity on unmount.

See the [standalone example](../../examples/host/README.md) for a complete consumer
without Hirz. Browser verification uses the official get-time MCP App, not a Hirz
card or fabricated tool result.
