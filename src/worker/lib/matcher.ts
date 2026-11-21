/**
 * Food matching cascade (spec §4):
 * 1. the user's own corrections (food_alias) and exact custom foods / recipes
 * 2. barcode: Open Food Facts, then USDA Branded by GTIN
 * 2b. nutrition printed on the package (read from a photo): saved as the user's own food
 * 3. foods the user has eaten before (found by meaning, scored on words, boosted by how often),
 *    and the local food cache, accepted only if they score well
 * 4. USDA FoodData Central (one search across Foundation, SR Legacy, FNDDS and Branded) and, when
 *    configured, FatSecret (restaurant chains, newer products), searched together and re-ranked by
 *    `scoring.ts` (word coverage, main word, product type, kcal plausibility)
 * 5. no acceptable match: model estimate, flagged `estimated`, confidence capped at 0.4
 *
 * Every result carries the candidates that were considered so the UI can show them
 * and the user can switch to another.
 */
import type { Env } from '../env';
import type { LabelFacts } from './ai';
import { cacheFood, createCustomFood, exactCustom, findCachedBySource, getFood, normName, searchLocal, usdaClient, type ExternalFood, type FoodRecord } from './foods';
import { fatsecretClient } from './fatsecret';
import { newId } from './ids';
import { NUTRIENT_BY_CODE } from './nutrients';
import { offByBarcode } from './off';
import { searchHistory } from './history';
import { CONFIDENT_SCORE, type ScoredCandidate } from './scoring';
import { decide, type DecideRequest, type MatchOption, type Origin } from './decide';
import { MATCH_CONFIG } from './match-config';
import type { NormalisedFood } from './usda';

export interface MatchRequest {
  name: string;
  search_terms?: string[];
  barcode?: string | null;
  brand?: string | null;
  label?: LabelFacts | null;
  estimate_per_100g?: { kcal?: number; protein?: number; fat?: number; carbs?: number };
  /** The user pointed at something they've had before: lean harder on their history. */
  from_history?: boolean;
  /** A restaurant / chain menu item: search and score on its full name, not generic search terms. */
  menu_item?: boolean;
}

export type Via = 'alias' | 'favorite' | 'custom' | 'history' | 'cache' | 'barcode' | 'label' | 'usda' | 'fatsecret' | 'off' | 'estimate';

/** Grams in one labelled serving, when the serving is given in a unit we can convert. */
export function labelServingGrams(l: LabelFacts): number | null {
  const u = l.serving_unit.toLowerCase().replace(/\.$/, '');
  if (u === 'g' || u === 'ml' || u === 'gram' || u === 'grams') return l.serving_amount;
  if (u === 'fl oz' || u === 'floz' || u === 'fluid ounce' || u === 'fluid ounces') return l.serving_amount * 29.5735;
  if (u === 'oz') return l.serving_amount * 28.3495;
  return null;
}

/** Label field -> nutrient code (sodium is printed in mg, which is also our unit). */
export const LABEL_CODES = { protein: 'PROCNT', fat: 'FAT', carbs: 'CHOCDF', fiber: 'FIBTG', sugars: 'SUGAR', sat_fat: 'FASAT', sodium: 'NA' } as const;

/** Per-100 g values from a package label (transcribed, so far better than an estimate). */
export function labelPer100(l: LabelFacts): Record<string, number> | null {
  const g = labelServingGrams(l);
  if (!g) return null;
  const f = 100 / g;
  const out: Record<string, number> = { ENERC_KCAL: l.kcal * f };
  for (const [k, code] of Object.entries(LABEL_CODES)) {
    const v = l[k as keyof typeof LABEL_CODES];
    if (v != null) out[code] = v * f;
  }
  return out;
}

/** One option the matcher considered, as stored on the item and shown in the UI. */
export interface MatchCandidate {
  fdc_id?: string; // USDA candidates
  fatsecret_id?: string; // FatSecret candidates
  food_id?: string; // local foods (cache, custom)
  source: string; // usda | off | custom | recipe | estimate
  name: string;
  brand: string | null;
  data_type: string | null;
  kcal_100g: number | null;
  protein_100g: number | null;
  score: number;
  /** Short reasons shown in the UI. */
  notes: string[];
  /** Feature -> contribution to `score` (scoring.ts Feature); absent on older items. */
  parts?: Record<string, number>;
}

export interface MatchInfo {
  query: string;
  via: Via;
  estimate_kcal_100g: number | null;
  candidates: MatchCandidate[];
  /** fdc_id or food_id of the chosen candidate */
  chosen: string | null;
  /** Set when the food database couldn't be reached, so "no match" isn't the real story. */
  lookup_error?: string;
  /** Words naming the item that the chosen food doesn't have ("polynesian"): worth a look. */
  missing_words?: string[];
}

