/**
 * Search over what the user has already eaten, by meaning: "those chicken meatballs I like",
 * "my usual oatmeal", "the protein shake".
 *
 * Each food the user has logged becomes one history_entry row (their own wordings, the food's
 * name and brand, how often and when) and one vector in the HISTORY Vectorize index, filtered by
 * user. Vectors only find candidates: embeddings put "turkey meatballs" right next to "chicken
 * meatballs", so the matcher still scores candidates on their words (scoring.ts) before using one.
 *
 * refreshHistory() diffs the log against history_entry and only re-embeds entries whose text
 * changed; it runs after meals change and on the cron, which also backfills.
 */
import type { Env } from '../env';
import { getFood, normName, type FoodRecord } from './foods';
import { has, tokens } from './scoring';

export const EMBED_MODEL = '@cf/baai/bge-m3';
/** Workers AI takes up to 100 texts per embedding call. */
const EMBED_BATCH = 100;
/** Vectorize allows up to 1000 ids per delete. */
const DELETE_BATCH = 1000;

/** Words that point at the user's past rather than describing the food. */
const FILLER = new Set([
  'those', 'that', 'these', 'this', 'my', 'usual', 'like', 'liked', 'love', 'i', 'ive', 'ones', 'one', 'same', 'again', 'before',
  'favorite', 'favourite', 'had', 'have', 'eat', 'ate', 'always', 'get', 'got', 'the', 'from', 'last', 'time', 'yesterday', 'regular',
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

/** Foods each user has eaten (completed meals; AI estimates excluded: each is a one-off guess). */
async function currentGroups(db: D1Database, userId?: string): Promise<Group[]> {
  const { results } = await db
    .prepare(
      `SELECT ci.user_id, ci.food_id, ci.display_name, COUNT(*) AS n, MAX(i.occurrence_at) AS last_at, f.name, f.brand
       FROM consumed_item ci
       JOIN nutrition_intake i ON i.id = ci.intake_id
       JOIN food f ON f.id = ci.food_id
       WHERE i.status = 'completed' AND f.source != 'estimate' AND f.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM recipe r WHERE r.food_id = f.id AND r.archived = 1)
         ${userId ? 'AND ci.user_id = ?' : ''}
       GROUP BY ci.user_id, ci.food_id, ci.display_name`,
    )
    .bind(...(userId ? [userId] : []))
    .all<{ user_id: string; food_id: string; display_name: string; n: number; last_at: string; name: string; brand: string | null }>();
  const byKey = new Map<string, Group & { counts: Map<string, number> }>();
  for (const r of results) {
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
    names: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n),
  }));
}

/**
 * Bring history_entry and the vector index in line with the log, for one user or everyone.
 * Returns how many entries were embedded and removed.
 */
export async function refreshHistory(env: Env, userId?: string): Promise<{ embedded: number; removed: number }> {
  const db = env.DB;
  const groups = await currentGroups(db, userId);
  const { results: existing } = await db
    .prepare(`SELECT user_id, food_id, vector_id, text, times, last_at, names_json, indexed_at FROM history_entry ${userId ? 'WHERE user_id = ?' : ''}`)
    .bind(...(userId ? [userId] : []))
    .all<{ user_id: string; food_id: string; vector_id: string; text: string; times: number; last_at: string; names_json: string; indexed_at: string | null }>();
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
        stmts.push(db.prepare('UPDATE history_entry SET times = ?, last_at = ?, names_json = ? WHERE user_id = ? AND food_id = ?').bind(g.times, g.last_at, names, g.user_id, g.food_id));
      continue;
    }
    toEmbed.push({ ...g, vector_id: prev?.vector_id ?? (await sha256(key)), text });
  }
  const gone = [...old.values()];

  if (toEmbed.length && env.HISTORY) {
    const vectors = await embed(env, toEmbed.map((e) => e.text));
    await env.HISTORY.upsert(
      toEmbed.map((e, i) => ({ id: e.vector_id, values: vectors[i]!, metadata: { user_id: e.user_id, food_id: e.food_id } })),
    );
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
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { embedded: env.HISTORY ? toEmbed.length : 0, removed: gone.length };
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
