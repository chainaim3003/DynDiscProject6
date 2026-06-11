// ================= IMPL-V6 — identity-client / delegation resolver =================
//
// Resolves an agentRef (binding-map key) to its KERI AID + delegation metadata,
// by reading identity/binding-map.json and the referenced agent card. Realizes
// REFINED-Project-Structure.md §2 (identity-client/delegation.ts) +
// REFINED-MultiAgent-Design-vLEI.md §4 (the delegated-AID chain).
//
// SELF-CONTAINED on purpose: reads the binding map + cards with fs, using the
// types already defined in ../identity/CredentialProvider.ts (BindingMap,
// BindingEntry, AgentCard, AidResolution). It does NOT depend on the existing
// agent-card-loader's internal signatures, so it can't drift from them.
//
// HONEST (Rule 2/8 — NO fabrication): the sub-agent cards are "placeholder" in
// binding-map.json (not yet generated on Host B). When a card is missing or
// carries no agentAID, resolve to status="placeholder" with aid="" — never an
// invented AID. The interface contract requires exactly this.

import fs from "node:fs";
import path from "node:path";

import type { IdentityFlags } from "../config/identity-flags.js";
import type {
  AgentCard,
  AidResolution,
  BindingEntry,
  BindingMap,
} from "../identity/CredentialProvider.js";

/** Read + parse identity/binding-map.json. Throws (loud) if absent/malformed. */
export function loadBindingMapFile(bindingMapPath: string): BindingMap {
  const resolved = path.resolve(bindingMapPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`[delegation] binding map not found at ${resolved} (flags.BINDING_MAP)`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw) as BindingMap;
}

export type BindingKind = "principal" | "subAgent";

/** Locate an agentRef in the binding map (principals first, then sub-agents). */
export function findBindingEntry(
  map: BindingMap,
  agentRef: string,
): { entry: BindingEntry; kind: BindingKind } | null {
  if (map.principals && agentRef in map.principals) {
    return { entry: map.principals[agentRef]!, kind: "principal" };
  }
  if (map.subAgents && agentRef in map.subAgents) {
    return { entry: map.subAgents[agentRef]!, kind: "subAgent" };
  }
  return null;
}

/**
 * Resolve the on-disk path of an entry's card. Sub-agent card values already
 * include the "subagents/" prefix (per binding-map.json), so both kinds resolve
 * against AGENT_CARDS_DIR. (SUBAGENT_CARDS_DIR is kept in flags for callers that
 * store sub-agent cards in a separate tree.)
 */
export function resolveCardPath(idf: Readonly<IdentityFlags>, entry: BindingEntry): string {
  return path.resolve(path.join(idf.AGENT_CARDS_DIR, entry.card));
}

/** Read a card if present; null if the file does not exist yet (placeholder). */
export function loadCardIfPresent(cardPath: string): AgentCard | null {
  if (!fs.existsSync(cardPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cardPath, "utf8")) as AgentCard;
  } catch (err) {
    throw new Error(`[delegation] card at ${cardPath} is not valid JSON: ${String(err)}`);
  }
}

/**
 * Resolve an agentRef to its AID + role metadata. Reads the binding entry, then
 * the card (if synced). Missing card / missing agentAID → status="placeholder",
 * aid="" (honest — the chain isn't minted yet on Host B).
 */
export function resolveAidFromBinding(
  agentRef: string,
  idf: Readonly<IdentityFlags>,
  preloadedMap?: BindingMap,
): AidResolution {
  const map = preloadedMap ?? loadBindingMapFile(idf.BINDING_MAP);
  const found = findBindingEntry(map, agentRef);
  if (!found) {
    throw new Error(
      `[delegation] no binding-map entry for agentRef="${agentRef}". Known: ` +
        `${[...Object.keys(map.principals ?? {}), ...Object.keys(map.subAgents ?? {})].join(", ")}`,
    );
  }

  const { entry } = found;
  const card = loadCardIfPresent(resolveCardPath(idf, entry));

  const agentAid = card?.extensions?.keriIdentifiers?.agentAID ?? "";
  let delegatorAid =
    card?.extensions?.vLEImetadata?.delegatorAID ??
    card?.extensions?.keriIdentifiers?.oorHolderAID;

  // Sub-delegation chain (grounded in vLEIEnh1/.../configBuyerSellerAIAgent1-with-subdelegation.json):
  // sub-agents are sub-delegated FROM the seller AGENT, not from a distinct ECR officer. So if the
  // card carries no explicit delegatorAID and delegatedFrom names ANOTHER agent in the map
  // (e.g. "jupiterSellerAgent"), anchor the delegator to THAT agent's resolved AID. No fabrication:
  // if the parent card is absent, delegatorAid stays undefined (placeholder).
  if ((!delegatorAid || delegatorAid === "") && entry.delegatedFrom) {
    const parent = findBindingEntry(map, entry.delegatedFrom);
    if (parent) {
      const parentCard = loadCardIfPresent(resolveCardPath(idf, parent.entry));
      const parentAid = parentCard?.extensions?.keriIdentifiers?.agentAID;
      if (parentAid && parentAid !== "") delegatorAid = parentAid;
    }
  }

  // "active" only when the binding says active AND a real AID is on the card.
  const status = entry.status === "active" && agentAid !== "" ? "active" : "placeholder";

  return {
    agentRef,
    aid: agentAid,
    roleType: entry.roleType,
    role: entry.role,
    holder: entry.holder,
    lei: entry.lei,
    delegatorAid: delegatorAid && delegatorAid !== "" ? delegatorAid : undefined,
    status,
  };
}
