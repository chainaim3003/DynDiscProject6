// ================= IMPL-V6 — identity-client / Sally verifier client =================
//
// Counterparty credential verification (REFINED-Project-Structure.md §2/§5):
// HOST A calls the vLEIEnh1 api-server's documented routes — /api/verify/seller
// and /api/verify/buyer — which walk the AID → OOR/ECR → LE → QVI → GLEIF chain
// via Sally (:9723) behind the api-server (:4000). These two routes + /health are
// the ONLY endpoints REFINED-Project-Structure.md §6 confirms exist today.
//
// Returns the interface's VerificationResult so callers handle plain + vlei
// uniformly. NO fabrication (Rule 2): a network/HTTP failure → verified=false
// with the real reason; it never reports a chain it could not walk.

import type { VerificationResult } from "../identity/CredentialProvider.js";

/** Which documented verify route to call. */
export type VerifyParty = "seller" | "buyer";

export interface SallyVerifierOptions {
  /** api-server base, e.g. http://<HOST_B_IP>:4000 (NOT Sally's raw :9723). */
  apiBaseUrl: string;
  /** Per-request timeout (default 30s, matching the ERPNext client stance). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class SallyVerifierClient {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(opts: SallyVerifierOptions) {
    this.base = opts.apiBaseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * POST /api/verify/{party} with an optional body (e.g. { aid, oobi }). The
   * api-server resolves the chain via Sally and returns a verification verdict.
   * Shape of the response is treated defensively: we look for a boolean-ish
   * "verified"/"valid"/"ok" field and surface the whole body as `raw`.
   */
  async verifyParty(party: VerifyParty, body: Record<string, unknown> = {}): Promise<VerificationResult> {
    if (this.base === "") {
      return {
        verified: false,
        method: "cryptographic",
        reason: "[sally] no api base URL configured (VLEI_API_URL empty)",
      };
    }

    const url = `${this.base}/api/verify/${party}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (!res.ok) {
        return {
          verified: false,
          method: "cryptographic",
          reason: `[sally] ${party} verify HTTP ${res.status}: ${text.slice(0, 300)}`,
          raw: json ?? text,
        };
      }

      const o = (json ?? {}) as Record<string, unknown>;
      const verified =
        o.verified === true || o.valid === true || o.ok === true || o.success === true;
      return {
        verified,
        method: "cryptographic",
        reason: verified
          ? `[sally] ${party} chain verified`
          : `[sally] ${party} not verified (api-server returned a non-affirmative result)`,
        raw: json ?? text,
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        verified: false,
        method: "cryptographic",
        reason: aborted
          ? `[sally] ${party} verify timed out after ${this.timeoutMs}ms (${url})`
          : `[sally] ${party} verify network error: ${String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Liveness probe against the api-server /health route. */
  async health(): Promise<boolean> {
    if (this.base === "") return false;
    try {
      const res = await fetch(`${this.base}/health`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }
}
