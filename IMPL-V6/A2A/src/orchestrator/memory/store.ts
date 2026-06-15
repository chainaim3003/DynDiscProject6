// ================= IMPL-V6 — T3 SEMANTIC STORE =================
//
// Factory for the cross-thread semantic Store (T3, 01 §3). Backend gated by
// flags.MEMORY_STORE_KIND.
//
// SCOPE / HONEST LIMITATIONS (01 §7 items 5 & 6):
//   - "memory" (the .env DEFAULT): LangGraph's InMemoryStore — fully functional
//     for namespaced put/get/list (buyer profile, past deals, demand portfolio,
//     item specs, buyer-safe projections). Ephemeral, but 01 §3 notes T3 is
//     RECONSTRUCTIBLE from T2 + T4, so this is a valid default.
//   - "sqlite" / "postgres": NOT yet wired. LangGraph.js has no confirmed
//     persistent BaseStore impl (01 §7 item 5); a thin adapter is required.
//     We throw an explicit, named error rather than silently degrade — this is
//     a guarded gap, not a stub pretending to work.
//   - Semantic-search INDEXING (Gemini text-embedding-004 via @langchain/
//     google-genai) is intentionally NOT imported here: the embeddings class
//     name is unverified (01 §7 item 6) and it would require a live API key
//     during testing. The plug-in point is documented below (InMemoryStore's
//     `index` option) for when EMBEDDING_MODEL is wired.
//
// API NOTE (Rule 3): `InMemoryStore` from @langchain/langgraph is verified by
// `npm run typecheck`; if the export differs in 1.3.6 the error will pinpoint it.

import { InMemoryStore } from "@langchain/langgraph";

import { loadFlags, type OrchestratorFlags } from "../../config/flags.js";

export interface StoreOptions {
  /** Inject pre-resolved flags (else loadFlags() is called). */
  flags?: Readonly<OrchestratorFlags>;
}

/**
 * Build the T3 Store. Returns an InMemoryStore for MEMORY_STORE_KIND="memory";
 * throws (explicitly) for the not-yet-wired persistent backends.
 *
 * Semantic indexing hook (deferred): when EMBEDDING_MODEL wiring lands, the
 * memory branch becomes
 *   new InMemoryStore({ index: { embeddings, dims, fields: ["$"] } })
 * with `embeddings` = a GoogleGenerativeAIEmbeddings({ model: flags.EMBEDDING_MODEL })
 * once that class name is confirmed (01 §7 item 6).
 */
export function createStore(opts: StoreOptions = {}): InMemoryStore {
  const flags = opts.flags ?? loadFlags();

  switch (flags.MEMORY_STORE_KIND) {
    case "memory":
      return new InMemoryStore();

    case "sqlite":
    case "postgres":
      throw new Error(
        `[store] MEMORY_STORE_KIND="${flags.MEMORY_STORE_KIND}" is not yet wired. ` +
        `LangGraph.js has no confirmed persistent Store implementation for this ` +
        `(see 01-Prompts-Schema-Structure.md §7 item 5 — a thin BaseStore adapter ` +
        `is required). Use MEMORY_STORE_KIND=memory until that adapter exists.`,
      );

    default: {
      // Exhaustiveness guard — if MemoryStoreKind grows, this fails to compile.
      const _exhaustive: never = flags.MEMORY_STORE_KIND;
      throw new Error(`[store] unknown MEMORY_STORE_KIND: ${String(_exhaustive)}`);
    }
  }
}
