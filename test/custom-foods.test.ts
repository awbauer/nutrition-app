import { describe, expect, it } from 'vitest';
import { validateDraft } from '../src/worker/lib/label';
import { api } from './helpers';

const ai = (out: unknown) => ({ run: async () => ({ response: out }) }) as unknown as Ai;
const photoForm = (name?: string) => {
  const f = new FormData();
  f.append('photo', new File([new Uint8Array([0xff, 0xd8])], 'label.jpg', { type: 'image/jpeg' }));
  if (name) f.append('name', name);
  return f;
};

describe('label drafts', () => {
  it('reads every label nutrient for one serving and converts a printed volume', () => {
    const d = validateDraft({
      name: 'Pistachio Cream Cold Brew',
      brand: 'Starbucks',
      serving_amount: 16,
      serving_unit: 'fl oz',
      serving_grams: 400,
      kcal: 250,
      protein: 3,
      fat: 12,
      carbs: 31,
      fiber: 0,
      sugars: 30,
      sat_fat: 8,
      sodium: 125,
    });
    expect(d).toMatchObject({ name: 'Pistachio Cream Cold Brew', brand: 'Starbucks', serving_grams: 473.2, serving_grams_estimated: false });
    expect(d.per_serving).toEqual({ ENERC_KCAL: 250, PROCNT: 3, FAT: 12, CHOCDF: 31, FIBTG: 0, SUGAR: 30, FASAT: 8, NA: 125 });
  });

  it("uses the user's name and flags an estimated serving weight", () => {
    const d = validateDraft({ name: 'Protein Bar', serving_amount: 1, serving_unit: 'bar', serving_grams: 60, serving_grams_printed: false, kcal: 210 }, 'My bar');
    expect(d).toMatchObject({ name: 'My bar', serving_grams: 60, serving_grams_estimated: true });
  });

  it('rejects a read without calories', () => {
    expect(() => validateDraft({ name: 'x', serving_amount: 1, serving_unit: 'cup' })).toThrow(/calories/);
  });
});

describe('custom foods', () => {
  const E = { DEV_USER_EMAIL: 'custom-foods@example.test' };

  it('reads a label photo into a draft without saving it', async () => {
    const out = { name: 'Oat bar', brand: 'Acme', serving_amount: 40, serving_unit: 'g', kcal: 180, protein: 4, sodium: 95 };
    const r = await api('/foods/label', { method: 'POST', body: photoForm() }, { ...E, AI: ai(out) });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ name: 'Oat bar', serving_grams: 40, per_serving: { ENERC_KCAL: 180, PROCNT: 4, NA: 95 } });
    expect((await api('/foods/mine', {}, E)).data).toEqual([]);

    const bad = await api('/foods/label', { method: 'POST', body: photoForm() }, { ...E, AI: ai({ name: 'blurry' }) });
    expect(bad.status).toBe(422);
  });

  it('creates, lists, edits and deletes a custom food', async () => {
    const created = await api(
      '/foods',
      {
        method: 'POST',
        json: { name: 'Seasonal cold brew', brand: 'Starbucks', serving_grams: 473, serving_label: 'Grande (16 fl oz)', per_serving: { ENERC_KCAL: 250, PROCNT: 3, NA: 125 } },
      },
      E,
    );
    expect(created.status).toBe(201);
    const id = created.data.id;
    expect(created.data.nutrients.find((n: any) => n.code === 'ENERC_KCAL').value).toBeCloseTo(52.85, 1);

    const mine = await api('/foods/mine', {}, E);
    expect(mine.data.map((f: any) => f.name)).toEqual(['Seasonal cold brew']);
    expect(mine.data[0]).toMatchObject({ times_logged: 0, portions: [{ label: 'Grande (16 fl oz)', grams: 473 }] });
    expect((await api('/foods?q=cold%20brew&remote=0', {}, E)).data.local.map((f: any) => f.id)).toContain(id);

    const edited = await api('/foods/' + id, { method: 'PUT', json: { name: 'Seasonal cold brew, grande', serving_grams: 473, per_serving: { ENERC_KCAL: 260 } } }, E);
    expect(edited.status).toBe(200);
    expect(edited.data.name).toBe('Seasonal cold brew, grande');
    expect(edited.data.nutrients.map((n: any) => n.code)).toEqual(['ENERC_KCAL']);

    // Someone else can't touch it.
    const other = await api('/foods/' + id, { method: 'DELETE' }, { DEV_USER_EMAIL: 'someone-else@example.test' });
    expect(other.status).toBe(404);

    expect((await api('/foods/' + id, { method: 'DELETE' }, E)).status).toBe(204);
    expect((await api('/foods/mine', {}, E)).data).toEqual([]);
    expect((await api('/foods?q=cold%20brew&remote=0', {}, E)).data.local.map((f: any) => f.id)).not.toContain(id);
    // Past logs still resolve it.
    expect((await api('/foods/' + id, {}, E)).status).toBe(200);
  });

  it('requires calories', async () => {
    const r = await api('/foods', { method: 'POST', json: { name: 'x', serving_grams: 10, per_serving: { PROCNT: 1 } } }, E);
    expect(r.status).toBe(400);
  });
});
