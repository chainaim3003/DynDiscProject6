// ================= IMPL-V6 — agent-card + binding-map LOADER =================
//
// Reads the on-disk agent cards and identity/binding-map.json and turns them
// into the typed shapes in CredentialProvider.ts. The binding map is the index
// (agent → role → card filename); the CARD is the source of truth for AIDs.
//
// No fabrication (userPreferences Rule 2): a missing file or missing AID is
// reported with the exact path that failed, never silently defaulted. The
// caller decides what to do (PlainJsonProvider treats a missing AID as
// status="placeholder"; it does NOT invent one).

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type {
  AgentCard,
  BindingEntry,
  BindingMap,
} from "./CredentialProvider.js";
import type { IdentityFlags } from "../config/identity-flags.js";

/** Resolve a possibly-relative config path against the process CWD. */
function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** Read + parse the binding map. Throws with the exact path on failure. */
export async function loadBindingMap(flags: IdentityFlags): Promise<BindingMap> {
  const path = resolvePath(flags.BINDING_MAP);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[identity] cannot read BINDING_MAP at "${path}": ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[identity] BINDING_MAP at "${path}" is not valid JSON: ${msg}`);
  }
  const map = parsed as BindingMap;
  if (!map || typeof map !== "object" || !map.principals || !map.subAgents) {
    throw new Error(
      `[identity] BINDING_MAP at "${path}" is missing required keys "principals"/"subAgents"`,
    );
  }
  return map;
}

/** Look up one agent's binding entry by ref (searches principals then subAgents). */
export function findBinding(map: BindingMap, agentRef: string): BindingEntry {
  const entry = map.principals[agentRef] ?? map.subAgents[agentRef];
  if (!entry) {
    const known = [
      ...Object.keys(map.principals),
      ...Object.keys(map.subAgents),
    ].join(", ");
    throw new Error(
      `[identity] no binding for agentRef="${agentRef}". Known agents: ${known}`,
    );
  }
  return entry;
}

/**
 * Read + parse one agent card. `cardsDir` is the principal dir; sub-agent cards
 * carry a "subagents/..." prefix in their `card` field, so a single join works
 * for both as long as cardsDir is the dir that contains "subagents/".
 *
 * NOTE on layout: DEFAULT_IDENTITY_FLAGS.AGENT_CARDS_DIR is "./agent-cards"
 * (the existing on-disk location) while sub-agent cards live under
 * "./identity/agent-cards/subagents". When the cards are migrated under
 * identity/ per the design, set AGENT_CARDS_DIR=./identity/agent-cards and both
 * resolve from one root. Until then, sub-agent cards (placeholders) won't exist
 * and loadAgentCard will throw a clear "card not found" — which is correct.
 */
export async function loadAgentCard(
  cardsDir: string,
  cardFile: string,
): Promise<AgentCard> {
  const path = join(resolvePath(cardsDir), cardFile);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[identity] cannot read agent card at "${path}": ${msg}`);
  }
  try {
    return JSON.parse(text) as AgentCard;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[identity] agent card at "${path}" is not valid JSON: ${msg}`);
  }
}

/** Pull the agent's own AID from a card (extensions.keriIdentifiers.agentAID). */
export function agentAidFromCard(card: AgentCard): string | undefined {
  return card.extensions?.keriIdentifiers?.agentAID
    ?? card.extensions?.vLEImetadata?.delegateeAID;
}

/** Pull the delegator AID from a card, when present. */
export function delegatorAidFromCard(card: AgentCard): string | undefined {
  return card.extensions?.keriIdentifiers?.oorHolderAID
    ?? card.extensions?.vLEImetadata?.delegatorAID;
}
