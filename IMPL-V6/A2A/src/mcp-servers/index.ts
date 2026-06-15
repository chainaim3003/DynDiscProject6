// ================= MCP TOOL REGISTRY =================
//
// Single source of truth for which tools the MCP-over-SSE server exposes.
// server-sse.ts adapts these neutral descriptors onto @modelcontextprotocol/sdk's
// registration API (one mapping site, so an SDK bump touches one file).
//
// V6.3: verify_lei_gleif (V6.2) + the two deterministic quoting tools:
//   - quote_unit_price       (P01) — Item Price unit rate × qty
//   - quote_with_quantity    (P02) — + Pricing Rule quantity slab
// The quote tools return a QuoteToolResult envelope (pricing is a deterministic
// computation, 04 §2 — not a provider ConsultationRecord).
//
// To add a tool later: implement it in ./<tool>.ts, wrap it in a descriptor
// here, and push it into TOOL_REGISTRY. server-sse registers everything in the
// array — no other edit needed.

import type { z } from "zod";
import type { OrchestratorFlags } from "../config/flags.js";
import type { ConsultationRecord } from "../shared/provider-types.js";
import {
  VerifyLeiGleifInputSchema,
  verifyLeiGleif,
  formatVerificationSummary,
  type VerifyLeiGleifInput,
  type GleifVerification,
} from "./mcp-vlei/verify_lei_gleif.js";
import type { QuoteToolResult } from "./mcp-erpnext/pricing.js";
import {
  QuoteUnitPriceInputSchema,
  quoteUnitPrice,
  formatQuoteUnitPriceSummary,
  type QuoteUnitPriceInput,
  type QuoteUnitPriceResult,
} from "./mcp-erpnext/quote_unit_price.js";
import {
  QuoteWithQuantityInputSchema,
  quoteWithQuantity,
  formatQuoteWithQuantitySummary,
  type QuoteWithQuantityInput,
  type QuoteWithQuantityResult,
} from "./mcp-erpnext/quote_with_quantity.js";
import {
  RunNegotiationInputSchema,
  runNegotiationToolHandler,
  formatRunNegotiationSummary,
  type RunNegotiationInput,
  type RunNegotiationResult,
} from "./mcp-erpnext/run_negotiation.js";

/**
 * Neutral, SDK-agnostic tool descriptor.
 *
 * @typeParam I  parsed input type (z.infer of `inputSchema`)
 * @typeParam O  handler output type (ConsultationRecord<…> or QuoteToolResult<…>)
 */
export interface McpToolDescriptor<I, O> {
  /** MCP tool name (snake_case, stable — this is what OpenClaw calls). */
  name: string;
  /** Human title for tool listings. */
  title: string;
  /** Description shown to the model/host when choosing the tool. */
  description: string;
  /**
   * Zod schema validating raw MCP input → `I`.
   * Third type-arg (Input) left as `any`: schemas with `.default()`/`.optional()`
   * have an input type that differs from their parsed output `I`. We only
   * constrain the OUTPUT to `I`.
   */
  inputSchema: z.ZodType<I, z.ZodTypeDef, any>;
  /** Pure handler: parsed input + resolved flags → result envelope. */
  handler: (input: I, flags: OrchestratorFlags) => Promise<O>;
  /** Render the one-line human summary for the MCP text result. */
  summarize: (out: O) => string;
}

/** verify_lei_gleif — plain GLEIF v1 active-status check. */
export const verifyLeiGleifTool: McpToolDescriptor<
  VerifyLeiGleifInput,
  ConsultationRecord<GleifVerification>
> = {
  name: "verify_lei_gleif",
  title: "Verify LEI via GLEIF",
  description:
    "Plain GLEIF v1 active-status check for a 20-character ISO 17442 LEI. " +
    "Returns the registration and entity status verbatim, a derived isActive flag, " +
    "and full provenance (latency, live-vs-cache source, raw-response hash). " +
    "CREDENTIAL_MODE=plain only; vLEI (KERI/ACDC delegation) is deferred to ITER7.",
  inputSchema: VerifyLeiGleifInputSchema,
  handler: (input, flags) => verifyLeiGleif(input, flags),
  summarize: (out) => formatVerificationSummary(out),
};

