// ================= IMPL-V6 — ERPNext REST CLIENT (T4 boundary) =================
//
// Typed TypeScript client for the live ERPNext / Frappe site (frappe_docker,
// ERPNEXT_URL, default http://localhost:8080). This is the ONLY place in the
// agent codebase that talks HTTP to ERPNext; nodes/tools call these methods.
//
// GROUNDING (Rule 8 — reuse the proven contract, do NOT re-derive the API):
//   This is a faithful TypeScript port of the REST dialect already proven live
//   by the Python seed layer:
//     ...\FINAGENTS1\erpnextEnh1\seed\_seedlib.py        (ERPNextClient)
//     ...\FINAGENTS1\erpnextEnh1\seed\00-bootstrap-masters.py
//   Verbatim contract carried over:
//     - Auth:    Authorization: token <key>:<secret>  + Accept/Content-Type JSON
//     - whoami:  GET  /api/method/frappe.auth.get_logged_user  -> .message
//     - get:     GET  /api/resource/{doctype}/{name}           -> .data | (403/404 -> null)
//     - list:    GET  /api/resource/{doctype}?filters&fields&limit_page_length&order_by -> .data[]
//     - insert:  POST /api/resource/{doctype}        (body merged with {doctype}) -> .data
//     - update:  PUT  /api/resource/{doctype}/{name}                              -> .data
//     - method:  POST /api/method/{dotted.path}                                   -> .message
//   The 403/404 -> empty semantics (not an exception) match _seedlib exactly so
//   "does this Item exist?" reads as a clean boolean, never a thrown error.
//   Reference: docs.frappe.io/framework/user/en/api/rest (cited in the seeds).
//
// frappe_docker is the SERVER (deployment); erpnextEnh1 is the Python
// customization/seed layer. Neither is imported here — this client only speaks
// their shared wire protocol, pointed at ERPNEXT_URL.
//
// DESIGN CONTRACT:
//   - Behavior is configurable via named options with sensible defaults
//     (timeoutMs, baseUrl/apiKey/apiSecret overrides) — Rule 8.
//   - Genuine failures (network, timeout, 5xx, auth, malformed) throw a typed
//     ErpNextError carrying status + parsed Frappe diagnostic. Callers (tools /
//     nodes) catch it and turn it into a defensive ConsultationRecord/result —
//     this client never silently fabricates data.
//   - "Not found" is NOT a failure: getDoc/findOne return null, list returns [].

import type { OrchestratorFlags } from "../config/flags.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Why an ERPNext call failed. "not-found" is never thrown (returns null/[]). */
export type ErpNextErrorCode = "network" | "timeout" | "http" | "auth" | "malformed";

/**
 * Typed error for genuine ERPNext failures. Carries the HTTP status and the
 * best-effort parsed Frappe diagnostic (exception / _server_messages) so the
 * defensive branch can record a real upstream error, not a generic string.
 */
export class ErpNextError extends Error {
  readonly code: ErpNextErrorCode;
  readonly status?: number;
  readonly method?: string;
  readonly url?: string;
  /** Raw response body (truncated) — useful in the audit's upstreamError. */
  readonly body?: string;

