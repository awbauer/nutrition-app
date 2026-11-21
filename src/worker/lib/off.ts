/** Open Food Facts lookup by GTIN barcode. Nutriments are per 100 g. */
import type { ExternalFood } from './foods';
import { FETCH_TIMEOUT_MS } from './ids';
import type { NutrientValue } from './nutrients';

const FIELDS = 'code,product_name,brands,serving_quantity,serving_size,nutriments,categories_hierarchy';

export async function offByBarcode(gtin: string, fetcher: typeof fetch = (i, n) => fetch(i, n)): Promise<ExternalFood | null> {
  if (!/^\d{8,14}$/.test(gtin)) return null;
  const res = await fetcher(`https://world.openfoodfacts.org/api/v2/product/${gtin}.json?fields=${FIELDS}`, {
    headers: { 'User-Agent': 'MealTrackerPWA/1.0 (personal nutrition log)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json<{ status?: number; product?: Record<string, any> }>();
  if (data.status !== 1 || !data.product) return null;
  return normaliseOff(gtin, data.product);
}

export function normaliseOff(gtin: string, p: Record<string, any>): ExternalFood {
  const n = (p.nutriments ?? {}) as Record<string, number>;
  const nutrients: NutrientValue[] = [];
  const add = (code: string, usdaId: number, value: unknown, unit: string, scale = 1) => {
    if (typeof value === 'number' && Number.isFinite(value)) nutrients.push({ code, usdaId, value: value * scale, unit });
  };
  add('ENERC_KCAL', 1008, n['energy-kcal_100g'] ?? (typeof n['energy_100g'] === 'number' ? n['energy_100g'] / 4.184 : undefined), 'kcal');
  add('PROCNT', 1003, n.proteins_100g, 'g');
  add('FAT', 1004, n.fat_100g, 'g');
  add('CHOCDF', 1005, n.carbohydrates_100g, 'g');
  add('FIBTG', 1079, n.fiber_100g, 'g');
  add('SUGAR', 2000, n.sugars_100g, 'g');
  add('FASAT', 1258, n['saturated-fat_100g'], 'g');
  add('NA', 1093, n.sodium_100g, 'mg', 1000);
  const serving = typeof p.serving_quantity === 'number' ? p.serving_quantity : Number(p.serving_quantity) || null;
  return {
    source: 'off',
    sourceId: gtin,
    name: p.product_name || `Product ${gtin}`,
    brand: typeof p.brands === 'string' ? p.brands.split(',')[0]!.trim() || null : null,
    dataType: 'Open Food Facts',
    // English category tags, broadest first ("beverages > carbonated drinks > sodas").
    category:
      (Array.isArray(p.categories_hierarchy) ? (p.categories_hierarchy as unknown[]) : [])
        .filter((t): t is string => typeof t === 'string' && t.startsWith('en:'))
        .map((t) => t.slice(3).replace(/-/g, ' '))
        .join(' > ') || null,
    defaultServingGrams: serving,
    portions: serving ? [{ label: p.serving_size || 'serving', unit: 'serving', amount: 1, grams: serving }] : [],
    nutrients,
  };
}
