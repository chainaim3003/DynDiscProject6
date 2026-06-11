// ================= IMPL-V6 — ORCHESTRATOR CONFIGURATION FLAGS =================
//
// Typed mirror of the project's authoritative flag surface: IMPL-V6/.env.example
// (which matches DESIGN/baseline/01-Prompts-Schema-Structure.md §5.3). This
// module is the single typed accessor for those env vars — names, defaults,
// and allowed values are copied verbatim from .env.example. If .env.example
// changes, change this file to match (it is the contract, not this file).
//
// Design contract (userPreferences Rule 8): behavior is configurable via named
// flags with sensible defaults. Every flag is overridable two ways:
//   1. Environment variable (dotenv loads .env at the entrypoint before loadFlags()).
//   2. The `overrides` argument to loadFlags() — for tests and embedding.
//
// NOTE (additive infra): 01 §5.1 does not itself specify a config module — it
// reads env in-process. This typed loader is an additive convenience; it does
// NOT introduce any flag that isn't already in .env.example.
//
// Endpoints intentionally ABSENT here because they are absent from
// .env.example: the treasury/ACTUS URL is not yet an env flag in V6 (TREASURY
// talks ACTUS when TREASURY_MODE=real; endpoint config is an OPEN ITEM — do not
// invent it). LLM model ids are likewise not env flags (only EMBEDDING_MODEL is).
// Party LEIs / default product / ports are locked INVARIANTS (01 §1), not flags —
// they belong in a constants module, not here.

export type Orchestrator     = "langgraph-ts";
export type CheckpointerKind = "sqlite";                         // only sqlite in V6 scope
export type MemoryStoreKind  = "memory" | "sqlite" | "postgres";
export type ProviderMode     = "real" | "demo";
export type CredentialMode   = "plain" | "vlei";              // vlei = Host-B (vLEIEnh1) via VleiServiceClient
export type SigningMode      = "plain" | "rsa";                  // plain in V6 (RSA plan exists)
export type QuotePersistMode = "final" | "every-round";          // Schemas doc §2.5
export type EvalMode         = "fast" | "integration" | "e2e";
export type NegotiationOptimizerMode = "deterministic" | "llm";  // seller counter proposer
export type BuyerTransportMode       = "inprocess" | "a2a";       // buyer link: local | networked A2A

export interface OrchestratorFlags {
  // ── Orchestration / memory (locked) ──────────────────────────────────────
  ORCHESTRATOR:            Orchestrator;
  CHECKPOINTER_KIND:       CheckpointerKind;
  AUDIT_DB_PATH:           string;        // T2 + T5 share this file (SqliteSaver, thread_id=negotiationId)
  MEMORY_STORE_KIND:       MemoryStoreKind;
  EMBEDDING_MODEL:         string;        // T3 semantic store embeddings
  CLARIFY_MAX_ROUNDS:      number;        // 04 §4.3
  NEGOTIATION_MAX_ROUNDS:  number;        // 04 §4.3
  NEGOTIATION_OPTIMIZER:   NegotiationOptimizerMode;  // seller counter: deterministic | llm (Gemini)
  BUYER_TRANSPORT:         BuyerTransportMode;         // buyer link: inprocess (default) | a2a (networked)
  BUYER_A2A_URL:           string;        // base URL of the buyer A2A server (a2a mode)
  BUYER_A2A_PORT:          number;        // port the buyer A2A server listens on (buyer-server.ts)
  BUYER_A2A_TIMEOUT_MS:    number;        // per-call timeout (ms) for the seller→buyer A2A request
  QUOTE_DEMAND_AWARE:      boolean;       // .env "on"/"off" → Quoting consults Demand-Planning (P09/P10)
  IDEMPOTENT_WRITES:       boolean;       // dedupe ERPNext writes by negotiationId (gap G3) — default on

  // ── Provider modes (locked) ──────────────────────────────────────────────
  INVENTORY_MODE:          ProviderMode;  // real = ERPNext Bin
  CREDIT_MODE:             ProviderMode;  // real = GLEIF live (EDGAR demo)
  LOGISTICS_MODE:          ProviderMode;  // demo (DCSA)
  TREASURY_MODE:           ProviderMode;  // real = ACTUS PAM
  CREDENTIAL_MODE:         CredentialMode;
  SIGNING_MODE:            SigningMode;

  // ── ERPNext (T4) ─────────────────────────────────────────────────────────
  ERPNEXT_URL:             string;
  ERPNEXT_API_KEY:         string;        // secret — do not log
  ERPNEXT_API_SECRET:      string;        // secret — do not log
  ERPNEXT_COMPANY:         string;
  ERPNEXT_CURRENCY:        string;
  ERPNEXT_DEFAULT_WAREHOUSE: string;
  QUOTE_PERSIST_MODE:      QuotePersistMode;
  PAYMENT_TERMS_ALLOWED:   string[];      // .env comma list "Net-0,Net-30,Net-60"
  GST_RATE:                number;        // percent, e.g. 18