export interface MatchResult {
  food: FoodRecord;
  via: Via;
  match: MatchInfo;
  /** How sure we are the food is right (independent of the amount). */
  matchConfidence: number;
  /** Values come from the actual product (barcode or printed label), not a generic food. */
  fromPackage?: boolean;
}

export const ESTIMATE_CONFIDENCE_CAP = MATCH_CONFIG.decision.estimateConfidenceCap;
const MAX_CANDIDATES = MATCH_CONFIG.decision.maxCandidates;

const per100 = (n: { code: string; value: number }[], code: string) => n.find((x) => x.code === code)?.value ?? null;

export const usdaCandidate = (f: NormalisedFood, score = 0, notes: string[] = []): MatchCandidate => ({
  fdc_id: f.sourceId,
  source: 'usda',
  name: f.name,
  brand: f.brand,
  data_type: f.dataType,
  kcal_100g: per100(f.nutrients, 'ENERC_KCAL'),
  protein_100g: per100(f.nutrients, 'PROCNT'),
  score,
  notes,
});

export const fatsecretCandidate = (f: ExternalFood, score = 0, notes: string[] = []): MatchCandidate => ({
  fatsecret_id: f.sourceId,
  source: 'fatsecret',
  name: f.name,
  brand: f.brand,
  data_type: f.dataType,
  kcal_100g: per100(f.nutrients, 'ENERC_KCAL'),
  protein_100g: per100(f.nutrients, 'PROCNT'),
  score,
  notes,
});

export const localCandidate = (f: FoodRecord, score = 0, notes: string[] = []): MatchCandidate => ({
  food_id: f.id,
  ...(f.source === 'usda' && f.source_id ? { fdc_id: f.source_id } : {}),
  ...(f.source === 'fatsecret' && f.source_id ? { fatsecret_id: f.source_id } : {}),
  source: f.source,
  name: f.name,
  brand: f.brand,
  data_type: f.data_type,
  kcal_100g: per100(f.nutrients, 'ENERC_KCAL'),
  protein_100g: per100(f.nutrients, 'PROCNT'),
  score,
  notes,
});

/** A candidate as gathered: what decide() ranks, plus the food it stands for. */
export type GatheredOption = MatchOption & { food?: FoodRecord; remote?: NormalisedFood | ExternalFood };

const keyOf = (f: { source: string; source_id: string | null; id: string }) =>
  (f.source === 'usda' || f.source === 'fatsecret') && f.source_id ? `${f.source}:${f.source_id}` : `food:${f.id}`;

const localOption = (f: FoodRecord, origin: Origin, history?: { times: number; names: string[] }): GatheredOption => ({
  key: keyOf(f),
  origin,
  name: f.name,
  brand: f.brand,
  dataType: f.data_type,
  kcal100: per100(f.nutrients, 'ENERC_KCAL'),
  ...(history ? { history } : {}),
  food: f,
});

/**
 * Candidates from the user's own data: foods they've eaten (by meaning, when `history`), then the
 * local food cache and their custom foods. No estimates.
 */
export async function gatherLocal(env: Env, userId: string, opts: { name: string; query: string; history: boolean; localMax?: number }): Promise<GatheredOption[]> {
  // History: foods the user has eaten, found by meaning; decide() scores them on their words (under the
  // user's own names too) plus a bonus for familiarity. "Turkey meatballs" is near "chicken meatballs" as
  // a vector but misses a word, so it doesn't win.
  const history = opts.history ? await searchHistory(env, userId, opts.name) : [];
  const historyIds = new Set(history.map((h) => h.food.id));
  const local = (await searchLocal(env.DB, userId, opts.query, opts.localMax ?? MATCH_CONFIG.gather.localMax)).filter((f) => f.source !== 'estimate' && !historyIds.has(f.id));
  return [...history.map((h) => localOption(h.food, 'history', { times: h.times, names: h.names })), ...local.map((f) => localOption(f, f.owner_user_id ? 'custom' : 'cache'))];
}

/**
 * Search USDA (all tiers, one request) and FatSecret (when configured) at once; either failing leaves
 * the other. Foods already among `have` (by source id) are left out.
 */
