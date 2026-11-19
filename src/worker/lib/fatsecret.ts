/**
 * FatSecret Platform API: a second food database, mainly for what USDA doesn't carry
 * (restaurant chains such as Starbucks, and newer branded products). US dataset, Premier Free.
 *
 * Requests are signed with OAuth 1.0 (HMAC-SHA1, no access token): FatSecret ties OAuth 2.0
 * keys to registered IP addresses, and Workers have no fixed egress IP.
 * Data shown from FatSecret must carry their attribution ("Powered by fatsecret").
 */
import type { Env } from '../env';
import type { ExternalFood } from './foods';
import type { NutrientValue } from './nutrients';
import { NUTRIENT_BY_CODE } from './nutrients';
import type { Portion } from './units';
import { normaliseUnit } from './units';

const ENDPOINT = 'https://platform.fatsecret.com/rest/server.api';
const SEARCH_METHOD = 'foods.search.v3';
const GET_METHOD = 'food.get.v4';

export class FatSecretError extends Error {
  constructor(
    public method: string,
    public code: number | string,
    message: string,
  ) {
    super(`FatSecret ${method} ${code}: ${message}`);
  }
}

/** RFC 3986 percent-encoding (encodeURIComponent leaves !'()* alone). */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** OAuth 1.0 signature base string and HMAC-SHA1 signature, as FatSecret documents them. */
export async function oauthSignature(method: string, url: string, params: Record<string, string>, consumerSecret: string): Promise<string> {
  const normalized = Object.entries(params)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = `${method.toUpperCase()}&${rfc3986(url)}&${rfc3986(normalized)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${rfc3986(consumerSecret)}&`), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ---- response shapes (numbers arrive as strings; one result may arrive as an object, not an array) ----
interface FsServing {
  serving_id?: string;
  serving_description?: string;
  metric_serving_amount?: string;
  metric_serving_unit?: string;
  number_of_units?: string;
  measurement_description?: string;
  is_default?: string;
  calories?: string;
  protein?: string;
  fat?: string;
  carbohydrate?: string;
  fiber?: string;
  sugar?: string;
  saturated_fat?: string;
  sodium?: string;
  cholesterol?: string;
  potassium?: string;
  calcium?: string;
  iron?: string;
}
export interface FsFood {
  food_id: string;
  food_name: string;
  food_type?: string;
  brand_name?: string;
  food_url?: string;
  servings?: { serving?: FsServing | FsServing[] };
}

const list = <T>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const num = (s: string | undefined) => (s != null && s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);

/** Serving field -> nutrient code. FatSecret's sodium/cholesterol/potassium are mg; calcium and iron are % DV in v3, so left out. */
const FIELDS: [keyof FsServing, string][] = [
  ['calories', 'ENERC_KCAL'],
  ['protein', 'PROCNT'],
  ['fat', 'FAT'],
  ['carbohydrate', 'CHOCDF'],
  ['fiber', 'FIBTG'],
  ['sugar', 'SUGAR'],
  ['saturated_fat', 'FASAT'],
  ['sodium', 'NA'],
  ['cholesterol', 'CHOLE'],
  ['potassium', 'K'],
];

/** Grams (or ml) in a serving, when FatSecret gives a metric amount. */
function servingGrams(s: FsServing): number | null {
  const amt = num(s.metric_serving_amount);
  if (!amt || amt <= 0) return null;
  const u = (s.metric_serving_unit ?? '').toLowerCase();
  if (u === 'g' || u === 'ml') return amt;
  if (u === 'oz') return amt * 28.3495;
  return null;
}

/**
 * Per-100 g nutrients and portions from FatSecret's servings. Nutrients come from the serving FatSecret
 * flags as default when it has a metric weight, else the first that does; foods with no metric serving
 * at all are dropped (nothing can be converted to grams).
 */
