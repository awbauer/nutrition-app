/** USDA FoodData Central client. Nutrient values for all data types are per 100 g. */
import { FETCH_TIMEOUT_MS } from './ids';
import { fromUsda, type NutrientValue } from './nutrients';
import { normaliseUnit, parsePortionText, type Portion } from './units';

export { parsePortionText };

const BASE = 'https://api.nal.usda.gov/fdc/v1';

export interface NormalisedFood {
  source: 'usda';
  sourceId: string;
  name: string;
  brand: string | null;
  dataType: string;
  /** USDA's category: SR/Foundation food group, WWEIA category (FNDDS) or branded category. */
  category: string | null;
  /** Branded foods: UPC/GTIN, used to match a scanned or photographed barcode. */
  gtin?: string | null;
  defaultServingGrams: number | null;
  portions: Portion[];
  nutrients: NutrientValue[];
  /** The record as FoodData Central sent it, less lab-sample detail (see snapshotOf); kept in food_source_snapshot. */
  raw: { kind: 'search' | 'detail'; data: unknown };
}

/** Search tiers in spec order: whole foods first, then mixed dishes, then branded. */
export const SEARCH_TIERS = [['Foundation', 'SR Legacy'], ['Survey (FNDDS)'], ['Branded']] as const;

type Fetch = typeof fetch;

export class UsdaError extends Error {
  constructor(
    public path: string,
    public status: number,
  ) {
    super(`USDA ${path} ${status}`);
  }
}

// 400 is not retried: FoodData Central's 400s are deterministic (see search()).
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
export const RETRY_DELAYS_MS = [400, 1200];
/** Short pause between requests, to stay well inside USDA's rate limit. */
export const USDA_SPACING_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One USDA request at a time per isolate; matching a meal would otherwise send a burst. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    // Keep the chain going whatever happens, with a short gap after each request.
    this.tail = next.then(
      () => sleep(USDA_SPACING_MS),
      () => sleep(USDA_SPACING_MS),
    );
    return next;
  }
}
export const usdaQueue = new SerialQueue();

export class UsdaClient {
  constructor(
    private apiKey: string,
    private fetcher: Fetch = (input, init) => fetch(input, init),
    private base: string = BASE,
  ) {}

  /** GET when there's no body, otherwise POST it as JSON. */
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const url = new URL(this.base + path);
    url.searchParams.set('api_key', this.apiKey);
    const init: RequestInit = body
      ? { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { headers: { Accept: 'application/json' } };
    return usdaQueue.run(async () => {
      let status = 0;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
        // Each attempt has its own deadline: requests are serialised, so one hung request held up every other.
        const res = await this.fetcher(url.toString(), { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok) return res.json<T>();
        status = res.status;
        if (!RETRYABLE.has(status)) break;
      }
      throw new UsdaError(path, status);
    });
  }

  async search(query: string, dataTypes: readonly string[], pageSize = 8): Promise<NormalisedFood[]> {
    // POST, not GET: FoodData Central's GET search answers some queries that include
    // Survey (FNDDS) with a bare nginx 400 every time ("pasta", "mimosa"); POST works.
    const data = await this.request<{ foods?: UsdaSearchFood[] }>('/foods/search', { query, dataType: [...dataTypes], pageSize });
    return (data.foods ?? []).map(normaliseSearchFood);
  }

  /** One request across all tiers, ordered by tier (whole foods, then mixed dishes, then branded). */
  async searchAll(query: string, pageSize = 15): Promise<NormalisedFood[]> {
    const hits = await this.search(query, SEARCH_TIERS.flat(), pageSize);
    const rank = (dt: string) => SEARCH_TIERS.findIndex((t) => (t as readonly string[]).includes(dt));
    return hits
      .map((h, i) => ({ h, i }))
      .sort((a, b) => rank(a.h.dataType) - rank(b.h.dataType) || a.i - b.i)
      .map((x) => x.h);
  }

  /** Search tiers in order and return the first non-empty tier (or all tiers merged when `all`). */
  async tieredSearch(query: string, opts: { all?: boolean; pageSize?: number } = {}): Promise<NormalisedFood[]> {
    const out: NormalisedFood[] = [];
    for (const tier of SEARCH_TIERS) {
      const hits = await this.search(query, tier, opts.pageSize);
      out.push(...hits);
      if (!opts.all && hits.length) break;
    }
    return out;
  }

  async food(fdcId: string | number): Promise<NormalisedFood> {
    return normaliseDetailFood(await this.request<UsdaDetailFood>(`/food/${fdcId}`));
  }
}

// ---- response shapes (subset) ----
interface UsdaSearchFood {
  fdcId: number;
  description: string;
  dataType: string;
  brandOwner?: string;
  brandName?: string;
  gtinUpc?: string;
  foodCategory?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  foodNutrients?: { nutrientId: number; unitName: string; value: number }[];
  foodMeasures?: { disseminationText?: string; gramWeight?: number; measureUnitAbbreviation?: string; rank?: number }[];
}

interface UsdaDetailFood {
  fdcId: number;
  description: string;
  dataType: string;
  brandOwner?: string;
  brandName?: string;
  foodCategory?: { description?: string };
  brandedFoodCategory?: string;
  wweiaFoodCategory?: { wweiaFoodCategoryDescription?: string };
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  foodNutrients?: { nutrient?: { id: number; unitName: string }; amount?: number }[];
  foodPortions?: {
    gramWeight: number;
    amount?: number;
    modifier?: string;
    portionDescription?: string;
    measureUnit?: { name?: string; abbreviation?: string };
  }[];
}

