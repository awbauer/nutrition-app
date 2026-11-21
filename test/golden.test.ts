/**
 * Golden-set evaluation of the matcher: runs decide() over real matching cases (the candidates the
 * food databases returned are stored, so it's offline and deterministic) and fails if the hit rate
 * drops below the baseline. Cases: test/fixtures/golden-matches.json, built with
 * scripts/golden-matches.ts (see the README). When a change raises the hit rate, raise BASELINE_HITS.
 */
import { describe, expect, it } from 'vitest';
import { decide, type MatchOption, type Origin } from '../src/worker/lib/decide';
import { MATCHER_VERSION } from '../src/worker/lib/match-config';
import golden from './fixtures/golden-matches.json';

interface GoldenCase {
  id: string;
  status: string;
  note?: string;
  request: { name: string; query: string; brand: string | null; estimate_kcal_100g: number | null };
  expect: string[];
  candidates: {
    source: string;
    id: string | null;
    name: string;
    brand: string | null;
    data_type: string | null;
    kcal_100g: number | null;
    source_rank: number | null;
    history?: { times: number; names: string[] };
  }[];
}

/** Reviewed cases the current matcher must get right, at least. */
const BASELINE_HITS = 35;

const ESTIMATE = '(estimate)';

function runCase(c: GoldenCase) {
  const options: MatchOption[] = c.candidates.map((x, i) => ({
    key: `${x.source}:${x.id ?? i}`,
    origin: (x.history ? 'history' : x.source) as Origin,
    name: x.name,
    brand: x.brand,
    dataType: x.data_type,
    kcal100: x.kcal_100g,
    sourceRank: x.source_rank,
    ...(x.history ? { history: x.history } : {}),
  }));
  const d = decide({ name: c.request.name, query: c.request.query, brand: c.request.brand, estimateKcal100: c.request.estimate_kcal_100g }, options);
  const picked = d.chosen?.candidate.name ?? ESTIMATE;
  return { picked, hit: c.expect.some((e) => e.toLowerCase() === picked.toLowerCase()), decision: d };
}

describe('golden matching set', () => {
  const cases = (golden as { cases: GoldenCase[] }).cases;
  const reviewed = cases.filter((c) => c.status === 'reviewed');

  it('has reviewed cases whose expected foods are among their candidates', () => {
    expect(reviewed.length).toBeGreaterThanOrEqual(30);
    for (const c of reviewed) {
      expect(c.expect.length, c.id).toBeGreaterThan(0);
      for (const e of c.expect)
        if (e !== ESTIMATE)
          expect(
            c.candidates.map((x) => x.name.toLowerCase()),
            `${c.id}: ${e}`,
          ).toContain(e.toLowerCase());
    }
  });

  it(`hits at least ${BASELINE_HITS} reviewed cases`, () => {
    const results = reviewed.map((c) => ({ c, ...runCase(c) }));
    const hits = results.filter((r) => r.hit).length;
    const misses = results.filter((r) => !r.hit).map((r) => `  ${r.c.id}: picked "${r.picked}", expected one of ${JSON.stringify(r.c.expect.slice(0, 3))}`);
    console.log(
      `golden set (${MATCHER_VERSION}): ${hits}/${reviewed.length} hit (${Math.round((100 * hits) / reviewed.length)}%), ${cases.length - reviewed.length} unreviewed${misses.length ? `\n${misses.join('\n')}` : ''}`,
    );
    expect(hits).toBeGreaterThanOrEqual(BASELINE_HITS);
  });
});
