// Unmodified official fixture, pinned by package-lock.json to ext-apps v2.0.0.
import { createServer } from "@modelcontextprotocol/server-basic-vanillajs";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
const app = createMcpExpressApp({ host: "127.0.0.1" });
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.all("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch { if (!res.headersSent) res.status(500).end(); }
});
app.listen(Number(process.env.PORT ?? 3001), "127.0.0.1");