function brandedServing(f: { servingSize?: number; servingSizeUnit?: string; householdServingFullText?: string }) {
  const unit = f.servingSizeUnit?.toLowerCase();
  if (!f.servingSize || !unit) return { grams: null, portions: [] as Portion[] };
  const grams = unit === 'g' || unit === 'grm' || unit === 'ml' || unit === 'mlt' ? f.servingSize : null;
  const portions: Portion[] = grams ? [{ label: f.householdServingFullText || 'serving', unit: 'serving', amount: 1, grams }] : [];
  return { grams, portions };
}

/**
 * The record to keep: everything FoodData Central sent that describes the food, unused fields
 * included, without what no food log needs:
 * - per-nutrient lab sample details on Foundation foods (store, purchase date and lab method for
 *   every sample; ~80% of their size) and branded foods' log of earlier versions;
 * - per-row bookkeeping: row ids, the "FoodNutrient" type tag, display ranks and the ids inside
 *   derivation codes (their codes and descriptions stay), and heading rows with no value.
 * Kept per nutrient: id, number, name, unit, amount, min/max/median, data points and derivation.
 */
export function snapshotOf<T extends object>(f: T): T {
  const { foodUpdateLog: _log, ...rest } = f as T & { foodUpdateLog?: unknown };
  const nutrients = (rest as { foodNutrients?: unknown }).foodNutrients;
  if (!Array.isArray(nutrients)) return rest as T;
  const strip = (o: unknown, ...keys: string[]) => {
    if (!o || typeof o !== 'object') return o;
    const copy = { ...(o as Record<string, unknown>) };
    for (const k of keys) delete copy[k];
    return copy;
  };
  return {
    ...rest,
    foodNutrients: nutrients
      .filter((n) => !n || typeof n !== 'object' || 'amount' in n || 'value' in n)
      .map((n) => {
        if (!n || typeof n !== 'object') return n;
        // Detail rows nest the nutrient; search-result rows are flat (nutrientId, rank, indentLevel).
        const keep = strip(n, 'nutrientAnalysisDetails', 'type', 'id', 'foodNutrientId', 'rank', 'indentLevel') as Record<string, unknown>;
        if (keep.nutrient) keep.nutrient = strip(keep.nutrient, 'rank');
        const der = keep.foodNutrientDerivation as Record<string, unknown> | undefined;
        if (der && typeof der === 'object')
          keep.foodNutrientDerivation = { ...(strip(der, 'id') as object), ...(der.foodNutrientSource ? { foodNutrientSource: strip(der.foodNutrientSource, 'id') } : {}) };
        return keep;
      }),
  } as T;
}

export function normaliseSearchFood(f: UsdaSearchFood): NormalisedFood {
  const nutrients = fromUsda((f.foodNutrients ?? []).map((n) => ({ id: n.nutrientId, value: n.value, unit: n.unitName })));
  const branded = brandedServing(f);
  const measures: Portion[] = (f.foodMeasures ?? [])
    .filter((m) => m.gramWeight && m.disseminationText && m.disseminationText !== 'Quantity not specified')
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((m) => {
      const p = parsePortionText(m.disseminationText!);
      return { label: m.disseminationText!, unit: p.unit, amount: p.amount, grams: m.gramWeight! };
    });
  return {
    source: 'usda',
    sourceId: String(f.fdcId),
    name: f.description,
    brand: f.brandName || f.brandOwner || null,
    dataType: f.dataType,
    category: f.foodCategory || null,
    gtin: f.gtinUpc ?? null,
    defaultServingGrams: branded.grams ?? measures[0]?.grams ?? null,
    portions: [...branded.portions, ...measures],
    nutrients,
    raw: { kind: 'search', data: snapshotOf(f) },
  };
}

export function normaliseDetailFood(f: UsdaDetailFood): NormalisedFood {
  const nutrients = fromUsda(
    (f.foodNutrients ?? []).filter((n) => n.nutrient && typeof n.amount === 'number').map((n) => ({ id: n.nutrient!.id, value: n.amount!, unit: n.nutrient!.unitName })),
  );
  const branded = brandedServing(f);
  const portions: Portion[] = (f.foodPortions ?? [])
    .filter((p) => p.gramWeight > 0)
    .map((p) => {
      const mu = p.measureUnit?.name && p.measureUnit.name !== 'undetermined' ? p.measureUnit.name : '';
      if (p.portionDescription && p.portionDescription !== 'Quantity not specified') {
        const parsed = parsePortionText(p.portionDescription);
        return { label: p.portionDescription, unit: parsed.unit, amount: parsed.amount, grams: p.gramWeight };
      }
      const label = [mu, p.modifier].filter(Boolean).join(' ').trim() || 'serving';
      const unitWord = mu || (p.modifier ?? '').split(/[ ,(]/)[0] || 'serving';
      return { label, unit: normaliseUnit(unitWord), amount: p.amount || 1, grams: p.gramWeight };
    });
  return {
    source: 'usda',
    sourceId: String(f.fdcId),
    name: f.description,
    brand: f.brandName || f.brandOwner || null,
    dataType: f.dataType,
    category: f.foodCategory?.description || f.brandedFoodCategory || f.wweiaFoodCategory?.wweiaFoodCategoryDescription || null,
    defaultServingGrams: branded.grams ?? (portions[0] ? portions[0].grams / portions[0].amount : null),
    portions: [...branded.portions, ...portions],
    nutrients,
    raw: { kind: 'detail', data: snapshotOf(f) },
  };
}