export function normaliseFatSecret(f: FsFood): ExternalFood | null {
  const servings = list(f.servings?.serving);
  const metric = servings.filter((s) => servingGrams(s) && num(s.calories) != null);
  const basis = metric.find((s) => s.is_default === '1') ?? metric[0];
  if (!basis) return null;
  const g = servingGrams(basis)!;
  const nutrients: NutrientValue[] = [];
  for (const [field, code] of FIELDS) {
    const v = num(basis[field] as string | undefined);
    const def = NUTRIENT_BY_CODE.get(code);
    if (v != null && v >= 0 && def) nutrients.push({ code, usdaId: def.usdaId, value: (v * 100) / g, unit: def.unit });
  }
  // Household servings ("1 grande", "1 cup") become portions; plain "100 g" / "1 oz" ones add nothing.
  const portions: Portion[] = [];
  for (const s of metric) {
    const desc = (s.measurement_description ?? '').trim().toLowerCase();
    if (!desc || desc === 'g' || desc === 'ml' || desc === 'oz' || desc === 'g ' || /^\d/.test(desc)) continue;
    const units = num(s.number_of_units) ?? 1;
    portions.push({
      label: s.serving_description?.trim() || `${units} ${desc}`,
      unit: desc === 'serving' ? 'serving' : normaliseUnit(desc.split(/[ ,(]/)[0]!),
      amount: units > 0 ? units : 1,
      grams: servingGrams(s)!,
    });
  }
  const brand = f.food_type === 'Brand' && f.brand_name ? f.brand_name : null;
  const firstPortion = portions[0];
  return {
    source: 'fatsecret',
    sourceId: String(f.food_id),
    name: f.food_name,
    brand,
    dataType: brand ? 'FatSecret Brand' : 'FatSecret',
    category: null,
    defaultServingGrams: firstPortion ? firstPortion.grams / firstPortion.amount : null,
    portions,
    nutrients,
  };
}

export class FatSecretClient {
  constructor(
    private key: string,
    private secret: string,
    private fetcher: typeof fetch = (i, n) => fetch(i, n),
  ) {}

  private async call<T>(method: string, params: Record<string, string>): Promise<T> {
    const all: Record<string, string> = {
      ...params,
      method,
      format: 'json',
      oauth_consumer_key: this.key,
      oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_version: '1.0',
    };
    all.oauth_signature = await oauthSignature('GET', ENDPOINT, all, this.secret);
    const qs = Object.entries(all)
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .join('&');
    const res = await this.fetcher(`${ENDPOINT}?${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new FatSecretError(method, res.status, res.statusText);
    const data = (await res.json()) as T & { error?: { code: number; message: string } };
    // FatSecret reports errors in a 200 body.
    if (data && typeof data === 'object' && 'error' in data && data.error) throw new FatSecretError(method, data.error.code, data.error.message);
    return data;
  }

  async search(query: string, max = 20): Promise<ExternalFood[]> {
    const r = await this.call<{ foods_search?: { results?: { food?: FsFood | FsFood[] } } }>(SEARCH_METHOD, {
      search_expression: query,
      max_results: String(Math.min(50, max)),
      flag_default_serving: 'true',
    });
    return list(r.foods_search?.results?.food)
      .map(normaliseFatSecret)
      .filter((f): f is ExternalFood => !!f);
  }

  async food(id: string): Promise<ExternalFood | null> {
    const r = await this.call<{ food?: FsFood }>(GET_METHOD, { food_id: id, flag_default_serving: 'true' });
    return r.food ? normaliseFatSecret(r.food) : null;
  }
}

/** A client when both FatSecret secrets are set, else null (FatSecret is optional). */
export function fatsecretClient(env: Env, fetcher?: typeof fetch): FatSecretClient | null {
  return env.FATSECRET_CONSUMER_KEY && env.FATSECRET_CONSUMER_SECRET ? new FatSecretClient(env.FATSECRET_CONSUMER_KEY, env.FATSECRET_CONSUMER_SECRET, fetcher) : null;
}

export const FATSECRET_ATTRIBUTION = { text: 'Powered by fatsecret', url: 'https://www.fatsecret.com' };
