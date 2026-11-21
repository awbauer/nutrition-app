/**
 * Every number and word list that decides which food a description is matched to, in one place.
 *
 * scoring.ts (word and kcal scores), history.ts (the bonus for foods you've eaten), matcher.ts
 * (gathering candidates, the accept threshold and confidence) and pipeline.ts (when to ask a
 * question) all read from here. MATCHER_VERSION is a hash of this object, so changing any weight
 * changes the version recorded on each AI-logged item (meal_event), and the logging-quality card
 * compares fix rates per version without anyone remembering to bump it.
 *
 * To tune: change a value, run `npx vitest run test/golden.test.ts` (hit rate over real matching
 * cases in test/fixtures/golden-matches.json), and keep it at or above the baseline there.
 */

export interface MatchConfig {
  /**
   * Bump when scoring *code* changes in a way these numbers don't show (a new feature, a changed
   * formula), so the version changes with it.
   */
  logic: number;
  words: {
    /** Ignored in queries and names. */
    stop: string[];
    /** Words that change what the food *is*; a candidate with one the query lacks is penalised (`kind.unrequested`). */
    distinct: string[];
    /** Descriptors that say which version of the plain food it is; not counted as extra words. */
    neutral: string[];
    /** Words in a history query that point at the user's past rather than describe the food ("those", "my usual"). */
    filler: string[];
  };
  coverage: {
    /** Score for covering every query word (scaled by the share covered). */
    full: number;
    /** A brand word ("chick", "fil" in "Chick-fil-A Polynesian Sauce") counts this much relative to an item word. */
    brandWordWeight: number;
  };
  head: {
    /** The name's main segment (first, skipping a brand-only one) shares a word with the query. */
    hit: number;
    /** ... or doesn't ("Fish oil, salmon" for "salmon sashimi"). */
    miss: number;
  };
  extras: {
    /** Per name word the query doesn't have (and isn't neutral). */
    perWord: number;
    /** Extra words beyond this aren't penalised further. */
    maxWords: number;
  };
  kind: {
    /** A `distinct` word the query didn't ask for ("oil", "powder", "baby"). */
    unrequested: number;
  };
  brand: {
    /** The candidate's brand is mentioned in the query; replaces the data-type prior. */
    mentioned: number;
  };
  /** By database type, when no brand was mentioned: generic whole foods over branded products. */
  dataTypePrior: Record<string, number>;
  popularity: {
    /** Median NHANES person-days among survey foods anyone ate: the zero point. */
    wweiaMedianDays: number;
    /** Bonus per decade of survey days above the median. */
    wweiaPerDecade: number;
    wweiaMin: number;
    wweiaMax: number;
    /** FatSecret's first result gets this; it tapers to 0 at `fatsecretDepth`. */
    fatsecretTop: number;
    fatsecretDepth: number;
    /** Results above this rank say so in the reasons. */
    fatsecretShown: number;
  };
  plausibility: {
    /** Added to both kcal values before comparing, so near-zero foods (coffee, lettuce) aren't wildly "off". */
    kcalOffset: number;
    /** Bonus for matching the model's kcal estimate exactly, tapering to 0 at `taperRatio`. */
    closeBonus: number;
    taperRatio: number;
    /** Between `taperRatio` and `rejectRatio` off. */
    farPenalty: number;
    /** Beyond `rejectRatio` off: almost always the wrong food. */
    rejectRatio: number;
    rejectPenalty: number;
  };
  history: {
    /** Foods you've eaten whose names (or your words for them) cover every food word of the query. */
    bonus: number;
    /** ... eaten at least `frequentTimes` times. */
    frequentTimes: number;
    frequentBonus: number;
    /** The description pointed at your history ("those meatballs I like"). */
    fromHistoryBonus: number;
    /** bge-m3 cosine above which a food you've eaten shows in food search without covering the words. */
    searchMinSimilarity: number;
  };
  decision: {
    /** Minimum score to use a candidate; below it the model's estimate is used. */
    acceptScore: number;
    /** At or above this the match is sure; local foods this good skip the remote search. */
    confidentScore: number;
    /** Match confidence at `acceptScore`, rising linearly to `confidenceAtConfident`. */
    confidenceAtAccept: number;
    confidenceAtConfident: number;
    /** Confidence of an item logged from the model's estimate. */
    estimateConfidenceCap: number;
    /** Candidates kept on the item for the UI. */
    maxCandidates: number;
  };
  /** Flag an item "check match" when its food's kcal/100 g is this many times off the model's estimate, either way. */
  checkMatchKcalRatio: number;
  gather: {
    historyTopK: number;
    localMax: number;
    usdaPageSize: number;
    fatsecretMax: number;
  };
  questions: {
    /** Ask when the answer moves the meal's kcal by this share ... */
    minShare: number;
    /** ... or by this share when the item is shaky (below the user's confidence threshold). */
    shakyMinShare: number;
    /** Confidence lost by an item whose question was skipped. */
    skipPenalty: number;
  };
}

