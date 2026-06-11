// ================= IMPL-V6 — MCP-over-SSE SERVER ENTRY (V6.2) =================
//
// The single process OpenClaw connects to (SKILL.md: "stock OpenClaw over
// MCP-SSE … single process"). railway.json health-checks GET /health.
//
// V6.2 SCOPE: register exactly ONE tool — verify_lei_gleif. The LangGraph
// orchestrator and remaining tools land in V6.3+ (README build table). This
// file is the stable seam they plug into: add tools to TOOL_REGISTRY, and (once
// the graph exists) invoke it from inside a tool handler here.
//
// API GROUNDING (read from the installed SDK, NOT memory — userPreferences R4):
//   node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts
//     - new McpServer(serverInfo, options?)
//     - server.registerTool(name, { title, description, inputSchema }, cb)
//       · inputSchema is a Zod RAW SHAPE (z.object(...).shape), not the object
//       · cb receives the parsed args object + returns a CallToolResult
//     - server.connect(transport) starts the transport (do NOT call start() too)
//   node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.d.ts
//     - new SSEServerTransport(postEndpoint, res)  → .sessionId, .handlePostMessage(req,res)
//     - SSEServerTransport is @deprecated in 1.29 in favor of StreamableHTTP;
//       used deliberately here because OpenClaw expects the SSE endpoint.
//
// UNPINNED-BY-DOCS (flagged): the SSE GET/POST paths and the listen PORT are not
// fixed by any design doc I read. Using SDK-conventional /sse + /messages and
// PORT=env.PORT??3000 (Railway injects PORT; 8080=ERPNext, 5000=GraphQL). These
// are named constants below — change freely if a locked-ports table says otherwise.

import http from "node:http";
import { pathToFileURL } from "node:url";
// Load .env at the entrypoint BEFORE loadFlags() reads process.env (flags.ts
// contract). dotenv/config applies at import time; flags are read later in main().
import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { loadFlags, type OrchestratorFlags } from "../config/flags.js";
import { TOOL_REGISTRY, type McpToolDescriptor } from "./tools/index.js";
import { appendToolCallAudit } from "./tool-audit.js";

// ── Constants (not env flags — see header) ───────────────────────────────────

const SERVER_NAME = "jupiterSellerAgent";
const SERVER_VERSION = "0.1.0"; // mirrors package.json
const SSE_PATH = "/sse"; // GET — establishes the SSE stream
const MESSAGES_PATH = "/messages"; // POST — client → server JSON-RPC
const HEALTH_PATH = "/health"; // GET — railway.json healthcheck
const PORT = Number(process.env.PORT ?? 3000);

// ── MCP server factory ───────────────────────────────────────────────────────

/**
 * Build a fresh McpServer with every tool in TOOL_REGISTRY registered.
 *
 * One server instance per SSE connection: McpServer.connect() takes ownership
 * of its transport (per the SDK docs), so concurrent clients each get their own
 * server + transport rather than sharing one.
 *
 * The descriptor → SDK mapping lives ONLY here (tools/index.ts stays SDK-agnostic):
 *   - inputSchema  → descriptor.inputSchema.shape (raw shape the SDK expects)
 *   - handler      → invoked with the validated input + resolved flags
 *   - result       → human summary (content[0]) + full ConsultationRecord JSON
 *   - audit        → routerLatencyMs + provenance row appended per call (INV-3)
 */
function buildMcpServer(flags: Readonly<OrchestratorFlags>): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of TOOL_REGISTRY) {
    registerOneTool(server, tool, flags);
  }

  return server;
}

