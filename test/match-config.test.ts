import { describe, expect, it } from 'vitest';
import { MATCH_CONFIG, MATCHER_VERSION, matcherVersion, stableJson, type MatchConfig } from '../src/worker/lib/match-config';

const clone = (): MatchConfig => JSON.parse(JSON.stringify(MATCH_CONFIG));

describe('matcher version', () => {
  it('is a short hash of the config', () => {
    expect(MATCHER_VERSION).toMatch(/^match-[0-9a-z]{6,7}$/);
    expect(matcherVersion(clone())).toBe(MATCHER_VERSION);
  });

  it('changes when any weight, threshold or word list changes', () => {
    const tweaks: ((c: MatchConfig) => void)[] = [
      (c) => (c.head.hit = 0.31),
      (c) => (c.dataTypePrior.Branded = -0.2),
      (c) => c.words.distinct.push('pudding'),
      (c) => (c.decision.acceptScore = 0.65),
      (c) => (c.history.frequentTimes = 4),
      (c) => (c.questions.minShare = 0.2),
      (c) => (c.logic += 1),
    ];
    const versions = new Set([MATCHER_VERSION]);
    for (const t of tweaks) {
      const c = clone();
      t(c);
      versions.add(matcherVersion(c));
    }
    expect(versions.size).toBe(tweaks.length + 1);
  });

  it("doesn't depend on key order", () => {
    expect(stableJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(stableJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });
});