export const MATCH_CONFIG: MatchConfig = {
  logic: 7,
  words: {
    stop: ['and', 'with', 'the', 'of', 'a', 'an', 'in', 'on', 'or', 'for', 'to', 'style', 'plain', 'regular'],
    distinct: [
      'babyfood',
      'baby',
      'infant',
      'formula',
      'toddler',
      'oil',
      'powder',
      'powdered',
      'dry',
      'dried',
      'dehydrated',
      'concentrate',
      'mix',
      'flour',
      'shake',
      'shakes',
      'syrup',
      'candy',
      'candies',
      'pie',
      'filling',
      'sauce',
      'soup',
      'juice',
      'canned',
      'frozen',
      'imitation',
      'substitute',
      'flavored',
      'flavor',
      'supplement',
      'bar',
      // Preparations and products that aren't the plain food ("Egg, deviled" for "egg", "Bacon bits" for "bacon").
      'creamed',
      'deviled',
      'omelet',
      'souffle',
      'salad',
      'bits',
      'sticks',
      'jerky',
      'spread',
      'dip',
      'meatless',
      'vegetarian',
      'vegan',
      'meatfree',
      // FNDDS "for use on a sandwich" / "for use with vegetables": an ingredient in a recipe, not the food.
      'use',
    ],
    neutral: ['whole', 'large', 'medium', 'small', 'grade', 'fresh', 'raw', 'cooked', 'ns', 'as', 'type', 'unprepared', 'prepared'],
    filler: [
      'those',
      'that',
      'these',
      'this',
      'my',
      'usual',
      'like',
      'liked',
      'love',
      'i',
      'ive',
      'ones',
      'one',
      'same',
      'again',
      'before',
      'favorite',
      'favourite',
      'had',
      'have',
      'eat',
      'ate',
      'always',
      'get',
      'got',
      'the',
      'from',
      'last',
      'time',
      'yesterday',
      'regular',
    ],
  },
  coverage: { full: 1.0, brandWordWeight: 0.5 },
  head: { hit: 0.3, miss: -0.4 },
  extras: { perWord: 0.03, maxWords: 8 },
  kind: { unrequested: -0.5 },
  brand: { mentioned: 0.3 },
  dataTypePrior: {
    Foundation: 0.15,
    'SR Legacy': 0.15,
    'Survey (FNDDS)': 0.15,
    Branded: -0.25,
    'Open Food Facts': 0,
    // FatSecret's generic entries are user-curated averages: below USDA's lab data, above branded.
    FatSecret: 0,
    'FatSecret Brand': -0.25,
  },
  popularity: { wweiaMedianDays: 8, wweiaPerDecade: 0.08, wweiaMin: -0.15, wweiaMax: 0.2, fatsecretTop: 0.06, fatsecretDepth: 10, fatsecretShown: 3 },
  plausibility: { kcalOffset: 10, closeBonus: 0.3, taperRatio: 1.6, farPenalty: -0.25, rejectRatio: 2.5, rejectPenalty: -1.0 },
  history: { bonus: 0.3, frequentTimes: 3, frequentBonus: 0.1, fromHistoryBonus: 0.4, searchMinSimilarity: 0.6 },
  decision: { acceptScore: 0.6, confidentScore: 1.2, confidenceAtAccept: 0.5, confidenceAtConfident: 0.9, estimateConfidenceCap: 0.4, maxCandidates: 8 },
  checkMatchKcalRatio: 2,
  gather: { historyTopK: 6, localMax: 8, usdaPageSize: 25, fatsecretMax: 20 },
  questions: { minShare: 0.15, shakyMinShare: 0.05, skipPenalty: 0.15 },
};

/** JSON with object keys sorted, so the hash doesn't depend on the order keys were written in. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** 32-bit FNV-1a, as 6+ base-36 characters. Not cryptographic: it only has to change when the config does. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, '0');
}

export const matcherVersion = (c: MatchConfig) => `match-${shortHash(stableJson(c))}`;

/** Recorded with every AI-logged item; changes whenever any value in MATCH_CONFIG does. */
export const MATCHER_VERSION = matcherVersion(MATCH_CONFIG);
