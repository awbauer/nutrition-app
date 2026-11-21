/**
 * Search over what the user has already eaten, by meaning: "those chicken meatballs I like",
 * "my usual oatmeal", "the protein shake".
 *
 * Each food the user has logged becomes one history_entry row (their own wordings, the food's
 * name and brand, how often and when) and one vector in the HISTORY Vectorize index, filtered by
 * user. Vectors only find candidates: embeddings put "turkey meatballs" right next to "chicken
 * meatballs", so the matcher still scores candidates on their words (scoring.ts) before using one.
 *
 * Triggers (migrations/0014) mark each (user, food) a write may have changed in history_dirty, in
 * the same statement as the write. refreshHistory() recomputes only those foods, diffs them against
 * history_entry and re-embeds only entries whose text changed. It runs after meals change and on the
 * cron, which also rebuilds each user in full the first time (the backfill) and daily as a safety net.
 */
import type { Env } from '../env';
import { getFood, normName, type FoodRecord } from './foods';
import { chunks, newId } from './ids';
import { has, tokens } from './scoring';

export const EMBED_MODEL = '@cf/baai/bge-m3';
/** Workers AI takes up to 100 texts per embedding call. */
const EMBED_BATCH = 100;
/** Vectorize allows up to 1000 ids per delete. */
const DELETE_BATCH = 1000;

/** Words that point at the user's past rather than describing the food. */
const FILLER = new Set([
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
]);

/** "those chicken meatballs I like" -> "chicken meatballs". Falls back to the input if nothing is left. */
export function foodWords(q: string): string {
  const kept = normName(q)
    .split(' ')
    .filter((t) => t && !FILLER.has(t));
  return kept.length ? kept.join(' ') : normName(q);
}

/** Every food word of the query appears in `name` ("chicken meatballs" in "Chicken meatballs, Kirkland"). */
export function coversQuery(q: string, name: string): boolean {
  const want = tokens(foodWords(q));
  const got = new Set(tokens(name));
  return want.length > 0 && want.every((t) => has(got, t));
}

/**
 * Extra score for a food the user has eaten, on top of its word score. Only when it covers every
 * food word of the query: having eaten chicken wings says nothing about "chicken meatballs".
 */
export function historyBonus(h: { times: number; names: string[]; food: { name: string } }, query: string, fromHistory: boolean): number {
  if (![h.food.name, ...h.names].some((n) => coversQuery(query, n))) return 0;
  return 0.3 + (h.times >= 3 ? 0.1 : 0) + (fromHistory ? 0.4 : 0);
}

export interface HistoryHit {
  food: FoodRecord;
  /** The user's own names for it, most used first. */
  names: string[];
  times: number;
  last_at: string;
  /** Cosine similarity from the vector search (0-1). */
  similarity: number;
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const gatewayOpts = (env: Env) => (env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {});

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const r = (await env.AI.run(EMBED_MODEL as Parameters<Ai['run']>[0], { text: texts.slice(i, i + EMBED_BATCH) } as never, gatewayOpts(env) as never)) as {
      data: number[][];
    };
    out.push(...r.data);
  }
  return out;
}

/** What gets embedded for one food: the user's wordings first, then the database name and brand. */
export function entryText(names: string[], food: { name: string; brand: string | null }): string {
  const own = names.filter((n) => normName(n) !== normName(food.name));
  return [...own, `${food.name}${food.brand ? ` (${food.brand})` : ''}`].join('; ');
}

interface Group {
  user_id: string;
  food_id: string;
  times: number;
  last_at: string;
  names: string[];
  name: string;
  brand: string | null;
}

interface EntryRow {
  user_id: string;
  food_id: string;
  vector_id: string;
  text: string;
  times: number;
  last_at: string;
  names_json: string;
  indexed_at: string | null;
}

/** `AND <col> IN (?, ...)` for one chunk of ids; nothing when there's no chunk (all foods). */
const inIds = (col: string, ids: string[] | null) => (ids ? `AND ${col} IN (${ids.map(() => '?').join(',')})` : '');

