/**
 * The meal change log: an append-only record of what the AI logged and every change made after, so
 * we can see how a meal got to where it is and measure whether logging is working.
 *
 *   ai_logged      the AI's item: food, amount, how it was matched (query, via, top candidates)
 *   answered       answers to the AI's questions, with the items they produced
 *   item_added / item_removed / food_swapped / amount_changed / renamed
 *   meal_created / meal_changed / meal_deleted
 *   searched       a search for a different food for an item (query and top results)
 *
 * App and MCP changes are recorded by diffing the meal before and after the request (see app.ts),
 * so new routes are covered without wiring each one.
 */
import { MATCHER_VERSION } from './match-config';
import type { Env } from '../env';
import { newId } from './ids';

export type Actor = 'app' | 'mcp' | 'ai' | 'system';

export interface ItemSnap {
  id: string;
  name: string;
  food_id: string | null;
  food_name: string | null;
  source: string | null;
  amount: number;
  unit: string;
  grams: number;
  kcal: number | null;
  protein: number | null;
  confidence: number;
  via: string | null;
}

export interface MealSnap {
  id: string;
  status: string;
  meal_type: string;
  occurrence_at: string;
  log_date: string;
  items: ItemSnap[];
}

export interface MealEvent {
  intake_id: string;
  item_id?: string | null;
  actor: Actor;
  kind: string;
  before?: unknown;
  after?: unknown;
  detail?: unknown;
  /** When it happened, if not now (ISO). */
  at?: string;
}

const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** The meal and its items as they are now, or null if it doesn't exist (for this user). */
export async function snapshotMeal(db: D1Database, userId: string, intakeId: string): Promise<MealSnap | null> {
  const meal = await db
    .prepare('SELECT id, status, meal_type, occurrence_at, log_date FROM nutrition_intake WHERE id = ? AND user_id = ?')
    .bind(intakeId, userId)
    .first<Omit<MealSnap, 'items'>>();
  if (!meal) return null;
  const { results } = await db
    .prepare(
      `SELECT ci.id, ci.display_name AS name, ci.food_id, f.name AS food_name, f.source, ci.amount_value AS amount, ci.amount_unit AS unit,
         ci.grams, ci.confidence, ci.match_json,
         (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'ENERC_KCAL') AS kcal,
         (SELECT value FROM intake_nutrient n WHERE n.consumed_item_id = ci.id AND n.nutrient_code = 'PROCNT') AS protein
       FROM consumed_item ci LEFT JOIN food f ON f.id = ci.food_id WHERE ci.intake_id = ? ORDER BY ci.position`,
    )
    .bind(intakeId)
    .all<Omit<ItemSnap, 'via'> & { match_json: string | null }>();
  return {
    ...meal,
    items: results.map(({ match_json, ...it }) => ({
      ...it,
      grams: r1(it.grams)!,
      kcal: r1(it.kcal),
      protein: r1(it.protein),
      via: match_json ? ((JSON.parse(match_json) as { via?: string }).via ?? null) : null,
    })),
  };
}

/** Events describing how `before` became `after` (either may be null: created, or gone). */
export function diffMeal(before: MealSnap | null, after: MealSnap | null, actor: Actor, detail?: unknown): MealEvent[] {
  const id = (after ?? before)?.id;
  if (!id) return [];
  const ev = (e: Omit<MealEvent, 'intake_id' | 'actor'>): MealEvent => ({ intake_id: id, actor, ...e, ...(detail ? { detail } : {}) });
  const out: MealEvent[] = [];
  if (!before && after) {
    out.push(ev({ kind: 'meal_created', after: { ...after, items: undefined } }));
    for (const it of after.items) out.push(ev({ kind: 'item_added', item_id: it.id, after: it }));
    return out;
  }
  if (before && (!after || after.status === 'entered-in-error')) {
    if (before.status !== 'entered-in-error') out.push(ev({ kind: 'meal_deleted', before: { ...before, items: undefined } }));
    return out;
  }
  if (!before || !after) return out;
  const { items: _b, ...bm } = before;
  const { items: _a, ...am } = after;
  if (bm.meal_type !== am.meal_type || bm.occurrence_at !== am.occurrence_at || bm.log_date !== am.log_date) out.push(ev({ kind: 'meal_changed', before: bm, after: am }));
  const was = new Map(before.items.map((i) => [i.id, i]));
  const now = new Map(after.items.map((i) => [i.id, i]));
  for (const [iid, b] of was) {
    const a = now.get(iid);
    if (!a) {
      out.push(ev({ kind: 'item_removed', item_id: iid, before: b }));
      continue;
    }
    if (a.food_id !== b.food_id) out.push(ev({ kind: 'food_swapped', item_id: iid, before: b, after: a }));
    else if (a.amount !== b.amount || a.unit !== b.unit || a.grams !== b.grams) out.push(ev({ kind: 'amount_changed', item_id: iid, before: b, after: a }));
    if (a.name !== b.name) out.push(ev({ kind: 'renamed', item_id: iid, before: b, after: a }));
  }
  for (const [iid, a] of now) if (!was.has(iid)) out.push(ev({ kind: 'item_added', item_id: iid, after: a }));
  return out;
}