  // ── Eval ─────────────────────────────────────────────────────────────────
  EVAL_MODE:               EvalMode;
}

// ─── Defaults (verbatim from .env.example) ──────────────────────────────────

export const DEFAULT_FLAGS: Readonly<OrchestratorFlags> = Object.freeze({
  ORCHESTRATOR:      "langgraph-ts",
  CHECKPOINTER_KIND: "sqlite",
  AUDIT_DB_PATH:     "./data/audit.db",
  MEMORY_STORE_KIND: "memory",
  EMBEDDING_MODEL:   "text-embedding-004",
  CLARIFY_MAX_ROUNDS:     2,
  NEGOTIATION_MAX_ROUNDS: 3,
  NEGOTIATION_OPTIMIZER:  "deterministic",
  BUYER_TRANSPORT:        "inprocess",
  BUYER_A2A_URL:          "http://localhost:41242",
  BUYER_A2A_PORT:         41242,
  BUYER_A2A_TIMEOUT_MS:   10000,
  QUOTE_DEMAND_AWARE:     false,
  IDEMPOTENT_WRITES:      true,

  INVENTORY_MODE:  "real",
  CREDIT_MODE:     "real",
  LOGISTICS_MODE:  "demo",
  TREASURY_MODE:   "real",
  CREDENTIAL_MODE: "plain",
  SIGNING_MODE:    "plain",

  ERPNEXT_URL:               "http://localhost:8080",
  ERPNEXT_API_KEY:           "",
  ERPNEXT_API_SECRET:        "",
  ERPNEXT_COMPANY:           "Jupiter Knitting Company",
  ERPNEXT_CURRENCY:          "INR",
  ERPNEXT_DEFAULT_WAREHOUSE: "MADRAS-WH-1",
  QUOTE_PERSIST_MODE:        "final",
  PAYMENT_TERMS_ALLOWED:     ["Net-0", "Net-30", "Net-60"],
  GST_RATE:                  18,

  EVAL_MODE: "fast",
});

// ─── env parsing helpers (pure; no external deps) ───────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`[flags] ${name}="${raw}" is not a valid integer`);
  return n;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`[flags] ${name}="${raw}" is not a valid number`);
  return n;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

/** Accepts on/off/true/false/1/0 (case-insensitive). */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(v))  return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  throw new Error(`[flags] ${name}="${raw}" must be on/off (or true/false)`);
}

/** Comma-separated list → trimmed non-empty string[]. */
function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`[flags] ${name}="${raw}" must be one of: ${allowed.join(" | ")}`);
  }
  return raw as T;
}

const ORCHESTRATORS      = ["langgraph-ts"] as const;
const CHECKPOINTER_KINDS = ["sqlite"] as const;
const MEMORY_STORE_KINDS = ["memory", "sqlite", "postgres"] as const;
const PROVIDER_MODES     = ["real", "demo"] as const;
const CREDENTIAL_MODES   = ["plain", "vlei"] as const;          // vlei activates identity-client/VleiServiceClient
const SIGNING_MODES      = ["plain", "rsa"] as const;
const QUOTE_PERSIST_MODES = ["final", "every-round"] as const;
const EVAL_MODES         = ["fast", "integration", "e2e"] as const;
const NEGOTIATION_OPTIMIZERS = ["deterministic", "llm"] as const;
const BUYER_TRANSPORTS       = ["inprocess", "a2a"] as const;

/**
 * Resolve effective flags: defaults ← environment ← explicit overrides (later
 * wins). Pure aside from reading process.env. Call once at startup and thread
 * the returned object through the graph; do not re-read env per node.
 *
 *   loadFlags({ NEGOTIATION_MAX_ROUNDS: 1, LOGISTICS_MODE: "real" })  // e.g. tests
 */
