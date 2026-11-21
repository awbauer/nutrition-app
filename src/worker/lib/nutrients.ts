/**
 * Nutrients we track, keyed by INFOODS tagname, with their USDA FoodData Central nutrient ids.
 * `fallbackUsdaIds` cover Foundation foods that report Atwater energy instead of 1008.
 */
export interface NutrientDef {
  code: string;
  usdaId: number;
  fallbackUsdaIds?: number[];
  name: string;
  unit: string; // UCUM
}

export const NUTRIENTS: NutrientDef[] = [
  { code: 'ENERC_KCAL', usdaId: 1008, fallbackUsdaIds: [2047, 2048], name: 'Energy', unit: 'kcal' },
  { code: 'PROCNT', usdaId: 1003, name: 'Protein', unit: 'g' },
  { code: 'FAT', usdaId: 1004, name: 'Total fat', unit: 'g' },
  { code: 'CHOCDF', usdaId: 1005, fallbackUsdaIds: [1050], name: 'Carbohydrate', unit: 'g' },
  { code: 'FIBTG', usdaId: 1079, name: 'Fiber', unit: 'g' },
  { code: 'SUGAR', usdaId: 2000, fallbackUsdaIds: [1063], name: 'Sugars', unit: 'g' },
  { code: 'FASAT', usdaId: 1258, name: 'Saturated fat', unit: 'g' },
  { code: 'CHOLE', usdaId: 1253, name: 'Cholesterol', unit: 'mg' },
  { code: 'NA', usdaId: 1093, name: 'Sodium', unit: 'mg' },
  { code: 'K', usdaId: 1092, name: 'Potassium', unit: 'mg' },
  { code: 'CA', usdaId: 1087, name: 'Calcium', unit: 'mg' },
  { code: 'FE', usdaId: 1089, name: 'Iron', unit: 'mg' },
];

export const NUTRIENT_BY_CODE = new Map(NUTRIENTS.map((n) => [n.code, n]));

/** Headline codes used for totals, targets and CSV export. */
export const CORE = ['ENERC_KCAL', 'PROCNT', 'FAT', 'CHOCDF', 'FIBTG', 'SUGAR', 'NA'] as const;

export interface NutrientValue {
  code: string;
  usdaId: number | null;
  value: number;
  unit: string;
}

/** Map a USDA nutrient list ({id, value, unit}) onto our codes, applying fallbacks. */
export function fromUsda(list: { id: number; value: number; unit: string }[]): NutrientValue[] {
  const byId = new Map<number, { value: number; unit: string }>();
  for (const n of list) if (Number.isFinite(n.value) && !byId.has(n.id)) byId.set(n.id, n);
  const out: NutrientValue[] = [];
  for (const def of NUTRIENTS) {
    for (const id of [def.usdaId, ...(def.fallbackUsdaIds ?? [])]) {
      const hit = byId.get(id);
      if (!hit) continue;
      // Energy may be reported in kJ; normalise to kcal.
      let value = hit.value;
      if (def.code === 'ENERC_KCAL' && hit.unit.toLowerCase() === 'kj') value = value / 4.184;
      out.push({ code: def.code, usdaId: id, value, unit: def.unit });
      break;
    }
  }
  return out;
}

/**
 * Why per-100 g values can't be right, or null when they're plausible. Crowd-sourced product data
 * (Open Food Facts) sometimes has per-serving or per-package numbers in the per-100 g fields, e.g.
 * 194 g of carbs in 100 g of licorice; logging those multiplies calories several times over.
 */
export function implausiblePer100g(nutrients: NutrientValue[]): string | null {
  const v = (code: string) => nutrients.find((n) => n.code === code)?.value;
  for (const code of ['PROCNT', 'FAT', 'CHOCDF', 'SUGAR', 'FIBTG']) {
    const x = v(code);
    if (x != null && x > 100) return `${code} ${Math.round(x)} g per 100 g`;
  }
  const [p, f, c, kcal] = [v('PROCNT'), v('FAT'), v('CHOCDF'), v('ENERC_KCAL')];
  if ((p ?? 0) + (f ?? 0) + (c ?? 0) > 105) return 'protein, fat and carbs add up to more than 100 g per 100 g';
  // Pure fat is about 900 kcal per 100 g; nothing edible is denser.
  if (kcal != null && kcal > 902) return `${Math.round(kcal)} kcal per 100 g`;
  return null;
}

export const round = (v: number, dp = 1): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

export function sumNutrients(rows: { nutrient_code: string; value: number }[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.nutrient_code] = (totals[r.nutrient_code] ?? 0) + r.value;
  for (const k of Object.keys(totals)) totals[k] = round(totals[k]!);
  return totals;
}