/**
 * Foods the user has eaten (completed meals; AI estimates excluded: each is a one-off guess), all of
 * them or only `foodIds` (queried in chunks under D1's bound-parameter limit).
 */
async function currentGroups(db: D1Database, userId: string, foodIds: string[] | null): Promise<Group[]> {
  type Row = { user_id: string; food_id: string; display_name: string; n: number; last_at: string; name: string; brand: string | null };
  const rows: Row[] = [];
  for (const ids of foodIds ? chunks(foodIds) : [null]) {
    const { results } = await db
      .prepare(
        `SELECT ci.user_id, ci.food_id, ci.display_name, COUNT(*) AS n, MAX(i.occurrence_at) AS last_at, f.name, f.brand
         FROM consumed_item ci
         JOIN nutrition_intake i ON i.id = ci.intake_id
         JOIN food f ON f.id = ci.food_id
         WHERE i.status = 'completed' AND f.source != 'estimate' AND f.archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM recipe r WHERE r.food_id = f.id AND r.archived = 1)
           AND ci.user_id = ? ${inIds('ci.food_id', ids)}
         GROUP BY ci.user_id, ci.food_id, ci.display_name`,
      )
      .bind(userId, ...(ids ?? []))
      .all<Row>();
    rows.push(...results);
  }
  const byKey = new Map<string, Group & { counts: Map<string, number> }>();
  for (const r of rows) {
    const key = `${r.user_id}\u0000${r.food_id}`;
    let g = byKey.get(key);
    if (!g) {
      g = { user_id: r.user_id, food_id: r.food_id, times: 0, last_at: r.last_at, names: [], name: r.name, brand: r.brand, counts: new Map() };
      byKey.set(key, g);
    }
    g.times += r.n;
    if (r.last_at > g.last_at) g.last_at = r.last_at;
    const k = r.display_name.trim();
    if (k) g.counts.set(k, (g.counts.get(k) ?? 0) + r.n);
  }
  return [...byKey.values()].map(({ counts, ...g }) => ({
    ...g,
    names: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([n]) => n),
  }));
}

/** The user's history entries, all of them or only `foodIds`. */
async function storedEntries(db: D1Database, userId: string, foodIds: string[] | null): Promise<EntryRow[]> {
  const out: EntryRow[] = [];
  for (const ids of foodIds ? chunks(foodIds) : [null]) {
    const { results } = await db
      .prepare(`SELECT user_id, food_id, vector_id, text, times, last_at, names_json, indexed_at FROM history_entry WHERE user_id = ? ${inIds('food_id', ids)}`)
      .bind(userId, ...(ids ?? []))
      .all<EntryRow>();
    out.push(...results);
  }
  return out;
}

/**
 * Bring `existing` entries in line with `groups` (both covering the same foods): embeds new and
 * reworded entries, removes the vectors of foods no longer eaten, and returns the D1 writes to make.
 */
