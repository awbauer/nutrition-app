/**
 * Choosing a food from gathered candidates: pure, no I/O. matcher.ts gathers the candidates (the
 * user's history, local foods, USDA, FatSecret) and acts on the decision (caching the food,
 * falling back to an estimate); this module only ranks and decides, so it can be tested and
 * evaluated offline (test/golden.test.ts runs it over real matching cases).
 */
import { historyBonus } from './history';
import { MATCH_CONFIG, type MatchConfig } from './match-config';
import { brandWords, scoreCandidate, type Candidate, type ScoredCandidate } from './scoring';

/** Where a candidate came from; for an accepted candidate this is also how the item was matched. */
export type Origin = 'history' | 'custom' | 'cache' | 'usda' | 'fatsecret';

export interface MatchOption extends Candidate {
  /** Unique within a request: 'food:<id>', 'usda:<fdcId>' or 'fatsecret:<id>'. */
  key: string;
  origin: Origin;
  /** A food the user has eaten: how often, and the words they used for it. */
  history?: { times: number; names: string[] };
}

export interface DecideRequest {
  /** The item as described ("Chick-fil-A Polynesian Sauce"); history is scored against it. */
  name: string;
  /** What was searched (search term, with the brand in front when it wasn't already); everything else is scored against it. */
  query: string;
  brand?: string | null;
  /** The model's (or the label's) kcal per 100 g, the plausibility reference. */
  estimateKcal100: number | null;
  /** The description pointed at the user's history ("those meatballs I like"). */
  fromHistory?: boolean;
}

export interface Decision<T extends MatchOption> {
  /** Every option, best first (ties keep the input order). */
  ranked: ScoredCandidate<T>[];
  /** The option to use, or null when none scored `acceptScore`: use the model's estimate. */
  chosen: ScoredCandidate<T> | null;
  /** How sure the match is (independent of the amount). */
  confidence: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Score one option. History is scored on the item's name under each name it's been logged as, plus a familiarity bonus. */
function scoreOption<T extends MatchOption>(req: DecideRequest, o: T, brand: { query: Set<string>; name: Set<string> }, cfg: MatchConfig): ScoredCandidate<T> {
  if (!o.history) return scoreCandidate(req.query, o, req.estimateKcal100, brand.query, cfg);
  const h = o.history;
  const best = [o.name, ...h.names].map((name) => scoreCandidate(req.name, { ...o, name }, req.estimateKcal100, brand.name, cfg)).sort((a, b) => b.score - a.score)[0]!;
  const bonus = historyBonus({ times: h.times, names: h.names, food: { name: o.name } }, req.name, !!req.fromHistory, cfg);
  return {
    candidate: o,
    score: round2(best.score + bonus),
    reasons: [...best.reasons, `you've had it ${h.times}×`],
    parts: bonus ? { ...best.parts, history: bonus } : best.parts,
    missing: best.missing,
  };
}

/** Map a score to match confidence: acceptScore → confidenceAtAccept, confidentScore and up → confidenceAtConfident. */
export function matchConfidence(score: number, cfg: MatchConfig = MATCH_CONFIG): number {
  const d = cfg.decision;
  const t = Math.min(1, Math.max(0, (score - d.acceptScore) / (d.confidentScore - d.acceptScore)));
  return d.confidenceAtAccept + (d.confidenceAtConfident - d.confidenceAtAccept) * t;
}

/** Rank the options and decide which (if any) to use. */
export function decide<T extends MatchOption>(req: DecideRequest, options: T[], cfg: MatchConfig = MATCH_CONFIG): Decision<T> {
  // Brand words are recognised across every option, so "chick fil" counts as brand for all of them.
  const brand = { query: brandWords(req.query, options, req.brand, cfg), name: brandWords(req.name, options, req.brand, cfg) };
  const ranked = options.map((o) => scoreOption(req, o, brand, cfg)).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best && best.score >= cfg.decision.acceptScore) return { ranked, chosen: best, confidence: matchConfidence(best.score, cfg) };
  return { ranked, chosen: null, confidence: cfg.decision.estimateConfidenceCap };
}
