/**
 * Ranks food-database candidates for a described food.
 *
 * USDA search order is a text-relevance ranking that happily puts "Fish oil, salmon" first
 * for "salmon sashimi". We re-rank with signals that matter for nutrition:
 * - how many of the query's words the candidate covers (brand words count less than the words
 *   naming the item), and whether its main segment is about the query at all
 * - penalties for extra qualifiers and for product types the user didn't mention
 *   (baby food, oils, powders, infant formula ...)
 * - a prior for database type (generic whole foods over branded products)
 * - plausibility: kcal per 100 g compared with the model's own rough estimate.
 *   A 5x mismatch is almost always the wrong food.
 * - popularity, ranked by how much it says: the user's own log (history bonus, in history.ts) far
 *   outweighs how often Americans eat a survey food (NHANES WWEIA), which outweighs FatSecret's own
 *   result order. "Ham" (eaten on 153 survey days) beats "Ham stroganoff" (0).
 *
 * All weights and word lists are in match-config.ts. Each score comes with `parts` (feature →
 * contribution) for analysis and `reasons` (short human strings) for the UI.
 */
import { WWEIA_DAYS } from '../data/wweia-popularity';
import { normName } from './foods';
import { MATCH_CONFIG, type MatchConfig } from './match-config';

export interface Candidate {
  name: string;
  brand?: string | null;
  dataType?: string | null;
  kcal100?: number | null;
  /** Position in the source's own result list (0 = first), where the source orders by popularity. */
  sourceRank?: number | null;
}

/** What a score is made of. */
export type Feature = 'coverage' | 'head' | 'extras' | 'kind' | 'brand' | 'prior' | 'popularity' | 'plausibility' | 'history';

export interface ScoredCandidate<T extends Candidate> {
  candidate: T;
  score: number;
  /** Short human strings for the UI ("3/4 words", "unrequested: oil"). */
  reasons: string[];
  /** Feature → contribution to `score` (before rounding); features that added nothing are left out. */
  parts: Partial<Record<Feature, number>>;
  /** Query words naming the item (not brand or neutral words) that the candidate doesn't have. */
  missing: string[];
}

/** Word lists as sets, built once per config. */
interface Lists {
  stop: Set<string>;
  distinct: string[];
  neutral: Set<string>;
}
const lists = new WeakMap<MatchConfig, Lists>();
function wordLists(cfg: MatchConfig): Lists {
  let l = lists.get(cfg);
  if (!l) lists.set(cfg, (l = { stop: new Set(cfg.words.stop), distinct: cfg.words.distinct, neutral: new Set(cfg.words.neutral) }));
  return l;
}

export const stem = (t: string) => t.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');

export function tokens(s: string, cfg: MatchConfig = MATCH_CONFIG): string[] {
  const stop = wordLists(cfg).stop;
  return normName(s)
    .split(' ')
    .filter((t) => t.length > 1 && !stop.has(t));
}

export const has = (set: Set<string>, t: string) => set.has(t) || set.has(stem(t)) || [...set].some((x) => stem(x) === stem(t));

/**
 * How commonly a candidate is eaten, as a score adjustment: -0.15..+0.2 for survey (FNDDS) foods from
 * how many NHANES recall days included them, up to +0.06 for FatSecret's top results, 0 otherwise.
 */
export function popularity(c: Candidate, cfg: MatchConfig = MATCH_CONFIG): { bonus: number; reason: string | null } {
  const p = cfg.popularity;
  if (c.dataType === 'Survey (FNDDS)') {
    const days = WWEIA_DAYS[normName(c.name)];
    if (days === undefined) return { bonus: 0, reason: null };
    const bonus = Math.max(p.wweiaMin, Math.min(p.wweiaMax, p.wweiaPerDecade * (Math.log10(days + 1) - Math.log10(p.wweiaMedianDays + 1))));
    return { bonus, reason: days ? `eaten on ${days} survey days` : 'rarely eaten' };
  }
  if ((c.dataType === 'FatSecret' || c.dataType === 'FatSecret Brand') && c.sourceRank != null && c.sourceRank < p.fatsecretDepth)
    return { bonus: p.fatsecretTop * (1 - c.sourceRank / p.fatsecretDepth), reason: c.sourceRank < p.fatsecretShown ? `FatSecret #${c.sourceRank + 1}` : null };
  return { bonus: 0, reason: null };
}

/**
 * The words of a candidate's brand that the query mentions. A food word that the brand happens to
 * share with the name doesn't count unless the whole brand is there: "chicken meatballs" doesn't
 * mention "Meatballs by Amylu" (whose product is "Chicken Meatballs with Basil"), but "Heinz ketchup"
 * mentions HEINZ on "HEINZ, TOMATO KETCHUP".
 */
function mentionedBrand(qset: Set<string>, brand: string[], name: Set<string>): string[] {
  const hit = brand.filter((t) => qset.has(t));
  if (!hit.length || hit.length === brand.length) return hit;
  return hit.filter((t) => !name.has(t));
}

/**
 * The query's words that name a brand rather than the item: those mentioning a candidate's brand
 * ("chick", "fil" in "Chick-fil-A Polynesian Sauce" when any candidate's brand is Chick-fil-A).
 */
export function brandWords(query: string, cs: Pick<Candidate, 'brand' | 'name'>[], extraBrand?: string | null, cfg: MatchConfig = MATCH_CONFIG): Set<string> {
  const q = new Set(tokens(query, cfg));
  const out = new Set<string>();
  if (extraBrand) for (const t of mentionedBrand(q, tokens(extraBrand, cfg), new Set())) out.add(t);
  for (const c of cs) if (c.brand) for (const t of mentionedBrand(q, tokens(c.brand, cfg), new Set(tokens(c.name, cfg)))) out.add(t);
  return out;
}

