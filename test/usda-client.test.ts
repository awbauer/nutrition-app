import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsdaClient, UsdaError } from '../src/worker/lib/usda';
import { api, json } from './helpers';

const food = (fdcId: number, description: string, kcal: number) => ({
  fdcId,
  description,
  dataType: 'SR Legacy',
  foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: kcal }],
  foodMeasures: [],
});

/** Behaves like FoodData Central: a request that overlaps another one gets HTTP 400. */
function overlapRejectingFetch(results: (q: string) => unknown) {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const fetcher = async (input: RequestInfo | URL) => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const overlapped = inFlight > 1;
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    if (overlapped) return new Response('<html>400 Bad Request</html>', { status: 400 });
    const q = new URL(String(input)).searchParams.get('query') ?? '';
    return json(results(q));
  };
  return { fetcher, stats: () => ({ calls, maxInFlight }) };
}

afterEach(() => vi.restoreAllMocks());

describe('USDA client', () => {
  it('sends one request at a time, so parallel lookups all succeed', async () => {
    const f = overlapRejectingFetch((q) => ({ foods: [food(1, q, 100)] }));
    const client = new UsdaClient('k', f.fetcher as typeof fetch);
    const res = await Promise.all(['pasta fresh', 'pesto', 'chicken meatballs'].map((q) => client.search(q, ['SR Legacy'])));
    expect(res.map((r) => r[0]!.name)).toEqual(['pasta fresh', 'pesto', 'chicken meatballs']);
    expect(f.stats().maxInFlight).toBe(1);
  });

  it('retries transient failures and gives up with a typed error', async () => {
    let n = 0;
    const flaky = async () => (++n === 1 ? new Response('busy', { status: 400 }) : json({ foods: [food(2, 'pasta', 131)] }));
    expect((await new UsdaClient('k', flaky as typeof fetch).search('pasta', ['SR Legacy']))[0]!.name).toBe('pasta');
    expect(n).toBe(2);

    let m = 0;
    const down = async () => (m++, new Response('no', { status: 503 }));
    await expect(new UsdaClient('k', down as typeof fetch).search('x', ['SR Legacy'])).rejects.toBeInstanceOf(UsdaError);
    expect(m).toBe(3);

    let k = 0;
    const forbidden = async () => (k++, new Response('bad key', { status: 403 }));
    await expect(new UsdaClient('k', forbidden as typeof fetch).search('x', ['SR Legacy'])).rejects.toThrow('USDA /foods/search 403');
    expect(k).toBe(1); // not retried
  }, 10000);
});

describe('matching a whole meal against an overlap-rejecting USDA', () => {
  it('matches every item (the fresh pasta case) and records lookup errors when USDA is down', async () => {
    const DB: Record<string, unknown[]> = {
      pasta: [food(169727, 'Pasta, fresh-refrigerated, plain, cooked', 131)],
      pesto: [food(171560, 'Pesto, basil, ready-to-serve', 418)],
      meatball: [food(2705969, 'Meatballs, chicken', 190)],
    };
    const f = overlapRejectingFetch((q) => ({ foods: Object.entries(DB).find(([k]) => q.includes(k))?.[1] ?? [] }));
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => f.fetcher(input as RequestInfo));
    const out = {
      items: [
        { name: 'fresh pasta', amount: 170, unit: 'g', confidence: 0.9, search_terms: ['pasta fresh'], estimate_per_100g: { kcal: 150 } },
        { name: 'pesto', amount: 15, unit: 'g', confidence: 0.8, search_terms: ['pesto'], estimate_per_100g: { kcal: 450 } },
        { name: 'chicken meatballs', amount: 3, unit: 'piece', grams: 90, confidence: 0.7, search_terms: ['chicken meatball'], estimate_per_100g: { kcal: 200 } },
      ],
      questions: [],
    };
    const ai = { run: async () => ({ response: out }) } as unknown as Ai;
    const form = new FormData();
    form.append('text', '6oz fresh pasta, spoonful pesto, 3 chicken meatballs');
    const r = await api('/intake', { method: 'POST', body: form }, { DEV_USER_EMAIL: 'serial@example.test', AI: ai });
    expect(r.data.items.map((i: any) => [i.food_name, i.estimated])).toEqual([
      ['Pasta, fresh-refrigerated, plain, cooked', false],
      ['Pesto, basil, ready-to-serve', false],
      ['Meatballs, chicken', false],
    ]);
    expect(f.stats().maxInFlight).toBe(1);

    // When USDA is down, the item falls back to the estimate and says why.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));
    const one = { items: [{ name: 'gnocchi', amount: 150, unit: 'g', confidence: 0.8, estimate_per_100g: { kcal: 130 } }], questions: [] };
    const f2 = new FormData();
    f2.append('text', 'gnocchi');
    const r2 = await api('/intake', { method: 'POST', body: f2 }, { DEV_USER_EMAIL: 'serial@example.test', AI: { run: async () => ({ response: one }) } as unknown as Ai });
    expect(r2.data.items[0].estimated).toBe(true);
    const d = await api(`/item/${r2.data.items[0].id}`, {}, { DEV_USER_EMAIL: 'serial@example.test' });
    expect(d.data.match.lookup_error).toBe('USDA /foods/search 503');
  }, 20000);
});