/** quote_unit_price — P01: ERPNext Item Price unit rate × qty. */
export const quoteUnitPriceTool: McpToolDescriptor<
  QuoteUnitPriceInput,
  QuoteToolResult<QuoteUnitPriceResult>
> = {
  name: "quote_unit_price",
  title: "Quote Unit Price",
  description:
    "Deterministic P01 quote: the selling unit price for an Item from the ERPNext " +
    "Item Price list, times a quantity. Reads the latest selling Item Price in the " +
    "given price list (default 'Standard Selling', currency INR). Returns success=false " +
    "with no fabricated rate if the Item or a selling price is missing.",
  inputSchema: QuoteUnitPriceInputSchema,
  handler: (input, flags) => quoteUnitPrice(input, flags),
  summarize: (out) => formatQuoteUnitPriceSummary(out),
};

/** quote_with_quantity — P02: unit price + Pricing Rule quantity slab. */
export const quoteWithQuantityTool: McpToolDescriptor<
  QuoteWithQuantityInput,
  QuoteToolResult<QuoteWithQuantityResult>
> = {
  name: "quote_with_quantity",
  title: "Quote With Quantity",
  description:
    "Deterministic P02 quote: the selling unit price for an Item plus any matching " +
    "selling Pricing Rule quantity slab for the requested qty. Exposes the base list " +
    "rate, the effective rate, and which Pricing Rule (if any) applied. Degrades to the " +
    "list price when no rule matches; same no-fabricated-rate contract as quote_unit_price.",
  inputSchema: QuoteWithQuantityInputSchema,
  handler: (input, flags) => quoteWithQuantity(input, flags),
  summarize: (out) => formatQuoteWithQuantitySummary(out),
};

/** run_negotiation — gap G1: the full saga (intake → DD → quoting/ATP → negotiate → persist). */
export const runNegotiationTool: McpToolDescriptor<
  RunNegotiationInput,
  RunNegotiationResult
> = {
  name: "run_negotiation",
  title: "Run Negotiation Saga (end-to-end)",
  description:
    "Drive the FULL Jupiter seller negotiation saga end-to-end for one buyer inquiry: " +
    "intake -> mirror to an ERPNext Opportunity -> ack -> due-diligence (live GLEIF + " +
    "credit) -> quoting/ATP -> binding-veto negotiation -> sign & persist an ERPNext " +
    "Quotation. Returns the terminal status, the created ERPNext doc names, the per-agent " +
    "signed attestation journal, and the draft/final quote. MUTATING + NON-IDEMPOTENT: " +
    "creates a new ERPNext Opportunity (and, on a deal, a Quotation) and makes live GLEIF " +
    "calls on EVERY invocation — re-running the same inquiry creates DUPLICATE docs until " +
    "the idempotency layer (gap G3) lands. Knobs: creditFixturesDir exercises DD, " +
    "negotiateDemoFloor sets the treasury veto floor, persistCustomFields gates the ERPNext " +
    "identity custom fields, includeFullState returns the raw saga state.",
  inputSchema: RunNegotiationInputSchema,
  handler: (input, flags) => runNegotiationToolHandler(input, flags),
  summarize: (out) => formatRunNegotiationSummary(out),
};

/**
 * All tools the server registers. Typed `unknown,unknown` at the array boundary;
 * server-sse parses each tool's own `inputSchema` before invoking its `handler`,
 * so per-tool types are preserved at the call site.
 */
export const TOOL_REGISTRY: ReadonlyArray<McpToolDescriptor<any, any>> = [
  verifyLeiGleifTool,
  quoteUnitPriceTool,
  quoteWithQuantityTool,
  runNegotiationTool,
];