  constructor(
    code: ErpNextErrorCode,
    message: string,
    opts: { status?: number; method?: string; url?: string; body?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ErpNextError";
    this.code = code;
    this.status = opts.status;
    this.method = opts.method;
    this.url = opts.url;
    this.body = opts.body;
  }
}

// ─── Config ────────────────────────────────────────────────────────────────

export interface ErpNextClientOptions {
  /** Base URL, e.g. http://localhost:8080. Trailing slash is stripped. */
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Per-request timeout (default 30_000 ms — matches _seedlib --timeout 30). */
  timeoutMs?: number;
}

/** Frappe list query — mirrors the Python list(filters, fields, limit). */
export interface ListQuery {
  /** Frappe filter list, e.g. [["item_code","=","TH-TEE-RN-180-M"]]. */
  filters?: Array<[string, string, unknown]>;
  /** Columns to return; omit for Frappe's default name-only projection. */
  fields?: string[];
  /** limit_page_length (default 20, ERPNext's own default). */
  limit?: number;
  /** order_by clause, e.g. "valid_from desc". */
  orderBy?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_TRUNCATE = 600; // keep audit upstreamError bounded

// ─── Client ──────────────────────────────────────────────────────────────────

/**
 * Thin, typed ERPNext REST client. One instance per server target; safe to
 * reuse across calls (stateless aside from config). All methods are generic
 * over the expected `.data` shape — callers supply the DocType row type.
 */
export class ErpNextClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor(opts: ErpNextClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.authHeader = `token ${opts.apiKey}:${opts.apiSecret}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ── low-level request (the single network choke point) ────────────────────

  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    init: { query?: Record<string, string>; jsonBody?: unknown } = {},
  ): Promise<{ status: number; json: unknown; text: string }> {
    let url = `${this.base}${path}`;
    if (init.query && Object.keys(init.query).length > 0) {
      url += `?${new URLSearchParams(init.query).toString()}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: init.jsonBody !== undefined ? JSON.stringify(init.jsonBody) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new ErpNextError("timeout", `ERPNext ${method} ${path} timed out after ${this.timeoutMs}ms`, {
          method,
          url,
          cause: err,
        });
      }
      throw new ErpNextError("network", `ERPNext ${method} ${path} network error: ${String(err)}`, {
        method,
        url,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown = undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined; // non-JSON body (e.g. an HTML error page) — surfaced via text
      }
    }
    return { status: res.status, json, text };
  }

  /** Pull the human-facing Frappe diagnostic out of an error body, if present. */
  private static frappeDiagnostic(json: unknown, text: string): string {
    if (json && typeof json === "object") {
      const o = json as Record<string, unknown>;
      if (typeof o.exception === "string" && o.exception) return o.exception;
      if (typeof o._error_message === "string" && o._error_message) return o._error_message;
      if (Array.isArray(o._server_messages) && o._server_messages.length > 0) {
        return o._server_messages.map((m) => String(m)).join("; ");
      }
    }
    return text.slice(0, BODY_TRUNCATE);
  }

  private throwHttp(method: string, url: string, status: number, json: unknown, text: string): never {
    const code: ErpNextErrorCode = status === 401 || status === 403 ? "auth" : "http";
    throw new ErpNextError(code, `ERPNext ${method} -> HTTP ${status}: ${ErpNextClient.frappeDiagnostic(json, text)}`, {
      status,
      method,
      url,
      body: text.slice(0, BODY_TRUNCATE),
    });
  }

  // ── URL builders ──────────────────────────────────────────────────────────

  private resourcePath(doctype: string, name?: string): string {
    let p = `/api/resource/${encodeURIComponent(doctype)}`;
    if (name !== undefined) p += `/${encodeURIComponent(name)}`;
    return p;
  }

  // ── public API (mirrors _seedlib.ERPNextClient) ───────────────────────────

  /** Auth + connectivity gate. Returns the bound user (e.g. "Administrator"). */
  async whoami(): Promise<string> {
    const path = "/api/method/frappe.auth.get_logged_user";
    const { status, json, text } = await this.request("GET", path);
    if (status !== 200) this.throwHttp("GET", `${this.base}${path}`, status, json, text);
    const msg = (json as { message?: unknown } | undefined)?.message;
    if (typeof msg !== "string") {
      throw new ErpNextError("malformed", "whoami: response had no string .message", { status });
    }
    return msg;
  }

  /**
   * GET a single document by name. Returns null on 403/404 (not an error) so
   * existence checks read cleanly. Other non-2xx throw.
   */
  async getDoc<T = Record<string, unknown>>(doctype: string, name: string): Promise<T | null> {
    const path = this.resourcePath(doctype, name);
    const { status, json, text } = await this.request("GET", path);
    if (status === 200) return ((json as { data?: T } | undefined)?.data ?? null) as T | null;
    if (status === 403 || status === 404) return null;
    return this.throwHttp("GET", `${this.base}${path}`, status, json, text);
  }

  /** Does a document exist? (getDoc !== null). */
  async exists(doctype: string, name: string): Promise<boolean> {
    return (await this.getDoc(doctype, name)) !== null;
  }

