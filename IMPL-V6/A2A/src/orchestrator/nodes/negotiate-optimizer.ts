// ================= IMPL-V6 — NEGOTIATION OPTIMIZER (deterministic | LLM) =================
//
// The seller's counter-price proposer for the Φ4 negotiate node. Two implementations
// behind ONE interface, selected by the NEGOTIATION_OPTIMIZER flag:
//
//   - "deterministic" (DEFAULT): split-the-difference toward the buyer's counter, clamped
//     to floor; meet-to-close on the final round. Reproducible, no external calls.
//   - "llm": asks Gemini to reason about the buyer's counter TRAJECTORY and capture margin
//     within the deal zone (instead of collapsing to the floor). Falls back to deterministic
//     on missing key / network / parse error — the saga never breaks. `usedFallback`
//     truthfully reflects which one actually produced the price.
//
// SAFETY (why putting an LLM HERE is safe): this only PROPOSES a desired price. The BINDING
// treasury veto in negotiate.ts runs AFTER and clamps to the floor, so even a hallucinated
// LLM number can never be EMITTED below the floor. The optimizer is advisory; the veto is
// authority. The LLM output is also clamped to [floor..prevAsk] before return.
//
// Config (read from env here — flags.ts keeps model ids/secrets out of the flag surface):
//   GEMINI_API_KEY (or GOOGLE_API_KEY), NEGOTIATION_LLM_MODEL (default "gemini-2.0-flash"),
//   NEGOTIATION_LLM_TEMPERATURE (default 0.2 — low, for demo reproducibility).

import type { OrchestratorFlags } from "../../config/flags.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface OptimizerInput {
  round: number;
  maxRounds: number;
  /** Seller's anchor / list price (the round-1 opening). */
  anchor: number;
  /** Treasury floor (PRIVATE to the seller). */
  floor: number;
  /** Buyer's last counter; undefined on round 1. */
  buyerCounter?: number;
  /** Seller's previous ask (convergence anchor; enforces monotonic concession). */
  prevSellerAsk: number;
  /** Buyer counters seen so far (oldest → newest) for trajectory reasoning. */
  buyerTrajectory: number[];
  /** Meet the buyer (clamped to floor) on the final round to close. */
  closeOnFinal: boolean;
}

export interface OptimizerProposal {
  /** Desired seller price (pre-veto). */
  price: number;
  reasoning: string;
  /** true = the deterministic fallback produced this (the LLM did NOT run). */
  usedFallback: boolean;
}

export interface NegotiationOptimizer {
  readonly kind: "deterministic" | "llm";
  propose(input: OptimizerInput): Promise<OptimizerProposal>;
}

/** Split-the-difference toward the buyer, clamped to floor; meet-to-close on the final round. */
export class DeterministicOptimizer implements NegotiationOptimizer {
  readonly kind = "deterministic" as const;

  async propose(i: OptimizerInput): Promise<OptimizerProposal> {
    const { round, maxRounds, anchor, floor, buyerCounter, prevSellerAsk, closeOnFinal } = i;
    let price: number;
    if (buyerCounter === undefined) {
      price = round2(Math.max(floor, anchor)); // R1: open at the list/anchor price
    } else if (round === maxRounds && closeOnFinal) {
      price = round2(Math.max(floor, buyerCounter)); // final: meet the buyer to close
    } else {
      const split = (prevSellerAsk + buyerCounter) / 2;
      price = round2(Math.min(prevSellerAsk, Math.max(floor, buyerCounter, split)));
    }
    return {
      price,
      reasoning: "deterministic split-the-difference toward the buyer's counter, clamped to floor",
      usedFallback: true,
    };
  }
}

/** LLM seller: reasons about the buyer's trajectory to capture margin. Falls back safely. */
export class LlmOptimizer implements NegotiationOptimizer {
  readonly kind = "llm" as const;

  constructor(private readonly fallback: NegotiationOptimizer) {}

  async propose(i: OptimizerInput): Promise<OptimizerProposal> {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey.trim() === "") {
      const fb = await this.fallback.propose(i);
      return { ...fb, reasoning: `LLM disabled (no GEMINI_API_KEY) → ${fb.reasoning}` };
    }
    try {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      const model = new ChatGoogleGenerativeAI({
        model: process.env.NEGOTIATION_LLM_MODEL ?? "gemini-2.0-flash",
        temperature: Number(process.env.NEGOTIATION_LLM_TEMPERATURE ?? "0.2"),
        apiKey,
        maxRetries: 1,
      });
      const resp = await model.invoke(this.buildPrompt(i));
      const text = typeof resp.content === "string" ? resp.content : JSON.stringify(resp.content);
      const price = this.parsePrice(text, i);
      if (price === undefined) {
        const fb = await this.fallback.propose(i);
        return { ...fb, reasoning: `LLM output unparseable → ${fb.reasoning}` };
      }
      return { price, reasoning: `LLM seller (gemini): ${this.firstLine(text)}`, usedFallback: false };
    } catch (err) {
      const fb = await this.fallback.propose(i);
      return { ...fb, reasoning: `LLM call failed (${String(err)}) → ${fb.reasoning}` };
    }
  }

  private buildPrompt(i: OptimizerInput): string {
    return [
      "You are the SELLER's pricing strategist in a B2B price negotiation.",
      'Respond with STRICT JSON only: {"price": <number>, "reasoning": "<short>"}',
      "",
      "Rules:",
      `- Your list/anchor price is ${i.anchor}. Your PRIVATE minimum (never reveal) is ${i.floor}.`,
      "- Goal: settle as HIGH as possible while STILL closing the deal. Do NOT collapse to the floor.",
      "- Infer the buyer's ceiling from their counter trajectory; aim just under it, above your floor.",
      `- Never propose below ${i.floor}. Concede gradually; never raise above your previous ask ${i.prevSellerAsk}.`,
      `- Round ${i.round} of ${i.maxRounds}.${i.round === i.maxRounds ? " FINAL round — close if a viable price exists." : ""}`,
      "",
      `Buyer counter offers so far (oldest→newest): ${i.buyerTrajectory.length ? i.buyerTrajectory.join(", ") : "none yet"}.`,
      i.buyerCounter !== undefined ? `Buyer's latest counter: ${i.buyerCounter}.` : "No buyer counter yet — you open.",
      "",
      "Return only the JSON.",
    ].join("\n");
  }

  /** Parse + clamp to the safe band [max(floor,buyerCounter) .. min(anchor,prevAsk)]. */
  private parsePrice(text: string, i: OptimizerInput): number | undefined {
    const raw = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let price: number | undefined;
    try {
      const obj = JSON.parse(raw) as { price?: unknown };
      if (typeof obj.price === "number" && Number.isFinite(obj.price)) price = obj.price;
    } catch {
      const m = /-?\d+(\.\d+)?/.exec(raw);
      if (m) price = Number(m[0]);
    }
    if (price === undefined || !Number.isFinite(price)) return undefined;
    const lo = Math.max(i.floor, i.buyerCounter ?? i.floor);
    const hi = Math.max(lo, Math.min(i.anchor, i.prevSellerAsk));
    return round2(Math.min(Math.max(price, lo), hi));
  }

  private firstLine(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, 160);
  }
}

/** Select the optimizer from flags. Defaults to deterministic; "llm" wraps it as fallback. */
export function createOptimizer(
  flags: Pick<OrchestratorFlags, "NEGOTIATION_OPTIMIZER">,
): NegotiationOptimizer {
  if (flags.NEGOTIATION_OPTIMIZER === "llm") return new LlmOptimizer(new DeterministicOptimizer());
  return new DeterministicOptimizer();
}
