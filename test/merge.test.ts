import { describe, expect, it } from 'vitest';
import { api } from './helpers';

const ai = (out: unknown) => ({ run: async () => ({ response: out }) }) as unknown as Ai;
const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const AT = (h: number) => `2026-11-10T${String(h).padStart(2, '0')}:00:00Z`;

async function setup(email: string) {
  const U = { DEV_USER_EMAIL: email };
  await api('/settings', { method: 'PUT', json: { timezone: 'UTC' } }, U);
  const toast = await api('/foods', { method: 'POST', json: { name: 'Toast', per_100g: { ENERC_KCAL: 260, PROCNT: 9 } } }, U);
  const egg = await api('/foods', { method: 'POST', json: { name: 'Egg', per_100g: { ENERC_KCAL: 143, PROCNT: 12.6 } } }, U);
  return { U, toast: toast.data.id as string, egg: egg.data.id as string };
}

describe('adding to an existing meal', () => {
  it('main button: a second lunch joins the day\'s lunch; snacks stay separate', async () => {
    const { U, toast, egg } = await setup('merge-manual@example.test');
    const a = await api('/intake', { method: 'POST', json: { meal_type: 'lunch', occurrence_at: AT(12), merge: true, items: [{ food_id: toast, amount: 50, unit: 'g' }] } }, U);
    const b = await api('/intake', { method: 'POST', json: { meal_type: 'lunch', occurrence_at: AT(13), merge: true, items: [{ food_id: egg, amount: 100, unit: 'g' }] } }, U);
    expect(b.data.id).toBe(a.data.id);
    expect(b.data.items.map((i: any) => i.display_name)).toEqual(['Toast', 'Egg']);

    const s1 = await api('/intake', { method: 'POST', json: { meal_type: 'snack', occurrence_at: AT(15), merge: true, items: [{ food_id: toast, amount: 20, unit: 'g' }] } }, U);
    const s2 = await api('/intake', { method: 'POST', json: { meal_type: 'snack', occurrence_at: AT(16), merge: true, items: [{ food_id: toast, amount: 20, unit: 'g' }] } }, U);
    expect(s2.data.id).not.toBe(s1.data.id);

    // Without merge (old clients), a separate entry is created as before.
    const c = await api('/intake', { method: 'POST', json: { meal_type: 'lunch', occurrence_at: AT(14), items: [{ food_id: egg, amount: 50, unit: 'g' }] } }, U);
    expect(c.data.id).not.toBe(a.data.id);
    // A different day doesn't merge.
    const d = await api('/intake', { method: 'POST', json: { meal_type: 'lunch', occurrence_at: '2026-11-11T12:00:00Z', merge: true, items: [{ food_id: egg, amount: 50, unit: 'g' }] } }, U);
    expect(d.data.log_date).toBe('2026-11-11');
    expect(d.data.id).not.toBe(a.data.id);
  });

  it("a meal's Add item goes into that meal, including snacks", async () => {
    const { U, toast, egg } = await setup('merge-into@example.test');
    const s = await api('/intake', { method: 'POST', json: { meal_type: 'snack', occurrence_at: AT(15), items: [{ food_id: toast, amount: 20, unit: 'g' }] } }, U);
    const r = await api('/intake', { method: 'POST', json: { append_to: s.data.id, items: [{ food_id: egg, amount: 50, unit: 'g' }] } }, U);
    expect(r.data.id).toBe(s.data.id);
    expect(r.data.items).toHaveLength(2);
  });

  it('AI entries are analyzed, then merged into the day\'s meal of their type', async () => {
    const { U, toast } = await setup('merge-ai@example.test');
    const lunch = await api('/intake', { method: 'POST', json: { meal_type: 'lunch', occurrence_at: AT(12), items: [{ food_id: toast, amount: 50, unit: 'g' }] } }, U);
    const out = { items: [{ name: 'egg', amount: 100, unit: 'g', confidence: 0.9, estimate_per_100g: { kcal: 143, protein: 12 } }], questions: [] };
    const r = await api('/intake', { method: 'POST', body: form({ text: 'an egg', meal_type: 'lunch', occurrence_at: AT(13), merge: '1' }) }, { ...U, AI: ai(out) });
    expect(r.status).toBe(202);
    expect(r.data.id).toBe(lunch.data.id);
    expect(r.data.merged_from).toBeTruthy();
    expect(r.data.items.map((i: any) => i.display_name)).toEqual(['Toast', 'egg']);
    expect(r.data.raw_input_text).toBe('an egg');

    // The draft id follows to the meal.
    const follow = await api(`/intake/${r.data.merged_from}`, {}, U);
    expect(follow.data).toMatchObject({ id: lunch.data.id, merged_from: r.data.merged_from });
    const day = await api('/day/2026-11-10', {}, U);
    expect(day.data.meals.filter((m: any) => m.meal_type === 'lunch')).toHaveLength(1);
  });

  it('AI entries with questions merge after they are answered', async () => {
    const { U, toast } = await setup('merge-questions@example.test');
    const dinner = await api('/intake', { method: 'POST', json: { meal_type: 'dinner', occurrence_at: AT(19), items: [{ food_id: toast, amount: 50, unit: 'g' }] } }, U);
    const out = {
      items: [{ name: 'egg', amount: 100, unit: 'g', confidence: 0.5, estimate_per_100g: { kcal: 143 } }],
      questions: [{ id: 'q1', item_index: 0, text: 'How many?', options: ['One (50 g)', 'Three (150 g)'], default: 'One (50 g)', effects: { 'One (50 g)': { set_amount: { amount: 50, unit: 'g' } }, 'Three (150 g)': { set_amount: { amount: 150, unit: 'g' } } } }],
    };
    const r = await api('/intake', { method: 'POST', body: form({ text: 'eggs', meal_type: 'dinner', occurrence_at: AT(20), merge: '1' }) }, { ...U, AI: ai(out) });
    expect(r.data.status).toBe('in-progress');
    expect(r.data.id).not.toBe(dinner.data.id);
    const done = await api(`/intake/${r.data.id}/answers`, { method: 'POST', json: { answers: { q1: 'Three (150 g)' } } }, U);
    expect(done.data.id).toBe(dinner.data.id);
    expect(done.data.items.map((i: any) => i.grams)).toEqual([50, 150]);
  });

  it("an AI entry added from a meal's Add item takes that meal's type and time while it's analyzed", async () => {
    const { U, toast } = await setup('merge-into-ai@example.test');
    const lunch = await api('/intake', { method: 'POST', json: { meal_type: 'lunch', occurrence_at: AT(12), items: [{ food_id: toast, amount: 50, unit: 'g' }] } }, U);
    const sent: any[] = [];
    const JOBS = { send: async (m: unknown) => void sent.push(m) } as unknown as Queue<any>;
    const r = await api('/intake', { method: 'POST', body: form({ text: 'an apple', append_to: lunch.data.id }) }, { ...U, JOBS });
    expect(r.data).toMatchObject({ status: 'preparation', meal_type: 'lunch', occurrence_at: lunch.data.occurrence_at });
    expect(r.data.pending.adding_to_meal).toBe(true);
  });

  it("photos added from a meal's Add item join the meal's photos", async () => {
    const { U } = await setup('merge-photos@example.test');
    const out = { meal_type_guess: 'lunch', items: [{ name: 'apple', amount: 1, unit: 'medium', confidence: 0.9 }], questions: [] };
    const jpg = (n: number) => new File([new Uint8Array([0xff, 0xd8, n])], `p${n}.jpg`, { type: 'image/jpeg' });
    const first = new FormData();
    first.append('photo', jpg(1));
    first.append('meal_type', 'lunch');
    first.append('occurrence_at', AT(12));
    const lunch = await api('/intake', { method: 'POST', body: first }, { ...U, AI: ai(out) });
    expect(lunch.data.photo_count).toBe(1);
    const more = new FormData();
    more.append('photo', jpg(2));
    more.append('photo', jpg(3));
    more.append('append_to', lunch.data.id);
    const r = await api('/intake', { method: 'POST', body: more }, { ...U, AI: ai(out) });
    expect(r.data).toMatchObject({ id: lunch.data.id, photo_count: 3 });
    expect(r.data.items).toHaveLength(2);
    for (const n of [0, 1, 2]) expect((await api(`/intake/${lunch.data.id}/photos/${n}`, {}, U)).status).toBe(200);
  });

  it('only finished meals accept new items', async () => {
    const { U } = await setup('merge-guard@example.test');
    const out = { items: [{ name: 'egg', amount: 100, unit: 'g', confidence: 0.5 }], questions: [{ id: 'q1', item_index: 0, text: 'Size?', options: ['S', 'L'], default: 'S', effects: { S: { set_amount: { amount: 50, unit: 'g' } }, L: { set_amount: { amount: 300, unit: 'g' } } } }] };
    const open = await api('/intake', { method: 'POST', body: form({ text: 'eggs', meal_type: 'dinner' }) }, { ...U, AI: ai(out) });
    expect(open.data.status).toBe('in-progress');
    const r = await api('/intake', { method: 'POST', body: form({ text: 'toast', append_to: open.data.id }) }, U);
    expect(r.status).toBe(409);
    expect((await api('/intake', { method: 'POST', json: { append_to: 'nope', items: [] } }, U)).status).toBe(400);
  });
});