/**
 * Score one candidate. `brand` is the query's brand words (see brandWords); without it, only this
 * candidate's own brand is recognised.
 */
export function scoreCandidate<T extends Candidate>(
  query: string,
  c: T,
  estimateKcal100?: number | null,
  brand?: Set<string>,
  cfg: MatchConfig = MATCH_CONFIG,
): ScoredCandidate<T> {
  const { distinct, neutral } = wordLists(cfg);
  const reasons: string[] = [];
  const parts: Partial<Record<Feature, number>> = {};
  let score = 0;
  const add = (f: Feature, v: number) => {
    if (!v) return;
    parts[f] = (parts[f] ?? 0) + v;
    score += v;
  };
  const q = tokens(query, cfg);
  const qset = new Set(q);
  const nameTokens = tokens(c.name, cfg);
  const nset = new Set(nameTokens);
  const brandTokens = c.brand ? tokens(c.brand, cfg) : [];
  const bset = new Set(brandTokens);
  const mentioned = mentionedBrand(qset, brandTokens, nset);
  const bw = brand ?? new Set(mentioned);
  // The main segment is the first that isn't only the brand: "McDONALD'S, BIG MAC" is about a Big Mac.
  const segments = c.name.split(',').map((s) => tokens(s, cfg));
  const head = new Set(segments.find((seg) => seg.some((t) => !bw.has(t))) ?? segments[0] ?? []);

  // Coverage of the query's words, by the name or the brand field. A brand word counts less: the brand
  // says whose product it is, the other words say which one ("polynesian" in "Chick-fil-A Polynesian Sauce").
  // Counting the brand in full let a name that spells the brand ("CHICK-FIL-A SAUCE") outscore the
  // product asked for, whose brand is only in the brand field.
  const weight = (t: string) => (bw.has(t) ? cfg.coverage.brandWordWeight : 1);
  const covered = q.filter((t) => has(nset, t) || (bw.has(t) && bset.has(t)));
  const total = q.reduce((s, t) => s + weight(t), 0);
  const coverage = total ? covered.reduce((s, t) => s + weight(t), 0) / total : 0;
  add('coverage', coverage * cfg.coverage.full);
  reasons.push(`${covered.length}/${q.length} words`);
  const missing = q.filter((t) => !bw.has(t) && !neutral.has(t) && !covered.includes(t));
  if (missing.length && covered.length) reasons.push(`missing: ${missing.join(', ')}`);

  // The main segment must be about the query ("Fish oil, salmon" is oil, not salmon).
  const headHits = [...head].filter((t) => has(qset, t)).length;
  if (headHits) add('head', cfg.head.hit);
  else {
    add('head', cfg.head.miss);
    reasons.push('main word differs');
  }

  // Extra qualifiers dilute the match a little.
  const extras = nameTokens.filter((t) => !has(qset, t) && !neutral.has(t)).length;
  add('extras', -Math.min(extras, cfg.extras.maxWords) * cfg.extras.perWord);

  // Product types the user didn't ask for.
  const wrongKind = distinct.filter((w) => nset.has(w) && !has(qset, w));
  if (wrongKind.length) {
    add('kind', cfg.kind.unrequested);
    reasons.push(`unrequested: ${wrongKind.join(', ')}`);
  }

  // Branded products only when a brand was mentioned.
  if (mentioned.length) add('brand', cfg.brand.mentioned);
  else add('prior', cfg.dataTypePrior[c.dataType ?? ''] ?? 0);

  // How commonly it's eaten.
  const pop = popularity(c, cfg);
  add('popularity', pop.bonus);
  if (pop.reason) reasons.push(pop.reason);

  // Plausibility against the model's estimate.
  const pl = cfg.plausibility;
  if (estimateKcal100 != null && estimateKcal100 > 0 && c.kcal100 != null) {
    const ratio = (c.kcal100 + pl.kcalOffset) / (estimateKcal100 + pl.kcalOffset);
    const off = Math.abs(Math.log(ratio));
    // Full credit for a close match, tapering to none at taperRatio: a cliff at one ratio let a rare dish that
    // happened to fit the estimate beat the common food just outside it ("Ham stroganoff" over "Ham").
    if (off <= Math.log(pl.taperRatio)) add('plausibility', pl.closeBonus * (1 - off / Math.log(pl.taperRatio)));
    else if (off > Math.log(pl.rejectRatio)) {
      add('plausibility', pl.rejectPenalty);
      reasons.push(`kcal ${Math.round(c.kcal100)} vs ~${Math.round(estimateKcal100)} expected`);
    } else add('plausibility', pl.farPenalty);
  }

  return { candidate: c, score: Math.round(score * 100) / 100, reasons, parts, missing };
}

/** Rank candidates for a query; brand words are recognised across the whole set (and `brand`, when given). */
export function rankCandidates<T extends Candidate>(
  query: string,
  cs: T[],
  estimateKcal100?: number | null,
  brand?: string | null,
  cfg: MatchConfig = MATCH_CONFIG,
): ScoredCandidate<T>[] {
  const bw = brandWords(query, cs, brand, cfg);
  return cs.map((c) => scoreCandidate(query, c, estimateKcal100, bw, cfg)).sort((a, b) => b.score - a.score);
}

/** Minimum score to accept a candidate automatically; below it we fall back to the estimate. */
export const ACCEPT_SCORE = MATCH_CONFIG.decision.acceptScore;
/** Below this the match is shaky: lower item confidence so the UI flags it. */
export const CONFIDENT_SCORE = MATCH_CONFIG.decision.confidentScore;