function registerOneTool(
  server: McpServer,
  tool: McpToolDescriptor<any, any>,
  flags: Readonly<OrchestratorFlags>,
): void {
  // The SDK's registerTool wants a Zod raw shape. All V6 tool schemas are
  // ZodObjects; guard loudly rather than cast blindly (no silent assumptions).
  if (!(tool.inputSchema instanceof z.ZodObject)) {
    throw new Error(
      `[server-sse] tool "${tool.name}" inputSchema must be a ZodObject so its ` +
      `.shape can be passed to registerTool; got ${tool.inputSchema?.constructor?.name}`,
    );
  }
  const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: shape,
    },
    async (args: unknown) => {
      // Re-parse through the full schema: applies defaults (e.g. forceFresh) and
      // yields a properly-typed input even though the registry is typed `any`.
      const input = tool.inputSchema.parse(args);

      const started = Date.now();
      let out: any;
      let threw: unknown = null;
      try {
        out = await tool.handler(input, flags);
      } catch (err) {
        threw = err;
      }
      const routerLatencyMs = Date.now() - started;

      // ── Unexpected exception: audit + surface as an MCP error result ────────
      if (threw) {
        const message = threw instanceof Error ? threw.message : String(threw);
        appendToolCallAudit({
          ts: new Date().toISOString(),
          tool: tool.name,
          ok: false,
          routerLatencyMs,
          ref: typeof (input as any)?.lei === "string" ? (input as any).lei : undefined,
          error: message,
        });
        return {
          content: [{ type: "text" as const, text: `${tool.name} error: ${message}` }],
          isError: true,
        };
      }

      // ── Normal path (success OR defensive branch — both are valid outcomes) ─
      const meta = out?.metadata ?? {};
      appendToolCallAudit({
        ts: new Date().toISOString(),
        tool: tool.name,
        ok: Boolean(out?.success),
        routerLatencyMs,
        subAgent: meta.subAgent,
        dataMode: meta.dataMode,
        dataSource: meta.dataSource,
        ref: typeof (input as any)?.lei === "string" ? (input as any).lei : undefined,
        error: out?.success ? undefined : out?.error,
      });

      const summary = tool.summarize(out);
      return {
        content: [
          { type: "text" as const, text: summary },
          { type: "text" as const, text: JSON.stringify(out, null, 2) },
        ],
      };
    },
  );
}

// ── HTTP / SSE wiring ────────────────────────────────────────────────────────

/** Live SSE transports keyed by sessionId, so POST /messages can route. */
const transports = new Map<string, SSEServerTransport>();

export function createApp(flags: Readonly<OrchestratorFlags>): express.Express {
  const app = express();
  app.use(cors());
  // NOTE: deliberately NO express.json() — SSEServerTransport.handlePostMessage
  // consumes the raw request body itself on MESSAGES_PATH. A global json parser
  // would consume the stream first and break it.

  // Health — railway.json healthcheckPath. Returns 200 + a small status body.
  app.get(HEALTH_PATH, (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "mcp-sse",
      tools: TOOL_REGISTRY.map((t) => t.name),
      sseConnections: transports.size,
      credentialMode: flags.CREDENTIAL_MODE,
    });
  });

  // SSE stream: one McpServer + transport per connection.
  app.get(SSE_PATH, async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport(MESSAGES_PATH, res);
    transports.set(transport.sessionId, transport);

    res.on("close", () => {
      transports.delete(transport.sessionId);
    });

    const server = buildMcpServer(flags);
    // connect() starts the transport (writes SSE headers + endpoint event).
    await server.connect(transport);
  });

  // Client → server JSON-RPC messages, routed by sessionId.
  app.post(MESSAGES_PATH, async (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? "");
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: `no active SSE session for sessionId="${sessionId}"` });
      return;
    }
    await transport.handlePostMessage(req as unknown as http.IncomingMessage, res);
  });

  return app;
}

// ── Entrypoint ───────────────────────────────────────────────────────────────

function main(): void {
  // dotenv is loaded by the dev/start scripts' runtime; loadFlags reads process.env.
  const flags = loadFlags();
  const app = createApp(flags);

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[server-sse] ${SERVER_NAME} v${SERVER_VERSION} listening on :${PORT}\n` +
      `  SSE stream : GET  http://localhost:${PORT}${SSE_PATH}\n` +
      `  messages   : POST http://localhost:${PORT}${MESSAGES_PATH}?sessionId=...\n` +
      `  health     : GET  http://localhost:${PORT}${HEALTH_PATH}\n` +
      `  tools      : ${TOOL_REGISTRY.map((t) => t.name).join(", ")}\n` +
      `  CREDENTIAL_MODE=${flags.CREDENTIAL_MODE}  CREDIT_MODE=${flags.CREDIT_MODE}`,
    );
  });
}

// Run only when executed directly (not when imported by a test). pathToFileURL
// handles Windows drive paths/backslashes correctly (a hand-built file:// URL
// would not), so this fires under both `tsx src/...` and `node dist/...`.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main();
}
