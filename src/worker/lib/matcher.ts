/**
 * Food matching cascade (spec §4):
 * 1. exact match in the user's custom foods and recipes
 * 2. fuzzy match in the local food cache
 * 3. USDA FoodData Central (Foundation/SR Legacy → FNDDS → Branded)
 * 4. Open Food Facts by barcode
 * 5. no match: model estimate, flagged `estimated`, confidence capped at 0.4
 */
import type { Env } from '../env';
import { cacheFood, exactCustom, findCachedBySource, normName, searchLocal, usdaClient, type FoodRecord } from './foods';
import { newId } from './ids';
import { NUTRIENT_BY_CODE } from './nutrients';
import { offByBarcode } from './off';

export interface MatchRequest {
  name: string;
  search_terms?: string[];
  barcode?: string | null;
  estimate_per_100g?: { kcal?: number; protein?: number; fat?: number; carbs?: number };
}

export interface MatchResult {
  food: FoodRecord;
  via: 'custom' | 'cache' | 'usda' | 'off' | 'estimate';
}

export const ESTIMATE_CONFIDENCE_CAP = 0.4;

/** Every token of the shorter phrase appears in the longer: avoids "apple pie" matching "apple". */
function closeEnough(query: string, candidate: string): boolean {
  const q = normName(query).split(' ').filter((t) => t.length > 2);
  const c = new Set(normName(candidate).split(' '));
  const hits = q.filter((t) => c.has(t) || c.has(t.replace(/s$/, '')) || c.has(`${t}s`)).length;
  return q.length > 0 && hits / q.length >= 0.75;
}

export async function matchFood(env: Env, userId: string, req: MatchRequest): Promise<MatchResult> {
  const db = env.DB;
  const terms = [...(req.search_terms ?? []), req.name].filter(Boolean);

  const custom = await exactCustom(db, userId, req.name);
  if (custom) return { food: custom, via: 'custom' };

  if (req.barcode) {
    const cached = await findCachedBySource(db, 'off', req.barcode);
    if (cached) return { food: cached, via: 'cache' };
  }

  for (const t of terms) {
    const local = await searchLocal(db, userId, t, 5);
    const hit = local.find((f) => f.source !== 'estimate' && closeEnough(t, f.name));
    if (hit) return { food: hit, via: hit.owner_user_id ? 'custom' : 'cache' };
  }

  if (req.barcode) {
    try {
      const off = await offByBarcode(req.barcode);
      if (off) return { food: await cacheFood(db, off), via: 'off' };
    } catch (e) {
      console.warn('OFF lookup failed', e);
    }
  }

  if (env.USDA_API_KEY) {
    const client = usdaClient(env);
    for (const t of terms.slice(0, 2)) {
      try {
        const hits = await client.tieredSearch(t, { pageSize: 5 });
        const best = hits.find((h) => closeEnough(t, h.name)) ?? hits[0];
        if (best) return { food: await cacheFood(db, best), via: 'usda' };
      } catch (e) {
        console.warn('USDA search failed', e);
        break;
      }
    }
  }

  return { food: await estimateFood(db, userId, req), via: 'estimate' };
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