async function syncEntries(env: Env, groups: Group[], existing: EntryRow[]): Promise<{ stmts: D1PreparedStatement[]; embedded: number; removed: number }> {
  const db = env.DB;
  const old = new Map(existing.map((e) => [`${e.user_id}\u0000${e.food_id}`, e]));

  const toEmbed: (Group & { vector_id: string; text: string })[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const g of groups) {
    const key = `${g.user_id}\u0000${g.food_id}`;
    const prev = old.get(key);
    old.delete(key);
    const text = entryText(g.names, g);
    const names = JSON.stringify(g.names);
    if (prev && prev.text === text && prev.indexed_at) {
      if (prev.times !== g.times || prev.last_at !== g.last_at || prev.names_json !== names)
        stmts.push(
          db.prepare('UPDATE history_entry SET times = ?, last_at = ?, names_json = ? WHERE user_id = ? AND food_id = ?').bind(g.times, g.last_at, names, g.user_id, g.food_id),
        );
      continue;
    }
    toEmbed.push({ ...g, vector_id: prev?.vector_id ?? (await sha256(key)), text });
  }
  const gone = [...old.values()];

  if (toEmbed.length && env.HISTORY) {
    const vectors = await embed(
      env,
      toEmbed.map((e) => e.text),
    );
    await env.HISTORY.upsert(toEmbed.map((e, i) => ({ id: e.vector_id, values: vectors[i]!, metadata: { user_id: e.user_id, food_id: e.food_id } })));
  }
  for (const e of toEmbed) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO history_entry (user_id, food_id, vector_id, text, names_json, times, last_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, food_id) DO UPDATE SET text = excluded.text, names_json = excluded.names_json, times = excluded.times,
             last_at = excluded.last_at, indexed_at = excluded.indexed_at`,
        )
        .bind(e.user_id, e.food_id, e.vector_id, e.text, JSON.stringify(e.names), e.times, e.last_at, env.HISTORY ? new Date().toISOString() : null),
    );
  }
  if (gone.length && env.HISTORY) {
    for (let i = 0; i < gone.length; i += DELETE_BATCH) await env.HISTORY.deleteByIds(gone.slice(i, i + DELETE_BATCH).map((e) => e.vector_id));
  }
  for (const e of gone) stmts.push(db.prepare('DELETE FROM history_entry WHERE user_id = ? AND food_id = ?').bind(e.user_id, e.food_id));
  return { stmts, embedded: env.HISTORY ? toEmbed.length : 0, removed: gone.length };
}

/** A refresh that died holding its claim (worker evicted) stops blocking others after this long. */
const CLAIM_TTL_MS = 2 * 60_000;
/** Rounds one refresh runs to pick up foods marked while it worked (including by refreshes it turned away). */
const MAX_ROUNDS = 3;
/** The cron rebuilds each user's history in full this often, as a safety net. */
const FULL_REBUILD_MS = 24 * 3600_000;

/**
 * Claim the user's history for one refresh, unless another refresh holds it. Returns when it was
 * last rebuilt in full (null: never), or undefined when it's taken.
 */
async function claimHistory(db: D1Database, userId: string, claim: string): Promise<{ rebuilt_at: string | null } | undefined> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO history_state (user_id, claim, claimed_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET claim = excluded.claim, claimed_at = excluded.claimed_at
         WHERE history_state.claim IS NULL OR history_state.claimed_at < ?
       RETURNING rebuilt_at`,
    )
    .bind(userId, claim, new Date(now).toISOString(), new Date(now - CLAIM_TTL_MS).toISOString())
    .first<{ rebuilt_at: string | null }>();
  return row ?? undefined;
}

/** One claimed round: recompute the marked foods (or all of them), then drop the marks it read and the claim. */
async function refreshClaimed(env: Env, userId: string, claim: string, full: boolean): Promise<{ embedded: number; removed: number }> {
  const db = env.DB;
  // Marks written from here on get higher ids and survive this round.
  const upTo = (await db.prepare('SELECT MAX(id) AS id FROM history_dirty WHERE user_id = ?').bind(userId).first<{ id: number | null }>())?.id ?? 0;
  let foodIds: string[] | null = null;
  if (!full) {
    const { results } = await db.prepare('SELECT DISTINCT food_id FROM history_dirty WHERE user_id = ? AND id <= ?').bind(userId, upTo).all<{ food_id: string }>();
    foodIds = results.map((r) => r.food_id);
  }
  const { stmts, embedded, removed } =
    foodIds?.length === 0
      ? { stmts: [] as D1PreparedStatement[], embedded: 0, removed: 0 }
      : await syncEntries(env, await currentGroups(db, userId, foodIds), await storedEntries(db, userId, foodIds));
  stmts.push(db.prepare('DELETE FROM history_dirty WHERE user_id = ? AND id <= ?').bind(userId, upTo));
  stmts.push(
    db
      .prepare('UPDATE history_state SET claim = NULL, claimed_at = NULL, rebuilt_at = COALESCE(?, rebuilt_at) WHERE user_id = ? AND claim = ?')
      .bind(full ? new Date().toISOString() : null, userId, claim),
  );
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { embedded, removed };
}

/**
 * Bring one user's history_entry rows and vectors in line with the log. Only foods marked dirty
 * since the last refresh are recomputed; the user's first refresh (and `full`) rebuilds all of them.
 * Returns at once when another refresh for the user is running: that one picks up the new marks.
 * Returns how many entries were embedded and removed.
 */