export async function gatherRemote(
  env: Env,
  query: string,
  have: { key: string }[] = [],
  sizes: { usdaPageSize?: number; fatsecretMax?: number } = {},
): Promise<{ options: GatheredOption[]; lookupError?: string }> {
  const seen = new Set(have.map((o) => o.key));
  const fs = fatsecretClient(env);
  const [usda, fat] = await Promise.allSettled([
    env.USDA_API_KEY ? usdaClient(env).searchAll(query, sizes.usdaPageSize ?? MATCH_CONFIG.gather.usdaPageSize) : Promise.resolve([]),
    fs ? fs.search(query, sizes.fatsecretMax ?? MATCH_CONFIG.gather.fatsecretMax) : Promise.resolve([]),
  ]);
  let lookupError: string | undefined;
  const options: GatheredOption[] = [];
  if (usda.status === 'fulfilled')
    for (const h of usda.value)
      options.push({ key: `usda:${h.sourceId}`, origin: 'usda', name: h.name, brand: h.brand, dataType: h.dataType, kcal100: per100(h.nutrients, 'ENERC_KCAL'), remote: h });
  else {
    lookupError = (usda.reason as Error).message;
    console.warn('USDA search failed', query, lookupError);
  }
  if (fat.status === 'fulfilled')
    fat.value.forEach((h, i) =>
      options.push({
        key: `fatsecret:${h.sourceId}`,
        origin: 'fatsecret',
        name: h.name,
        brand: h.brand,
        dataType: h.dataType,
        kcal100: per100(h.nutrients, 'ENERC_KCAL'),
        sourceRank: i,
        remote: h,
      }),
    );
  else console.warn('FatSecret search failed', query, (fat.reason as Error).message);
  return { options: options.filter((o) => !seen.has(o.key)), ...(lookupError ? { lookupError } : {}) };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A ranked option as stored on the item and shown in the UI. */
export function toMatchCandidate(r: ScoredCandidate<GatheredOption>): MatchCandidate {
  const o = r.candidate;
  const c = o.food
    ? localCandidate(o.food, r.score, r.reasons)
    : o.origin === 'fatsecret'
      ? fatsecretCandidate(o.remote as ExternalFood, r.score, r.reasons)
      : usdaCandidate(o.remote as NormalisedFood, r.score, r.reasons);
  return { ...c, parts: Object.fromEntries(Object.entries(r.parts).map(([k, v]) => [k, round3(v)])) };
}

export async function matchFood(env: Env, userId: string, req: MatchRequest): Promise<MatchResult> {
  const db = env.DB;
  // A menu item is looked up by its menu name: "espresso" as a search term would find a plain shot.
  const base = req.menu_item ? req.name : req.search_terms?.[0] || req.name;
  // Brand-aware search: "fairlife" + "chocolate protein shake" finds the branded product.
  const query = req.brand && !normName(base).includes(normName(req.brand)) ? `${req.brand} ${base}` : base;
  const fromLabel = req.label ? labelPer100(req.label) : null;
  // A printed label beats the model's guess as the plausibility reference.
  const est = fromLabel?.ENERC_KCAL ?? req.estimate_per_100g?.kcal ?? null;
  let lookupError: string | undefined;
  const info = (via: Via, candidates: MatchCandidate[], chosen: string | null): MatchInfo => ({
    query,
    via,
    estimate_kcal_100g: est,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    chosen,
    ...(lookupError ? { lookup_error: lookupError } : {}),
  });

  // 1. The user's corrections, then exact custom foods / recipes.
  for (const term of new Set([req.name, query].map(normName))) {
    const alias = await db.prepare('SELECT food_id FROM food_alias WHERE user_id = ? AND term_norm = ?').bind(userId, term).first<{ food_id: string }>();
    const food = alias && (await getFood(db, userId, alias.food_id));
    if (food) return { food, via: 'alias', match: info('alias', [localCandidate(food, 9, ['your earlier choice'])], food.id), matchConfidence: 1 };
  }
  const custom = await exactCustom(db, userId, req.name);
  if (custom) return { food: custom, via: 'custom', match: info('custom', [localCandidate(custom, 9, ['your food'])], custom.id), matchConfidence: 1 };

  // 2. Barcode: Open Food Facts, then USDA Branded by GTIN.
  if (req.barcode) {
    const cached = await findCachedBySource(db, 'off', req.barcode);
    if (cached) return { food: cached, via: 'barcode', match: info('barcode', [localCandidate(cached, 9, ['barcode'])], cached.id), matchConfidence: 0.95, fromPackage: true };
    try {
      const off = await offByBarcode(req.barcode);
      if (off && off.nutrients.some((n) => n.code === 'ENERC_KCAL')) {
        const food = await cacheFood(db, off);
        return { food, via: 'barcode', match: info('barcode', [localCandidate(food, 9, ['barcode, Open Food Facts'])], food.id), matchConfidence: 0.95, fromPackage: true };
      }
    } catch (e) {
      console.warn('OFF lookup failed', e);
    }
    if (env.USDA_API_KEY) {
      try {
        const want = req.barcode.replace(/^0+/, '');
        const hit = (await usdaClient(env).searchAll(req.barcode, 10)).find((h) => (h.gtin ?? '').replace(/^0+/, '') === want);
        if (hit) {
          const food = await cacheFood(db, hit);
          return { food, via: 'barcode', match: info('barcode', [usdaCandidate(hit, 9, ['barcode, USDA Branded'])], hit.sourceId), matchConfidence: 0.95, fromPackage: true };
        }
      } catch (e) {
        console.warn('USDA barcode search failed', e);
      }
    }
  }

  // 2b. Nutrition printed on the package: that's this exact product, so use it and remember it.
  if (fromLabel && req.label) {
    const grams = labelServingGrams(req.label)!;
    const food = await createCustomFood(db, userId, {
      name: req.name,
      brand: req.brand ?? null,
      serving_grams: grams,
      serving_label: `1 serving (${req.label.serving_amount} ${req.label.serving_unit})`,
      per_100g: fromLabel,
    });
    return { food, via: 'label', match: info('label', [localCandidate(food, 9, ['from the package label'])], food.id), matchConfidence: 0.95, fromPackage: true };
  }

  // 3 + 4. Rank history, local foods, USDA and FatSecret together so a known food only wins on merit.
  const dreq: DecideRequest = { name: req.name, query, brand: req.brand, estimateKcal100: est, fromHistory: !!req.from_history };
  let options = await gatherLocal(env, userId, { name: req.name, query, history: true });
  // A local food that's already a sure match saves the remote search.
  if (!((decide(dreq, options).ranked[0]?.score ?? -Infinity) >= CONFIDENT_SCORE)) {
    const remote = await gatherRemote(env, query, options);
    lookupError = remote.lookupError;
    options = [...options, ...remote.options];
  }
  const d = decide(dreq, options);
  const candidates = d.ranked.map(toMatchCandidate);
  if (d.chosen) {
    const o = d.chosen.candidate;
    const food = o.food ?? (await cacheFood(db, o.remote!));
    const via: Via = o.origin;
    const top = candidates[0]!;
    const missing = d.chosen.missing.length ? { missing_words: d.chosen.missing } : {};
    return { food, via, match: { ...info(via, candidates, top.fdc_id ?? top.fatsecret_id ?? top.food_id ?? null), ...missing }, matchConfidence: d.confidence };
  }

  // 5. Nothing good enough: keep the candidates so the user can still pick one.
  const food = await estimateFood(db, userId, req);
  return { food, via: 'estimate', match: info('estimate', candidates, null), matchConfidence: d.confidence };
}

/** Private food row holding the model's rough estimate. */
async function estimateFood(db: D1Database, userId: string, req: MatchRequest): Promise<FoodRecord> {
  const id = newId();
  const est = req.estimate_per_100g ?? {};
  const map: [string, number | undefined][] = [
    ['ENERC_KCAL', est.kcal],
    ['PROCNT', est.protein],
    ['FAT', est.fat],
    ['CHOCDF', est.carbs],
  ];
  const stmts = [db.prepare(`INSERT INTO food (id, source, name, name_norm, owner_user_id) VALUES (?, 'estimate', ?, ?, ?)`).bind(id, req.name, normName(req.name), userId)];
  for (const [code, v] of map) {
    if (typeof v !== 'number') continue;
    const def = NUTRIENT_BY_CODE.get(code)!;
    stmts.push(db.prepare('INSERT INTO food_nutrient (food_id, nutrient_code, usda_nutrient_id, value_per_100g, unit) VALUES (?, ?, NULL, ?, ?)').bind(id, code, v, def.unit));
  }
  await db.batch(stmts);
  return {
    id,
    source: 'estimate',
    source_id: null,
    name: req.name,
    brand: null,
    data_type: null,
    category: null,
    default_serving_grams: null,
    owner_user_id: userId,
    portions: [],
    nutrients: map.filter(([, v]) => typeof v === 'number').map(([code, v]) => ({ code, usdaId: null, value: v!, unit: NUTRIENT_BY_CODE.get(code)!.unit })),
  };
}

/** Remember a correction: next time `term` is logged, use `foodId`. */
export async function rememberChoice(db: D1Database, userId: string, term: string, foodId: string) {
  const t = normName(term);
  if (!t) return;
  await db
    .prepare(
      `INSERT INTO food_alias (user_id, term_norm, food_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id, term_norm) DO UPDATE SET food_id = excluded.food_id, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(userId, t, foodId)
    .run();
}