  /**
   * List documents matching `query`. Returns [] on 403/404. The default Frappe
   * projection is name-only unless `fields` is supplied.
   */
  async list<T = Record<string, unknown>>(doctype: string, query: ListQuery = {}): Promise<T[]> {
    const q: Record<string, string> = {};
    if (query.filters && query.filters.length > 0) q.filters = JSON.stringify(query.filters);
    if (query.fields && query.fields.length > 0) q.fields = JSON.stringify(query.fields);
    if (query.orderBy) q.order_by = query.orderBy;
    q.limit_page_length = String(query.limit ?? 20);

    const path = this.resourcePath(doctype);
    const { status, json, text } = await this.request("GET", path, { query: q });
    if (status === 200) return ((json as { data?: T[] } | undefined)?.data ?? []) as T[];
    if (status === 403 || status === 404) return [];
    return this.throwHttp("GET", `${this.base}${path}`, status, json, text);
  }

  /** Convenience: first match of `list` with limit 1, or null. */
  async findOne<T = Record<string, unknown>>(doctype: string, query: Omit<ListQuery, "limit"> = {}): Promise<T | null> {
    const rows = await this.list<T>(doctype, { ...query, limit: 1 });
    return rows.length > 0 ? rows[0]! : null;
  }

  /** Create a document. `body` is merged with {doctype}. Returns the created row. */
  async insert<T = Record<string, unknown>>(doctype: string, body: Record<string, unknown>): Promise<T> {
    const path = this.resourcePath(doctype);
    const { status, json, text } = await this.request("POST", path, { jsonBody: { ...body, doctype } });
    if (status === 200 || status === 201) {
      const data = (json as { data?: T } | undefined)?.data;
      if (data === undefined) throw new ErpNextError("malformed", `insert ${doctype}: 2xx but no .data`, { status });
      return data;
    }
    return this.throwHttp("POST", `${this.base}${path}`, status, json, text);
  }

  /** Update an existing document by name. Returns the updated row. */
  async update<T = Record<string, unknown>>(doctype: string, name: string, body: Record<string, unknown>): Promise<T> {
    const path = this.resourcePath(doctype, name);
    const { status, json, text } = await this.request("PUT", path, { jsonBody: body });
    if (status === 200) {
      const data = (json as { data?: T } | undefined)?.data;
      if (data === undefined) throw new ErpNextError("malformed", `update ${doctype}/${name}: 200 but no .data`, { status });
      return data;
    }
    return this.throwHttp("PUT", `${this.base}${path}`, status, json, text);
  }

  /** POST a whitelisted server method. Returns the raw `.message` payload. */
  async callMethod<T = unknown>(dottedPath: string, payload: Record<string, unknown> = {}): Promise<T> {
    const path = `/api/method/${dottedPath}`;
    const { status, json, text } = await this.request("POST", path, { jsonBody: payload });
    if (status === 200) return (json as { message?: T } | undefined)?.message as T;
    return this.throwHttp("POST", `${this.base}${path}`, status, json, text);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build an ErpNextClient from resolved flags. `overrides` lets tests/embeds
 * point at a different server or shorten the timeout without touching env.
 *
 *   const erp = createErpNextClient(flags);
 *   const erp = createErpNextClient(flags, { timeoutMs: 5000 });
 *
 * Throws (fail-fast) if credentials are unresolved — same stance as
 * _seedlib.make_client(), so a misconfigured run dies loudly instead of
 * silently 401-ing on every call.
 */
export function createErpNextClient(
  flags: Pick<OrchestratorFlags, "ERPNEXT_URL" | "ERPNEXT_API_KEY" | "ERPNEXT_API_SECRET">,
  overrides: Partial<ErpNextClientOptions> = {},
): ErpNextClient {
  const baseUrl = overrides.baseUrl ?? flags.ERPNEXT_URL;
  const apiKey = overrides.apiKey ?? flags.ERPNEXT_API_KEY;
  const apiSecret = overrides.apiSecret ?? flags.ERPNEXT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new ErpNextError(
      "auth",
      "ERPNext API key/secret not resolved. Set ERPNEXT_API_KEY / ERPNEXT_API_SECRET in IMPL-V6/.env " +
        "(or pass overrides). The client will not issue unauthenticated calls.",
    );
  }

  return new ErpNextClient({
    baseUrl,
    apiKey,
    apiSecret,
    timeoutMs: overrides.timeoutMs,
  });
}
