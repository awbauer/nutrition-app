import { describe, expect, it } from 'vitest';
import { api } from './helpers';

const form = (text: string) => {
  const f = new FormData();
  f.append('text', text);
  return f;
};

describe('weights for volumes of solid food', () => {
  it("uses the model's weight when a volume weighed as water is far off, but not for drinks", async () => {
    await api('/foods', { method: 'POST', json: { name: 'Lettuce iceberg test', serving_grams: 100, per_serving: { ENERC_KCAL: 14 } } });
    await api('/foods', { method: 'POST', json: { name: 'Milk whole test', serving_grams: 100, per_serving: { ENERC_KCAL: 61 } } });
    const output = {
      items: [
        { name: 'lettuce iceberg test', amount: 2, unit: 'cup', grams: 72, confidence: 0.8, search_terms: ['lettuce iceberg test'], barcode: null },
        { name: 'milk whole test', amount: 1, unit: 'cup', grams: 244, confidence: 0.8, search_terms: ['milk whole test'], barcode: null },
      ],
      questions: [],
    };
    const AI = { run: async () => ({ response: JSON.stringify(output) }) } as unknown as Ai;
    const r = await api('/intake', { method: 'POST', body: form('salad and milk') }, { AI, USDA_API_KEY: undefined } as any);
    const [lettuce, milk] = r.data.items;
    expect(lettuce.grams).toBe(72);
    expect(milk.grams).toBe(240);
  });
});
