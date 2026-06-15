// ================= IMPL-V6 — IDENTITY FLAGS (plain, no vLEI) =================
//
// Typed loader for the identity-card flag surface. After the "no-vLEI" restructure
// this is just the card / binding-map locations the PlainJsonProvider + agent-card
// loader read. The Host-B (vLEIEnh1) endpoint flags were REMOVED with the vLEI layer:
//   VLEI_API_URL, SALLY_VERIFIER_URL, KERIA_ADMIN_URL, KERIA_BOOT_URL,
//   SCHEMA_OOBI_URL, VLEI_VERIFY_REQUIRED.
//
// AGENT_CARDS_DIR + BINDING_MAP are KEPT (not vLEI-specific): PlainJsonProvider reads
// flags.AGENT_CARDS_DIR and loadBindingMap() reads flags.BINDING_MAP to load the plain
// role-label cards. They carry safe defaults, so a slimmed .env may omit them entirely.
//
// CONTRACT (mirrors flags.ts): every flag overridable by (1) environment variable,
// (2) the `overrides` argument to loadIdentityFlags() for tests/embedding; with
// defaults that keep plain mode fully self-contained (offline, no Host B).

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

/** Accepts on/off/true/false/1/0 (case-insensitive). */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  throw new Error(`[identity-flags] ${name}="${raw}" must be on/off (or true/false)`);
}

export interface IdentityFlags {
  /** Directory holding the principal agent cards. Design target: ./identity/agent-cards.
   *  Defaults to ./agent-cards to remain compatible with the EXISTING card location. */
  AGENT_CARDS_DIR: string;
  /** Directory holding sub-agent (ECR) cards. Design target: ./identity/agent-cards/subagents. */
  SUBAGENT_CARDS_DIR: string;
  /** Path to the agent->OOR/ECR->card binding map (identity/binding-map.json). */
  BINDING_MAP: string;

  // ── Host B (vLEIEnh1) endpoints — read ONLY when CREDENTIAL_MODE=vlei ──────
  // Empty by default so plain mode stays fully offline/self-contained. Surface
  // defined in REFINED-Project-Structure.md §4; consumed by identity-client/.
  /** vLEIEnh1 api-server base, e.g. http://<HOST_B_IP>:4000 (/api/verify/seller|buyer). */
  VLEI_API_URL: string;
  /** Sally verifier base, e.g. http://<HOST_B_IP>:9723 (counterparty chain walk). */
  SALLY_VERIFIER_URL: string;
  /** KERIA admin endpoint, e.g. http://<HOST_B_IP>:3901. */
  KERIA_ADMIN_URL: string;
  /** KERIA boot endpoint, e.g. http://<HOST_B_IP>:3903. */
  KERIA_BOOT_URL: string;
  /** Schema OOBI/SAID server, e.g. http://<HOST_B_IP>:7723. */
  SCHEMA_OOBI_URL: string;
  /** true = refuse to quote unless the counterparty AID verifies (prod gate). */
  VLEI_VERIFY_REQUIRED: boolean;
}

export const DEFAULT_IDENTITY_FLAGS: Readonly<IdentityFlags> = Object.freeze({
  // Default to the existing on-disk card location so plain mode works with zero setup.
  AGENT_CARDS_DIR: "./agent-cards",
  SUBAGENT_CARDS_DIR: "./identity/agent-cards/subagents",
  BINDING_MAP: "./identity/binding-map.json",
  // Host B endpoints empty by default (plain mode never touches them).
  VLEI_API_URL: "",
  SALLY_VERIFIER_URL: "",
  KERIA_ADMIN_URL: "",
  KERIA_BOOT_URL: "",
  SCHEMA_OOBI_URL: "",
  VLEI_VERIFY_REQUIRED: false,
});

/**
 * Resolve effective identity flags: defaults <- environment <- explicit overrides.
 * Pure aside from reading process.env. Call once at startup and thread the result.
 *
 *   loadIdentityFlags({ AGENT_CARDS_DIR: "./identity/agent-cards" })  // e.g. tests
 */
export function loadIdentityFlags(
  overrides: Partial<IdentityFlags> = {},
): Readonly<IdentityFlags> {
  const fromEnv: IdentityFlags = {
    AGENT_CARDS_DIR: envStr("AGENT_CARDS_DIR", DEFAULT_IDENTITY_FLAGS.AGENT_CARDS_DIR),
    SUBAGENT_CARDS_DIR: envStr("SUBAGENT_CARDS_DIR", DEFAULT_IDENTITY_FLAGS.SUBAGENT_CARDS_DIR),
    BINDING_MAP: envStr("BINDING_MAP", DEFAULT_IDENTITY_FLAGS.BINDING_MAP),
    VLEI_API_URL: envStr("VLEI_API_URL", DEFAULT_IDENTITY_FLAGS.VLEI_API_URL),
    SALLY_VERIFIER_URL: envStr("SALLY_VERIFIER_URL", DEFAULT_IDENTITY_FLAGS.SALLY_VERIFIER_URL),
    KERIA_ADMIN_URL: envStr("KERIA_ADMIN_URL", DEFAULT_IDENTITY_FLAGS.KERIA_ADMIN_URL),
    KERIA_BOOT_URL: envStr("KERIA_BOOT_URL", DEFAULT_IDENTITY_FLAGS.KERIA_BOOT_URL),
    SCHEMA_OOBI_URL: envStr("SCHEMA_OOBI_URL", DEFAULT_IDENTITY_FLAGS.SCHEMA_OOBI_URL),
    VLEI_VERIFY_REQUIRED: envBool("VLEI_VERIFY_REQUIRED", DEFAULT_IDENTITY_FLAGS.VLEI_VERIFY_REQUIRED),
  };

  return Object.freeze({ ...fromEnv, ...overrides });
}