export function eventStatements(db: D1Database, userId: string, events: MealEvent[]): D1PreparedStatement[] {
  const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  return events.map((e) =>
    db
      .prepare(
        `INSERT INTO meal_event (id, user_id, intake_id, item_id, actor, kind, before_json, after_json, detail_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
      )
      .bind(newId(), userId, e.intake_id, e.item_id ?? null, e.actor, e.kind, j(e.before), j(e.after), j(e.detail), e.at ?? null),
  );
}

export async function recordEvents(db: D1Database, userId: string, events: MealEvent[]): Promise<void> {
  if (events.length) await db.batch(eventStatements(db, userId, events));
}

/** What the AI logged for a meal: one event per item, with how it was matched. */
export async function recordAiLogged(
  env: Env,
  userId: string,
  intakeId: string,
  info: { model_id: string; prompt_version: string; raw_input_text: string | null; source?: string; questions?: number },
): Promise<void> {
  const snap = await snapshotMeal(env.DB, userId, intakeId);
  if (!snap) return;
  const { results } = await env.DB.prepare('SELECT id, match_json FROM consumed_item WHERE intake_id = ?').bind(intakeId).all<{ id: string; match_json: string | null }>();
  const matches = new Map(results.map((r) => [r.id, r.match_json ? (JSON.parse(r.match_json) as Record<string, any>) : null]));
  await recordEvents(
    env.DB,
    userId,
    snap.items.map((it) => {
      const m = matches.get(it.id);
      return {
        intake_id: intakeId,
        item_id: it.id,
        actor: 'ai' as const,
        kind: 'ai_logged',
        after: it,
        detail: {
          ...info,
          matcher_version: MATCHER_VERSION,
          query: m?.query ?? null,
          via: m?.via ?? null,
          estimate_kcal_100g: m?.estimate_kcal_100g ?? null,
          // With what each feature added to the score, so tuning can be checked against what was logged.
          candidates: ((m?.candidates as any[]) ?? [])
            .slice(0, 4)
            .map((c) => ({ name: c.name, source: c.source, score: c.score, kcal_100g: c.kcal_100g, ...(c.parts ? { parts: c.parts } : {}) })),
          ...(m?.missing_words ? { missing_words: m.missing_words } : {}),
        },
      };
    }),
  );
}

// ---------- reading ----------

export interface StoredEvent {
  id: string;
  intake_id: string;
  item_id: string | null;
  at: string;
  actor: Actor;
  kind: string;
  before: ItemSnap | Record<string, unknown> | null;
  after: ItemSnap | Record<string, unknown> | null;
  detail: Record<string, any> | null;
  summary: string;
}

const amt = (s: Partial<ItemSnap> | null | undefined) => (s ? `${s.amount} ${s.unit} (${Math.round(s.grams ?? 0)} g, ${Math.round(s.kcal ?? 0)} kcal)` : '');
const who = (a: Actor) => (a === 'ai' ? 'AI' : a === 'mcp' ? 'Claude' : 'You');

/** One line, human-readable. */
export function summarize(e: Omit<StoredEvent, 'summary'>): string {
  const b = e.before as Partial<ItemSnap> | null;
  const a = e.after as Partial<ItemSnap> | null;
  const d = e.detail ?? {};
  switch (e.kind) {
    case 'ai_logged':
      return `AI logged "${a?.name}" as ${a?.food_name ?? 'an estimate'}, ${amt(a)}${d.via ? ` · via ${d.via}` : ''}${d.query ? ` for "${d.query}"` : ''}`;
    case 'answered':
      return `${who(e.actor)} answered ${
        Object.entries((d.answers as Record<string, string>) ?? {})
          .map(([, v]) => `"${v}"`)
          .join(', ') || 'with the defaults'
      }`;
    case 'searched':
      return `${who(e.actor)} searched "${d.query}" for "${d.item_name}"${d.results?.length ? `: ${d.results.slice(0, 3).join(' · ')}` : ': no results'}`;
    case 'food_swapped':
      return `${who(e.actor)} swapped "${b?.name}" from ${b?.food_name} to ${a?.food_name}: ${Math.round(b?.kcal ?? 0)} → ${Math.round(a?.kcal ?? 0)} kcal`;
    case 'amount_changed':
      return `${who(e.actor)} changed "${a?.name}" from ${amt(b)} to ${amt(a)}`;
    case 'renamed':
      return `${who(e.actor)} renamed "${b?.name}" to "${a?.name}"`;
    case 'item_added':
      return `${who(e.actor)} added "${a?.name}" (${a?.food_name}), ${amt(a)}`;
    case 'item_removed':
      return `${who(e.actor)} removed "${b?.name}" (${Math.round(b?.kcal ?? 0)} kcal)`;
    case 'meal_created':
      return `${who(e.actor)} logged the meal`;
    case 'meal_submitted':
      return `${who(e.actor)} sent ${d.source === 'text' ? `"${d.text}"` : `a ${d.source}`} to the AI`;
    case 'meal_changed':
      return `${who(e.actor)} changed the meal's time or type`;
    case 'meal_deleted':
      return `${who(e.actor)} deleted the meal`;
    default:
      return `${who(e.actor)}: ${e.kind}`;
  }
}

/** A meal's history, oldest first: its own events, its items' events, and drafts merged into it. */
export async function mealHistory(db: D1Database, userId: string, intakeId: string): Promise<StoredEvent[]> {
  const { results: from } = await db.prepare('SELECT from_id FROM intake_redirect WHERE user_id = ? AND to_id = ?').bind(userId, intakeId).all<{ from_id: string }>();
  const ids = [intakeId, ...from.map((f) => f.from_id)];
  const { results } = await db
    .prepare(
      `SELECT id, intake_id, item_id, at, actor, kind, before_json, after_json, detail_json FROM meal_event
       WHERE user_id = ? AND (intake_id IN (${ids.map(() => '?').join(',')})
         OR item_id IN (SELECT id FROM consumed_item WHERE intake_id = ?))
       ORDER BY at, rowid`,
    )
    .bind(userId, ...ids, intakeId)
    .all<{
      id: string;
      intake_id: string;
      item_id: string | null;
      at: string;
      actor: Actor;
      kind: string;
      before_json: string | null;
      after_json: string | null;
      detail_json: string | null;
    }>();
  return results.map((r) => {
    const e = {
      id: r.id,
      intake_id: r.intake_id,
      item_id: r.item_id,
      at: r.at,
      actor: r.actor,
      kind: r.kind,
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
    };
    return { ...e, summary: summarize(e) };
  });
}

// ---------- quality ----------

export interface LoggingQuality {
  days: number;
  since: string;
  ai_meals: number;
  ai_items: number;
  /** Share of the AI's items the user later changed, by what they did. */
  pct_swapped: number;
  pct_amount_changed: number;
  pct_removed: number;
  pct_any_fix: number;
  items_added_after_ai: number;
  searches: number;
  meals_with_3plus_fixes: number;
  by_via: { via: string; items: number; pct_fixed: number }[];
  by_prompt: { prompt_version: string; matcher_version: string; model: string; items: number; pct_fixed: number }[];
  /** What the AI picked and what it was changed to, most frequent first. */
  top_swaps: { name: string; from: string; to: string; times: number }[];
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/** How often the AI's items needed fixing, over the last `days` days. */
export async function loggingQuality(db: D1Database, userId: string, days = 30, now = new Date()): Promise<LoggingQuality> {
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const { results } = await db
    .prepare(`SELECT intake_id, item_id, actor, kind, before_json, after_json, detail_json FROM meal_event WHERE user_id = ? AND at >= ? ORDER BY at, rowid`)
    .bind(userId, since)
    .all<{ intake_id: string; item_id: string | null; actor: Actor; kind: string; before_json: string | null; after_json: string | null; detail_json: string | null }>();
  // The AI's items that still exist or were later changed (items replaced by answering questions drop out).
  const later = new Map<string, Set<string>>();
  for (const r of results) if (r.item_id && r.actor !== 'ai') (later.get(r.item_id) ?? later.set(r.item_id, new Set()).get(r.item_id)!).add(r.kind);
  const { results: alive } = await db.prepare('SELECT id FROM consumed_item WHERE user_id = ?').bind(userId).all<{ id: string }>();
  const exists = new Set(alive.map((a) => a.id));
  const ai = results.filter((r) => r.kind === 'ai_logged' && r.item_id && (exists.has(r.item_id) || later.has(r.item_id)));
  const fixedKinds = ['food_swapped', 'amount_changed', 'item_removed'];
  const fixed = (id: string) => fixedKinds.some((k) => later.get(id)?.has(k));
  const group = <K extends string>(key: (d: Record<string, any>) => K) => {
    const m = new Map<K, { items: number; fixed: number }>();
    for (const r of ai) {
      const k = key(JSON.parse(r.detail_json ?? '{}'));
      const g = m.get(k) ?? { items: 0, fixed: 0 };
      g.items++;
      if (fixed(r.item_id!)) g.fixed++;
      m.set(k, g);
    }
    return m;
  };
  const aiMeals = new Set(ai.map((r) => r.intake_id));
  const fixesPerMeal = new Map<string, number>();
  for (const r of results)
    if (r.actor !== 'ai' && fixedKinds.concat('item_added', 'searched').includes(r.kind)) fixesPerMeal.set(r.intake_id, (fixesPerMeal.get(r.intake_id) ?? 0) + 1);
  const swaps = new Map<string, { name: string; from: string; to: string; times: number }>();
  const aiIds = new Set(ai.map((r) => r.item_id));
  for (const r of results.filter((r) => r.kind === 'food_swapped' && aiIds.has(r.item_id))) {
    const b = JSON.parse(r.before_json ?? '{}') as ItemSnap;
    const a = JSON.parse(r.after_json ?? '{}') as ItemSnap;
    const k = `${b.name}|${b.food_name}|${a.food_name}`;
    const s = swaps.get(k) ?? { name: b.name, from: b.food_name ?? '', to: a.food_name ?? '', times: 0 };
    s.times++;
    swaps.set(k, s);
  }
  const has = (k: string) => ai.filter((r) => later.get(r.item_id!)?.has(k)).length;
  return {
    days,
    since,
    ai_meals: aiMeals.size,
    ai_items: ai.length,
    pct_swapped: pct(has('food_swapped'), ai.length),
    pct_amount_changed: pct(has('amount_changed'), ai.length),
    pct_removed: pct(has('item_removed'), ai.length),
    pct_any_fix: pct(ai.filter((r) => fixed(r.item_id!)).length, ai.length),
    items_added_after_ai: results.filter((r) => r.kind === 'item_added' && r.actor !== 'ai' && aiMeals.has(r.intake_id)).length,
    searches: results.filter((r) => r.kind === 'searched').length,
    meals_with_3plus_fixes: [...fixesPerMeal.values()].filter((n) => n >= 3).length,
    by_via: [...group((d) => String(d.via ?? 'unknown'))].map(([via, g]) => ({ via, items: g.items, pct_fixed: pct(g.fixed, g.items) })).sort((a, b) => b.items - a.items),
    by_prompt: [...group((d) => `${d.prompt_version ?? '?'}|${d.matcher_version ?? 'match-v1'}|${d.model_id ?? '?'}`)]
      .map(([k, g]) => {
        const [prompt_version, matcher_version, model] = k.split('|') as [string, string, string];
        return { prompt_version, matcher_version, model, items: g.items, pct_fixed: pct(g.fixed, g.items) };
      })
      .sort((a, b) => b.items - a.items),
    top_swaps: [...swaps.values()].sort((a, b) => b.times - a.times).slice(0, 10),
  };
}