export async function refreshHistory(env: Env, userId: string, opts: { full?: boolean } = {}): Promise<{ embedded: number; removed: number }> {
  const db = env.DB;
  const total = { embedded: 0, removed: 0 };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const force = round === 0 && !!opts.full;
    if (!force) {
      const s = await db
        .prepare('SELECT (SELECT rebuilt_at FROM history_state WHERE user_id = ?1) AS rebuilt_at, EXISTS (SELECT 1 FROM history_dirty WHERE user_id = ?1) AS dirty')
        .bind(userId)
        .first<{ rebuilt_at: string | null; dirty: number }>();
      if (s?.rebuilt_at && !s.dirty) break;
    }
    const claim = newId();
    const state = await claimHistory(db, userId, claim);
    if (!state) break;
    try {
      const r = await refreshClaimed(env, userId, claim, force || !state.rebuilt_at);
      total.embedded += r.embedded;
      total.removed += r.removed;
    } catch (e) {
      await db.prepare('UPDATE history_state SET claim = NULL, claimed_at = NULL WHERE user_id = ? AND claim = ?').bind(userId, claim).run();
      throw e;
    }
  }
  return total;
}

/**
 * The cron's pass: every user with marked foods, incrementally, and a full rebuild for users never
 * rebuilt (the backfill) or not in the last day. One user's failure doesn't stop the rest.
 */
export async function refreshAllHistory(env: Env, now = new Date()): Promise<{ users: number; embedded: number; removed: number; failed: number }> {
  const stale = new Date(now.getTime() - FULL_REBUILD_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT u.id, (s.rebuilt_at IS NULL OR s.rebuilt_at < ?1) AS full FROM users u LEFT JOIN history_state s ON s.user_id = u.id
     WHERE s.rebuilt_at IS NULL OR s.rebuilt_at < ?1 OR EXISTS (SELECT 1 FROM history_dirty d WHERE d.user_id = u.id)`,
  )
    .bind(stale)
    .all<{ id: string; full: number }>();
  const total = { users: results.length, embedded: 0, removed: 0, failed: 0 };
  for (const u of results) {
    try {
      const r = await refreshHistory(env, u.id, { full: !!u.full });
      total.embedded += r.embedded;
      total.removed += r.removed;
    } catch (e) {
      total.failed++;
      console.warn('history refresh failed', (e as Error).message);
    }
  }
  return total;
}

/** Refresh one user's history in the background; failures only log. */
export function refreshLater(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, userId: string) {
  ctx.waitUntil(refreshHistory(env, userId).catch((e) => console.warn('history refresh failed', (e as Error).message)));
}

/**
 * Foods the user has eaten that mean something like `q`, best first. Empty when the index
 * isn't bound or the search fails: history only ever adds candidates.
 */
export async function searchHistory(env: Env, userId: string, q: string, topK = 6): Promise<HistoryHit[]> {
  if (!env.HISTORY || !q.trim()) return [];
  try {
    const [vec] = await embed(env, [foodWords(q)]);
    const res = await env.HISTORY.query(vec!, { topK, filter: { user_id: userId }, returnMetadata: 'none' });
    if (!res.matches.length) return [];
    const ids = res.matches.map((m) => m.id);
    const { results } = await env.DB.prepare(
      `SELECT vector_id, food_id, names_json, times, last_at FROM history_entry WHERE user_id = ? AND vector_id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(userId, ...ids)
      .all<{ vector_id: string; food_id: string; names_json: string; times: number; last_at: string }>();
    const rows = new Map(results.map((r) => [r.vector_id, r]));
    const hits: HistoryHit[] = [];
    for (const m of res.matches) {
      const row = rows.get(m.id);
      if (!row) continue; // removed since it was indexed
      const food = await getFood(env.DB, userId, row.food_id);
      if (food) hits.push({ food, names: JSON.parse(row.names_json) as string[], times: row.times, last_at: row.last_at, similarity: m.score });
    }
    return hits;
  } catch (e) {
    console.warn('history search failed', (e as Error).message);
    return [];
  }
}
