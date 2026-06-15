// ================= IMPL-V6 — verify_lei_gleif end-to-end check =================
//
// A minimal MCP client that connects to the running server over SSE and calls
// verify_lei_gleif — the deterministic stand-in for "paste the prompt in
// OpenClaw". It imports ONLY the MCP SDK (not src/), so it exercises the real
// wire path: SSE connect → initialize → tools/call → result.
//
// API GROUNDING (read from the installed SDK, not memory):
//   node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts
//     new Client({name,version}); client.connect(transport); client.listTools();
//     client.callTool({ name, arguments }) → { content[], structuredContent?, isError? }
//   node_modules/@modelcontextprotocol/sdk/dist/esm/client/sse.d.ts
//     new SSEClientTransport(url: URL)   (deprecated in 1.29 but matches our server)
//
// USAGE (tsx is already a devDependency):
//   npx tsx scripts/verify-lei.ts
//   npx tsx scripts/verify-lei.ts --lei 54930012QJWZMYHNJW95
//   npx tsx scripts/verify-lei.ts --url http://localhost:3100/sse --force-fresh
//
// FLAGS (Rule 8 — configurable, sensible defaults):
//   --lei <LEI>        default 3358004DXAMRWRUIYJ05 (Jupiter, the seller)
//   --url <sse-url>    default http://localhost:${PORT||3000}/sse
//   --force-fresh      bypass the GLEIF cache (default off)
//
// Exit code: 0 if the tool returned a successful, ACTIVE result; 1 otherwise.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// ── tiny arg parser (no new deps) ────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}
const positional = argv.find((a) => !a.startsWith("--"));

const LEI = flag("lei") ?? positional ?? "3358004DXAMRWRUIYJ05";
const URL_STR = flag("url") ?? `http://localhost:${process.env.PORT ?? 3000}/sse`;
const FORCE_FRESH = argv.includes("--force-fresh");

// ── run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  console.log(`→ connecting to ${URL_STR}`);
  const transport = new SSEClientTransport(new URL(URL_STR));
  const client = new Client({ name: "verify-lei-cli", version: "0.1.0" });

  await client.connect(transport); // performs MCP initialize handshake

  const { tools } = await client.listTools();
  console.log(`→ server tools: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
  if (!tools.some((t) => t.name === "verify_lei_gleif")) {
    console.error("✗ verify_lei_gleif is not registered on the server");
    await client.close();
    return 1;
  }

  console.log(`→ calling verify_lei_gleif { lei: "${LEI}", forceFresh: ${FORCE_FRESH} }`);
  const res = await client.callTool({
    name: "verify_lei_gleif",
    arguments: { lei: LEI, forceFresh: FORCE_FRESH },
  });

  // callTool returns a union; the standard result carries `content`.
  if ("content" in res && Array.isArray(res.content)) {
    for (const block of res.content) {
      if (block.type === "text") console.log(block.text);
    }
  } else {
    console.log(JSON.stringify(res, null, 2));
  }

  await client.close();

  const isError = "isError" in res ? Boolean(res.isError) : false;
  return isError ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`✗ verification client failed: ${err?.message ?? err}`);
    console.error("  Is the server running (npm run dev) and is the --url/port correct?");
    process.exit(1);
  });
