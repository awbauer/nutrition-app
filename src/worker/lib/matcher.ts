/**
 * Food matching cascade (spec §4):
 * 1. the user's own corrections (food_alias) and exact custom foods / recipes
 * 2. Open Food Facts by barcode
 * 3. local food cache, accepted only if it scores well
 * 4. USDA FoodData Central: one search across Foundation, SR Legacy, FNDDS and Branded,
 *    re-ranked by `scoring.ts` (word coverage, main word, product type, kcal plausibility)
 * 5. no acceptable match: model estimate, flagged `estimated`, confidence capped at 0.4
 *
 * Every result carries the candidates that were considered so the UI can show them
 * and the user can switch to another.
 */
import type { Env } from '../env';
import { cacheFood, exactCustom, findCachedBySource, getFood, normName, searchLocal, usdaClient, type FoodRecord } from './foods';
import { newId } from './ids';
import { NUTRIENT_BY_CODE } from './nutrients';
import { offByBarcode } from './off';
import { ACCEPT_SCORE, CONFIDENT_SCORE, rankCandidates } from './scoring';
import type { NormalisedFood } from './usda';

export interface MatchRequest {
  name: string;
  search_terms?: string[];
  barcode?: string | null;
  estimate_per_100g?: { kcal?: number; protein?: number; fat?: number; carbs?: number };
}

export type Via = 'alias' | 'custom' | 'cache' | 'usda' | 'off' | 'estimate';

/** One option the matcher considered, as stored on the item and shown in the UI. */
export interface MatchCandidate {
  fdc_id?: string; // USDA candidates
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
}

export interface MatchResult {
  food: FoodRecord;
  via: Via;
  match: MatchInfo;
  /** How sure we are the food is right (independent of the amount). */
  matchConfidence: number;
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

export const localCandidate = (f: FoodRecord, score = 0, notes: string[] = []): MatchCandidate => ({
  food_id: f.id,
  ...(f.source === 'usda' && f.source_id ? { fdc_id: f.source_id } : {}),
  source: f.source,
  name: f.name,
  brand: f.brand,
  data_type: f.data_type,
  kcal_100g: per100(f.nutrients, 'ENERC_KCAL'),
  protein_100g: per100(f.nutrients, 'PROCNT'),
  score,
  notes,
});

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
  const query = req.search_terms?.[0] || req.name;
  const est = req.estimate_per_100g?.kcal ?? null;
  const info = (via: Via, candidates: MatchCandidate[], chosen: string | null): MatchInfo => ({
    query,
    via,
    estimate_kcal_100g: est,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    chosen,
  });

  // 1. The user's corrections, then exact custom foods / recipes.
  for (const term of new Set([req.name, query].map(normName))) {
    const alias = await db
      .prepare('SELECT food_id FROM food_alias WHERE user_id = ? AND term_norm = ?')
      .bind(userId, term)
      .first<{ food_id: string }>();
    const food = alias && (await getFood(db, userId, alias.food_id));
    if (food) return { food, via: 'alias', match: info('alias', [localCandidate(food, 9, ['your earlier choice'])], food.id), matchConfidence: 1 };
  }
  const custom = await exactCustom(db, userId, req.name);
  if (custom) return { food: custom, via: 'custom', match: info('custom', [localCandidate(custom, 9, ['your food'])], custom.id), matchConfidence: 1 };

  // 2. Barcode.
  if (req.barcode) {
    const cached = await findCachedBySource(db, 'off', req.barcode);
    if (cached) return { food: cached, via: 'cache', match: info('cache', [localCandidate(cached, 9, ['barcode'])], cached.id), matchConfidence: 0.95 };
    try {
      const off = await offByBarcode(req.barcode);
      if (off) {
        const food = await cacheFood(db, off);
        return { food, via: 'off', match: info('off', [localCandidate(food, 9, ['barcode'])], food.id), matchConfidence: 0.95 };
      }
    } catch (e) {
      console.warn('OFF lookup failed', e);
    }
  }

  // 3 + 4. Rank local cache and USDA together so a cached food only wins on merit.
  const local = (await searchLocal(db, userId, query, 8)).filter((f) => f.source !== 'estimate');
  const rankedLocal = rankCandidates(query, local.map((f) => ({ ...f, dataType: f.data_type, kcal100: per100(f.nutrients, 'ENERC_KCAL') })), est);
  let rankedRemote: Awaited<ReturnType<typeof rankedUsda>> = [];
  const bestLocal = rankedLocal[0];
  if (env.USDA_API_KEY && !(bestLocal && bestLocal.score >= CONFIDENT_SCORE)) {
    try {
      rankedRemote = await rankedUsda(env, query, est);
    } catch (e) {
      console.warn('USDA search failed', e);
    }
  }
  const seen = new Set(rankedLocal.map((r) => r.candidate.source_id).filter(Boolean));
  const candidates: (MatchCandidate & { _local?: FoodRecord; _remote?: NormalisedFood })[] = [
    ...rankedLocal.map((r) => ({ ...localCandidate(r.candidate, r.score, r.reasons), _local: r.candidate })),
    ...rankedRemote.filter((r) => !seen.has(r.candidate.sourceId)).map((r) => ({ ...usdaCandidate(r.candidate, r.score, r.reasons), _remote: r.candidate })),
  ].sort((a, b) => b.score - a.score);

  const strip = (cs: typeof candidates): MatchCandidate[] => cs.map(({ _local, _remote, ...c }) => c);
  const best = candidates[0];
  if (best && best.score >= ACCEPT_SCORE) {
    const food = best._local ?? (await cacheFood(db, best._remote!));
    const via: Via = best._local ? (food.owner_user_id ? 'custom' : 'cache') : 'usda';
    // Map score to confidence: ACCEPT_SCORE → 0.5, CONFIDENT_SCORE and up → 0.9.
    const t = Math.min(1, Math.max(0, (best.score - ACCEPT_SCORE) / (CONFIDENT_SCORE - ACCEPT_SCORE)));
    return { food, via, match: info(via, strip(candidates), best.fdc_id ?? best.food_id ?? null), matchConfidence: 0.5 + 0.4 * t };
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
  const stmts = [
    db
      .prepare(`INSERT INTO food (id, source, name, name_norm, owner_user_id) VALUES (?, 'estimate', ?, ?, ?)`)
      .bind(id, req.name, normName(req.name), userId),
  ];
  for (const [code, v] of map) {
    if (typeof v !== 'number') continue;
    const def = NUTRIENT_BY_CODE.get(code)!;
    stmts.push(
      db
        .prepare('INSERT INTO food_nutrient (food_id, nutrient_code, usda_nutrient_id, value_per_100g, unit) VALUES (?, ?, NULL, ?, ?)')
        .bind(id, code, v, def.unit),
    );
  }
  await db.batch(stmts);
  return {
    id,
    source: 'estimate',
    source_id: null,
    name: req.name,
    brand: null,
    data_type: null,
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