export function loadFlags(overrides: Partial<OrchestratorFlags> = {}): Readonly<OrchestratorFlags> {
  const fromEnv: OrchestratorFlags = {
    ORCHESTRATOR:      envEnum("ORCHESTRATOR",      ORCHESTRATORS,      DEFAULT_FLAGS.ORCHESTRATOR),
    CHECKPOINTER_KIND: envEnum("CHECKPOINTER_KIND", CHECKPOINTER_KINDS, DEFAULT_FLAGS.CHECKPOINTER_KIND),
    AUDIT_DB_PATH:     envStr("AUDIT_DB_PATH",      DEFAULT_FLAGS.AUDIT_DB_PATH),
    MEMORY_STORE_KIND: envEnum("MEMORY_STORE_KIND", MEMORY_STORE_KINDS, DEFAULT_FLAGS.MEMORY_STORE_KIND),
    EMBEDDING_MODEL:   envStr("EMBEDDING_MODEL",    DEFAULT_FLAGS.EMBEDDING_MODEL),
    CLARIFY_MAX_ROUNDS:     envInt("CLARIFY_MAX_ROUNDS",     DEFAULT_FLAGS.CLARIFY_MAX_ROUNDS),
    NEGOTIATION_MAX_ROUNDS: envInt("NEGOTIATION_MAX_ROUNDS", DEFAULT_FLAGS.NEGOTIATION_MAX_ROUNDS),
    NEGOTIATION_OPTIMIZER:  envEnum("NEGOTIATION_OPTIMIZER", NEGOTIATION_OPTIMIZERS, DEFAULT_FLAGS.NEGOTIATION_OPTIMIZER),
    BUYER_TRANSPORT:        envEnum("BUYER_TRANSPORT",       BUYER_TRANSPORTS, DEFAULT_FLAGS.BUYER_TRANSPORT),
    BUYER_A2A_URL:          envStr("BUYER_A2A_URL",          DEFAULT_FLAGS.BUYER_A2A_URL),
    BUYER_A2A_PORT:         envInt("BUYER_A2A_PORT",         DEFAULT_FLAGS.BUYER_A2A_PORT),
    BUYER_A2A_TIMEOUT_MS:   envInt("BUYER_A2A_TIMEOUT_MS",   DEFAULT_FLAGS.BUYER_A2A_TIMEOUT_MS),
    QUOTE_DEMAND_AWARE:     envBool("QUOTE_DEMAND_AWARE",    DEFAULT_FLAGS.QUOTE_DEMAND_AWARE),
    IDEMPOTENT_WRITES:      envBool("IDEMPOTENT_WRITES",     DEFAULT_FLAGS.IDEMPOTENT_WRITES),

    INVENTORY_MODE:  envEnum("INVENTORY_MODE",  PROVIDER_MODES,   DEFAULT_FLAGS.INVENTORY_MODE),
    CREDIT_MODE:     envEnum("CREDIT_MODE",     PROVIDER_MODES,   DEFAULT_FLAGS.CREDIT_MODE),
    LOGISTICS_MODE:  envEnum("LOGISTICS_MODE",  PROVIDER_MODES,   DEFAULT_FLAGS.LOGISTICS_MODE),
    TREASURY_MODE:   envEnum("TREASURY_MODE",   PROVIDER_MODES,   DEFAULT_FLAGS.TREASURY_MODE),
    CREDENTIAL_MODE: envEnum("CREDENTIAL_MODE", CREDENTIAL_MODES, DEFAULT_FLAGS.CREDENTIAL_MODE),
    SIGNING_MODE:    envEnum("SIGNING_MODE",    SIGNING_MODES,    DEFAULT_FLAGS.SIGNING_MODE),

    ERPNEXT_URL:               envStr("ERPNEXT_URL",               DEFAULT_FLAGS.ERPNEXT_URL),
    ERPNEXT_API_KEY:           envStr("ERPNEXT_API_KEY",           DEFAULT_FLAGS.ERPNEXT_API_KEY),
    ERPNEXT_API_SECRET:        envStr("ERPNEXT_API_SECRET",        DEFAULT_FLAGS.ERPNEXT_API_SECRET),
    ERPNEXT_COMPANY:           envStr("ERPNEXT_COMPANY",           DEFAULT_FLAGS.ERPNEXT_COMPANY),
    ERPNEXT_CURRENCY:          envStr("ERPNEXT_CURRENCY",          DEFAULT_FLAGS.ERPNEXT_CURRENCY),
    ERPNEXT_DEFAULT_WAREHOUSE: envStr("ERPNEXT_DEFAULT_WAREHOUSE", DEFAULT_FLAGS.ERPNEXT_DEFAULT_WAREHOUSE),
    QUOTE_PERSIST_MODE:        envEnum("QUOTE_PERSIST_MODE", QUOTE_PERSIST_MODES, DEFAULT_FLAGS.QUOTE_PERSIST_MODE),
    PAYMENT_TERMS_ALLOWED:     envList("PAYMENT_TERMS_ALLOWED",    DEFAULT_FLAGS.PAYMENT_TERMS_ALLOWED),
    GST_RATE:                  envNum("GST_RATE",                  DEFAULT_FLAGS.GST_RATE),

    EVAL_MODE: envEnum("EVAL_MODE", EVAL_MODES, DEFAULT_FLAGS.EVAL_MODE),
  };

  return Object.freeze({ ...fromEnv, ...overrides });
}
