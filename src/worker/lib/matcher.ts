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
import { historyBonus, searchHistory } from './history';
import { ACCEPT_SCORE, CONFIDENT_SCORE, rankCandidates, scoreCandidate } from './scoring';
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
  notes: string[];
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

export const ESTIMATE_CONFIDENCE_CAP = 0.4;
const MAX_CANDIDATES = 8;

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

/** Search FatSecret (when configured) and rank the results; [] when it isn't. */
export async function rankedFatSecret(env: Env, query: string, estimateKcal: number | null, max = 20) {
  const client = fatsecretClient(env);
  if (!client) return [];
  const hits = await client.search(query, max);
  return rankCandidates(
    query,
    hits.map((h, i) => ({ ...h, kcal100: per100(h.nutrients, 'ENERC_KCAL'), sourceRank: i })),
    estimateKcal,
  );
}

/** Search USDA (all tiers, one request) and rank the results for a query. */
export async function rankedUsda(env: Env, query: string, estimateKcal: number | null, pageSize = 25) {
  const hits = await usdaClient(env).searchAll(query, pageSize);
  return rankCandidates(
    query,
    hits.map((h) => ({ ...h, kcal100: per100(h.nutrients, 'ENERC_KCAL') })),
    estimateKcal,
  );
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

  // 3 + 4. Rank history, local cache and USDA together so a known food only wins on merit.
  // History: foods the user has eaten, found by meaning, then scored on their words (under the
  // user's own names too) plus a bonus for familiarity. "Turkey meatballs" is near "chicken
  // meatballs" as a vector but misses a word, so it doesn't win.
  const history = await searchHistory(env, userId, req.name);
  const rankedHistory = history
    .map((h) => {
      const c = { ...h.food, dataType: h.food.data_type, kcal100: per100(h.food.nutrients, 'ENERC_KCAL') };
      const best = [h.food.name, ...h.names].map((name) => scoreCandidate(req.name, { ...c, name }, est)).sort((a, b) => b.score - a.score)[0]!;
      const bonus = historyBonus(h, req.name, !!req.from_history);
      return { candidate: h.food, score: Math.round((best.score + bonus) * 100) / 100, reasons: [...best.reasons, `you've had it ${h.times}×`] };
    })
    .sort((a, b) => b.score - a.score);
  const historyIds = new Set(history.map((h) => h.food.id));
  const local = (await searchLocal(db, userId, query, 8)).filter((f) => f.source !== 'estimate' && !historyIds.has(f.id));
  const rankedLocal = [
    ...rankedHistory,
    ...rankCandidates(
      query,
      local.map((f) => ({ ...f, dataType: f.data_type, kcal100: per100(f.nutrients, 'ENERC_KCAL') })),
      est,
    ),
  ].sort((a, b) => b.score - a.score);
  let rankedRemote: Awaited<ReturnType<typeof rankedUsda>> = [];
  let rankedFs: Awaited<ReturnType<typeof rankedFatSecret>> = [];
  const bestLocal = rankedLocal[0];
  if (!(bestLocal && bestLocal.score >= CONFIDENT_SCORE)) {
    // Both databases at once; either failing leaves the other.
    const [usda, fs] = await Promise.allSettled([env.USDA_API_KEY ? rankedUsda(env, query, est) : Promise.resolve([]), rankedFatSecret(env, query, est)]);
    if (usda.status === 'fulfilled') rankedRemote = usda.value;
    else {
      lookupError = (usda.reason as Error).message;
      console.warn('USDA search failed', query, lookupError);
    }
    if (fs.status === 'fulfilled') rankedFs = fs.value;
    else console.warn('FatSecret search failed', query, (fs.reason as Error).message);
  }
  const seen = new Set(rankedLocal.map((r) => `${r.candidate.source}:${r.candidate.source_id}`));
  const candidates: (MatchCandidate & { _local?: FoodRecord; _remote?: NormalisedFood | ExternalFood })[] = [
    ...rankedLocal.map((r) => ({ ...localCandidate(r.candidate, r.score, r.reasons), _local: r.candidate })),
    ...rankedRemote.filter((r) => !seen.has(`usda:${r.candidate.sourceId}`)).map((r) => ({ ...usdaCandidate(r.candidate, r.score, r.reasons), _remote: r.candidate })),
    ...rankedFs.filter((r) => !seen.has(`fatsecret:${r.candidate.sourceId}`)).map((r) => ({ ...fatsecretCandidate(r.candidate, r.score, r.reasons), _remote: r.candidate })),
  ].sort((a, b) => b.score - a.score);

  const strip = (cs: typeof candidates): MatchCandidate[] => cs.map(({ _local, _remote, ...c }) => c);
  const best = candidates[0];
  if (best && best.score >= ACCEPT_SCORE) {
    const food = best._local ?? (await cacheFood(db, best._remote!));
    const via: Via = best._local ? (historyIds.has(food.id) ? 'history' : food.owner_user_id ? 'custom' : 'cache') : best._remote!.source === 'fatsecret' ? 'fatsecret' : 'usda';
    // Map score to confidence: ACCEPT_SCORE → 0.5, CONFIDENT_SCORE and up → 0.9.
    const t = Math.min(1, Math.max(0, (best.score - ACCEPT_SCORE) / (CONFIDENT_SCORE - ACCEPT_SCORE)));
    return { food, via, match: info(via, strip(candidates), best.fdc_id ?? best.fatsecret_id ?? best.food_id ?? null), matchConfidence: 0.5 + 0.4 * t };
  }

  // 5. Nothing good enough: keep the candidates so the user can still pick one.
  const food = await estimateFood(db, userId, req);
  return { food, via: 'estimate', match: info('estimate', strip(candidates), null), matchConfidence: ESTIMATE_CONFIDENCE_CAP };
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
