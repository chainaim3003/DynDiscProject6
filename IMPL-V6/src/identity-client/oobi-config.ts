// ================= IMPL-V6 — identity-client / OOBI + endpoint config =================
//
// Resolves the Host B (vLEIEnh1) endpoints from IdentityFlags into one typed
// object the vlei-mode clients consume. Surface defined in
// REFINED-Project-Structure.md §1/§4 (the HOST A → HOST B seam).
//
// PLAIN MODE: never constructed/touched — all URLs default to "" and CREDENTIAL_MODE=plain
// uses PlainJsonProvider, which does not import this file. So plain dev stays offline.
//
// HONEST (Rule 2/4): assertVleiEndpoints() throws loudly if a vlei-mode run is
// missing a required URL, instead of silently calling an empty endpoint.

import type { IdentityFlags } from "../config/identity-flags.js";

export interface OobiConfig {
  /** vLEIEnh1 api-server (/health, /api/verify/seller|buyer). */
  vleiApiUrl: string;
  /** Sally verifier (counterparty chain walk). */
  sallyVerifierUrl: string;
  keriaAdminUrl: string;
  keriaBootUrl: string;
  schemaOobiUrl: string;
  /** Refuse to quote unless the counterparty AID verifies (prod gate). */
  verifyRequired: boolean;
}

/** Map identity flags → the endpoint config. Pure; no I/O. */
export function resolveOobiConfig(idf: Readonly<IdentityFlags>): OobiConfig {
  return {
    vleiApiUrl: idf.VLEI_API_URL.replace(/\/+$/, ""),
    sallyVerifierUrl: idf.SALLY_VERIFIER_URL.replace(/\/+$/, ""),
    keriaAdminUrl: idf.KERIA_ADMIN_URL.replace(/\/+$/, ""),
    keriaBootUrl: idf.KERIA_BOOT_URL.replace(/\/+$/, ""),
    schemaOobiUrl: idf.SCHEMA_OOBI_URL.replace(/\/+$/, ""),
    verifyRequired: idf.VLEI_VERIFY_REQUIRED,
  };
}

/**
 * Guard: a vlei-mode operation needs at least the api-server URL. Throws a
 * descriptive error rather than issuing a request to "" (no silent failure).
 * `need` lists which endpoints the calling operation requires.
 */
export function assertVleiEndpoints(
  cfg: OobiConfig,
  need: ReadonlyArray<keyof OobiConfig> = ["vleiApiUrl"],
): void {
  const missing = need.filter((k) => typeof cfg[k] === "string" && cfg[k] === "");
  if (missing.length > 0) {
    throw new Error(
      `[identity-client] CREDENTIAL_MODE=vlei requires ${missing.join(", ")} to be set ` +
        `(Host B / vLEIEnh1 endpoints — see REFINED-Project-Structure.md §4 and .env.example). ` +
        `They are empty. Set them, or use CREDENTIAL_MODE=plain for offline dev.`,
    );
  }
}
