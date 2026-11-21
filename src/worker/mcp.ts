/**
 * Clem as an MCP server, for Claude and other MCP clients.
 *
 * Every tool calls the app's own /api routes as the signed-in user, so validation, matching,
 * nutrient maths and history updates are exactly what the app does. The user comes from the
 * OAuth grant (props.userId, set on the consent page); it reaches the API through env.MCP_USER,
 * which only this handler can set (env isn't reachable from a request).
 */
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { app } from './app';
import type { Env, User } from './env';
import { CARD_HTML } from './generated/card-html';

export interface McpProps {
  userId: string;
}

type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

class ApiError extends Error {}

/** Call /api/<path> as `user`. */
function apiFor(env: Env, ctx: ExecutionContext, user: User): Api {
  const internal: Env = { ...env, MCP_USER: user };
  return async (method, path, body) => {
    const init: RequestInit = { method, headers: {} };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await app.fetch(new Request(`https://clem.internal/api${path}`, init), internal, ctx);
    if (res.status === 204) return { ok: true };
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    return data;
  };
}

interface Meal {
  id: string;
  status: string;
}

/** The AI reads a meal in the background (usually a few seconds): wait for it, up to 45 s. */
async function finished(api: Api, meal: Meal): Promise<Meal> {
  const deadline = Date.now() + 45_000;
  let m = meal;
  while (m.status === 'preparation' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    m = (await api('GET', `/intake/${encodeURIComponent(m.id)}`)) as Meal;
  }
  return m;
}

type Rec = Record<string, any>;
const per100 = (nutrients: Rec[] | undefined, code: string) => {
  const v = nutrients?.find((n) => n.code === code)?.value;
  return v == null ? null : Math.round(v * 10) / 10;
};
/** First named portion: what "1 serving" means for this food. */
const portionOf = (f: Rec) => {
  const p = (f.portions as Rec[] | undefined)?.[0];
  return p
    ? `${/^\d/.test(p.label) ? p.label : `${p.amount} ${p.label}`} = ${Math.round(p.grams)} g`
    : f.default_serving_grams
      ? `1 serving = ${Math.round(f.default_serving_grams)} g`
      : null;
};

/**
 * One compact search row: ids to log it, what it is, per-100 g energy and macros, its serving.
 * The full records (every nutrient, every portion) run to hundreds of KB per search.
 */
function searchRow(f: Rec, kind: string): Rec {
  const local = 'id' in f;
  const ids = local ? { food_id: f.id } : f.source === 'fatsecret' ? { fatsecret_id: f.sourceId } : { fdc_id: f.sourceId };
  return {
    kind,
    ...ids,
    name: f.history?.names?.[0] ?? f.name,
    ...(f.history?.names?.[0] && f.history.names[0] !== f.name ? { food_name: f.name } : {}),
    brand: f.brand ?? null,
    source: local ? f.source : (f.source ?? 'usda'),
    kcal_100g: per100(f.nutrients, 'ENERC_KCAL'),
    protein_100g: per100(f.nutrients, 'PROCNT'),
    fat_100g: per100(f.nutrients, 'FAT'),
    carbs_100g: per100(f.nutrients, 'CHOCDF'),
    serving: portionOf(f),
    ...(f.history
      ? {
          times_eaten: f.history.times,
          last_eaten: f.history.last_at?.slice(0, 10),
        }
      : {}),
  };
}

/**
 * search_foods, for agents: the user's favorites, then foods they've eaten, then their own foods and
 * recipes, then the shared cache, then USDA and FatSecret alternated. Compact rows, `limit` in all.
 */
async function searchFoods(api: Api, query: string, limit: number) {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const [r, favs] = await Promise.all([api('GET', `/foods?q=${encodeURIComponent(query)}`) as Promise<Rec>, api('GET', '/foods/favorites') as Promise<Rec[]>]);
  const rows: Rec[] = [];
  const seen = new Set<string>();
  const push = (row: Rec) => {
    // A favorite is a portion of a food; the food itself can still be listed.
    const key = row.favorite_id ? `fav:${row.favorite_id}` : (row.food_id ?? (row.fdc_id ? `usda:${row.fdc_id}` : `fs:${row.fatsecret_id}`));
    if (seen.has(key) || rows.length >= limit) return;
    seen.add(key);
    rows.push(row);
  };
  for (const f of favs.filter((f) => words.every((w) => f.name.toLowerCase().includes(w))))
    push({
      kind: 'favorite',
      favorite_id: f.id,
      food_id: f.food_id,
      name: f.name,
      amount: f.amount,
      unit: f.unit,
      grams: f.grams,
      kcal: f.kcal,
    });
  for (const f of r.history ?? []) push(searchRow(f, 'eaten before'));
  const local: Rec[] = r.local ?? [];
  for (const f of local.filter((f) => f.owner_user_id)) push(searchRow(f, f.source === 'recipe' ? 'your recipe' : 'your food'));
  for (const f of local.filter((f) => !f.owner_user_id)) push(searchRow(f, 'logged before'));
  const usda: Rec[] = r.usda ?? [];
  const fs: Rec[] = r.fatsecret ?? [];
  for (let i = 0; i < Math.max(usda.length, fs.length); i++) {
    const u = usda[i];
    if (u) push(searchRow(u, 'database'));
    const f = fs[i];
    if (f) push(searchRow(f, 'database'));
  }
  return {
    query,
    results: rows,
    note: "Nutrients are per 100 g. Log a database or own-food row with log_food (its food_id, fdc_id or fatsecret_id plus an amount). Log a favorite row with log_favorite (its name), or with log_food using the row's food_id, amount and unit.",
    ...(r.usda_error ? { usda_error: r.usda_error } : {}),
  };
}

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }],
});

/** Clem's MCP App card (web/cards): one view; `card` in the structured result picks what it draws. */
export const CARD_URI = 'ui://clem/card.html';
type CardKind = 'day' | 'meal' | 'range' | 'coach';
const CARD_META = { ui: { resourceUri: CARD_URI } };
const fail = (e: unknown) => {
  // Tool errors went only to the client; log them (the message, not the meal text) so they show up in the Worker's logs.
  console.warn('mcp tool failed', (e as Error).message);
  return {
    content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
    isError: true,
  };
};
/** Like run(), and hands the card its data as structuredContent. */
const runCard = (card: CardKind, appUrl: string) => async (f: () => Promise<unknown>) => {
  try {
    const data = await f();
    return {
      ...ok(data),
      structuredContent: {
        card,
        app_url: appUrl,
        ...(data as Record<string, unknown>),
      },
    };
  } catch (e) {
    return fail(e);
  }
};
const run = async (f: () => Promise<unknown>) => {
  try {
    return ok(await f());
  } catch (e) {
    return fail(e);
  }
};

const date = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}|today)$/)
  .describe('YYYY-MM-DD, or "today"');
const mealType = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
const read = { readOnlyHint: true, openWorldHint: false };
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const destroy = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

const NUTRIENTS_NOTE = 'Nutrients use INFOODS codes: ENERC_KCAL kcal, PROCNT protein g, CHOCDF carbs g, FAT fat g, FIBTG fiber g, SUGAR sugars g, NA sodium mg.';

export function buildServer(api: Api, appUrl = ''): McpServer {
  const server = new McpServer(
    { name: 'clem', version: '1.0.0' },
    {
      instructions: `Clem is the user's food and nutrition log. ${NUTRIENTS_NOTE} Dates are the user's log dates (their day ends at their day cutoff, 04:00 by default).`,
    },
  );

  registerAppResource(server, 'Clem card', CARD_URI, { description: 'Clem’s card for days, meals, weeks and coach reports' }, async () => ({
    contents: [{ uri: CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: CARD_HTML }],
  }));
  const day = runCard('day', appUrl);
  const meal = runCard('meal', appUrl);
  const range = runCard('range', appUrl);
  const coach = runCard('coach', appUrl);

  // ---- reading the log ----
  registerAppTool(
    server,
    'get_day',
    {
      title: 'Get a day',
      description: `Meals, items and totals for one log date, with targets and what's left. Totals include meals still waiting on answers, at their default answers; \`unconfirmed\` says how many. ${NUTRIENTS_NOTE}`,
      inputSchema: z.object({ date: date.default('today') }),
      annotations: read,
      _meta: CARD_META,
    },
    async ({ date }) => day(() => api('GET', `/day/${date}`)),
  );
  registerAppTool(
    server,
    'get_range',
    {
      title: 'Daily totals for a range',
      description:
        'Per-day totals and meal counts between two dates (inclusive, up to a year), plus current targets. Defaults to the last 7 days. Meals still waiting on answers count at their default answers (`unconfirmed` per day).',
      inputSchema: z.object({
        from: z.string().optional().describe('YYYY-MM-DD'),
        to: z.string().optional().describe('YYYY-MM-DD'),
      }),
      annotations: read,
      _meta: CARD_META,
    },
    async ({ from, to }) => range(() => api('GET', `/range?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`)),
  );
  registerAppTool(
    server,
    'get_meal',
    {
      title: 'Get a meal',
      description: 'One meal with its items, nutrients and any open questions.',
      inputSchema: z.object({ meal_id: z.string() }),
      annotations: read,
      _meta: CARD_META,
    },
    async ({ meal_id }) => meal(() => api('GET', `/intake/${encodeURIComponent(meal_id)}`)),
  );
  server.registerTool(
    'get_item',
    {
      title: 'Get an item’s details',
      description: 'Everything behind one logged item: the matched food, how the amount was converted to grams, and the other database matches that were considered.',
      inputSchema: z.object({ item_id: z.string() }),
      annotations: read,
    },
    async ({ item_id }) => run(() => api('GET', `/item/${encodeURIComponent(item_id)}`)),
  );

  server.registerTool(
    'get_meal_history',
    {
      title: 'Get a meal’s change log',
      description:
        'Every change to one meal, oldest first: what the AI logged and how it matched each item, answers to its questions, searches, food swaps, amount changes, items added or removed, and who made each change (AI, the app, or Claude). Use it to see why a meal needed fixing.',
      inputSchema: z.object({ meal_id: z.string() }),
      annotations: read,
    },
    async ({ meal_id }) =>
      run(async () => {
        const h = (await api('GET', `/intake/${encodeURIComponent(meal_id)}/history`)) as {
          meal_id: string;
          events: { at: string; actor: string; kind: string; item_id: string | null; summary: string }[];
        };
        return { meal_id: h.meal_id, events: h.events.map(({ at, actor, kind, item_id, summary }) => ({ at, actor, kind, item_id, summary })) };
      }),
  );
  server.registerTool(
    'get_logging_quality',
    {
      title: 'How accurate the AI logging is',
      description:
        "How often the AI's logged items were later fixed (food swapped, amount changed, removed), by match source and prompt version, with the most common swaps. Use it to judge whether logging is working or needs adjustment.",
      inputSchema: z.object({ days: z.number().int().min(1).max(365).optional().describe('Defaults to 30') }),
      annotations: read,
    },
    async ({ days }) => run(() => api('GET', `/coach/quality?days=${days ?? 30}`)),
  );

  // ---- logging ----
  registerAppTool(
    server,
    'log_meal',
    {
      title: 'Log a meal from a description',
      description:
        'Log food described in plain words ("2 eggs and toast with butter", "grande pistachio cream cold brew"). The app’s AI splits it into items and matches each to a food database (USDA, FatSecret, the user’s own foods and history); this takes a few seconds. Returns the meal. If status is "in-progress" it has questions: answer them with answer_meal_questions. If it is still "preparation", check again later with get_meal.',
      inputSchema: z.object({
        description: z.string().min(2),
        meal_type: mealType.optional().describe('Defaults from the time of day'),
        occurrence_at: z.string().optional().describe('ISO time eaten; defaults to now'),
        add_to_meal_id: z.string().optional().describe('Append to this existing meal instead of creating one'),
      }),
      annotations: write,
      _meta: CARD_META,
    },
    async ({ description, meal_type, occurrence_at, add_to_meal_id }) =>
      meal(async () => {
        const f = new FormData();
        f.append('text', description);
        if (meal_type) f.append('meal_type', meal_type);
        if (occurrence_at) f.append('occurrence_at', occurrence_at);
        if (add_to_meal_id) f.append('append_to', add_to_meal_id);
        return finished(api, (await api('POST', '/intake', f)) as Meal);
      }),
  );
  registerAppTool(
    server,
    'answer_meal_questions',
    {
      title: 'Answer a meal’s questions',
      description:
        'Answer the clarifying questions on a meal (e.g. cooking oil, portion size). Keys are question ids, values one of the offered options; unanswered questions take their default.',
      inputSchema: z.object({
        meal_id: z.string(),
        answers: z.record(z.string(), z.string()).default({}),
      }),
      annotations: write,
      _meta: CARD_META,
    },
    async ({ meal_id, answers }) =>
      meal(() =>
        api('POST', `/intake/${encodeURIComponent(meal_id)}/answers`, {
          answers,
        }),
      ),
  );
  registerAppTool(
    server,
    'log_food',
    {
      title: 'Log a specific food',
      description:
        'Log an exact food from search_foods (food_id for the user’s own/cached foods, fdc_id for USDA, fatsecret_id for FatSecret) with an amount. Units: g, ml, oz, cup, tbsp, tsp, piece, slice, serving, or a portion unit the food lists.',
      inputSchema: z.object({
        food_id: z.string().optional(),
        fdc_id: z.string().optional(),
        fatsecret_id: z.string().optional(),
        amount: z.number().positive(),
        unit: z.string(),
        display_name: z.string().optional().describe('What to call it in the log'),
        meal_type: mealType.optional(),
        occurrence_at: z.string().optional(),
        add_to_meal_id: z.string().optional(),
      }),
      annotations: write,
      _meta: CARD_META,
    },
    async (a) =>
      meal(() => {
        if (!a.food_id && !a.fdc_id && !a.fatsecret_id) throw new Error('give food_id, fdc_id or fatsecret_id');
        const item = {
          ...(a.food_id ? { food_id: a.food_id } : a.fdc_id ? { fdc_id: a.fdc_id } : { fatsecret_id: a.fatsecret_id }),
          amount: a.amount,
          unit: a.unit,
          ...(a.display_name ? { display_name: a.display_name } : {}),
        };
        return api(
          'POST',
          '/intake',
          a.add_to_meal_id
            ? { append_to: a.add_to_meal_id, items: [item] }
            : {
                meal_type: a.meal_type,
                merge: true,
                ...(a.occurrence_at ? { occurrence_at: a.occurrence_at } : {}),
                items: [item],
              },
        );
      }),
  );
  server.registerTool(
    'search_foods',
    {
      title: 'Search foods',
      description:
        'Find foods to log. Returns up to `limit` compact rows, best first: the user\'s favorites (saved portions), foods they\'ve eaten (by meaning: "those chicken meatballs I like"), their own foods and recipes, then USDA and FatSecret. Each row has the id to log it with log_food, per-100 g kcal, protein, fat and carbs, and its serving size.',
      inputSchema: z.object({
        query: z.string().min(2),
        limit: z.number().int().min(1).max(25).default(10),
      }),
      annotations: read,
    },
    async ({ query, limit }) => run(() => searchFoods(api, query, limit)),
  );

  // ---- favorites: saved portions, one call to log ----
  server.registerTool(
    'list_favorites',
    {
      title: 'Favorites',
      description: 'The user\'s favorites: foods saved with the amount they eat ("usual nuts" = 1 oz almonds), with grams and kcal for that amount. Log one with log_favorite.',
      annotations: read,
    },
    async () => run(() => api('GET', '/foods/favorites')),
  );
  server.registerTool(
    'save_favorite',
    {
      title: 'Save a favorite portion',
      description:
        'Save a food with a fixed amount under a name ("usual nuts", 1 oz almonds), so it logs in one call with the same amount every time. Use any id from search_foods. Saving an existing name replaces it.',
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        food_id: z.string().optional(),
        fdc_id: z.string().optional(),
        fatsecret_id: z.string().optional(),
        amount: z.number().positive(),
        unit: z.string().describe('g, ml, oz, cup, tbsp, piece, serving, or a portion unit the food lists'),
      }),
      annotations: write,
    },
    async (a) =>
      run(async () => {
        let foodId = a.food_id;
        if (!foodId && a.fdc_id) foodId = ((await api('GET', `/foods/fdc/${encodeURIComponent(a.fdc_id)}`)) as Rec).id;
        if (!foodId && a.fatsecret_id) foodId = ((await api('GET', `/foods/fatsecret/${encodeURIComponent(a.fatsecret_id)}`)) as Rec).id;
        if (!foodId) throw new Error('give food_id, fdc_id or fatsecret_id');
        return api('POST', '/foods/favorites', {
          name: a.name,
          food_id: foodId,
          amount: a.amount,
          unit: a.unit,
        });
      }),
  );
  registerAppTool(
    server,
    'log_favorite',
    {
      title: 'Log a favorite',
      description: 'Log a saved favorite at its saved amount (by name, e.g. "usual nuts", or favorite_id). `times` logs a multiple of it (2 = two portions).',
      inputSchema: z.object({
        name: z.string().optional(),
        favorite_id: z.string().optional(),
        times: z.number().positive().default(1),
        meal_type: mealType.optional(),
        occurrence_at: z.string().optional(),
        add_to_meal_id: z.string().optional(),
      }),
      annotations: write,
      _meta: CARD_META,
    },
    async (a) =>
      meal(async () => {
        const favs = (await api('GET', '/foods/favorites')) as Rec[];
        const want = a.name?.trim().toLowerCase();
        const fav =
          favs.find((f) => f.id === a.favorite_id) ??
          (want ? (favs.find((f) => f.name.toLowerCase() === want) ?? favs.find((f) => f.name.toLowerCase().includes(want))) : undefined);
        if (!fav) throw new Error(`no favorite ${a.name ? `named "${a.name}"` : a.favorite_id}; saved: ${favs.map((f) => f.name).join(', ') || 'none'}`);
        const item = {
          food_id: fav.food_id,
          amount: Math.round(fav.amount * a.times * 1000) / 1000,
          unit: fav.unit,
          display_name: fav.name,
        };
        return api(
          'POST',
          '/intake',
          a.add_to_meal_id
            ? { append_to: a.add_to_meal_id, items: [item] }
            : {
                meal_type: a.meal_type,
                merge: true,
                ...(a.occurrence_at ? { occurrence_at: a.occurrence_at } : {}),
                items: [item],
              },
        );
      }),
  );
  server.registerTool(
    'remove_favorite',
    {
      title: 'Remove a favorite',
      description: 'Delete a saved favorite (meals already logged keep it).',
      inputSchema: z.object({ favorite_id: z.string() }),
      annotations: destroy,
    },
    async ({ favorite_id }) => run(() => api('DELETE', `/foods/favorites/${encodeURIComponent(favorite_id)}`)),
  );
  server.registerTool(
    'edit_item',
    {
      title: 'Change an item',
      description: 'Change an item’s amount and/or swap its food (food_id, fdc_id or fatsecret_id). Nutrients are recomputed; a swap is remembered for next time.',
      inputSchema: z.object({
        item_id: z.string(),
        amount: z.number().positive().optional(),
        unit: z.string().optional(),
        food_id: z.string().optional(),
        fdc_id: z.string().optional(),
        fatsecret_id: z.string().optional(),
      }),
      annotations: write,
    },
    async ({ item_id, ...patch }) => run(() => api('PATCH', `/item/${encodeURIComponent(item_id)}`, patch)),
  );
  server.registerTool(
    'delete_item',
    {
      title: 'Remove an item',
      description: 'Remove one item from a meal.',
      inputSchema: z.object({ item_id: z.string() }),
      annotations: destroy,
    },
    async ({ item_id }) => run(() => api('DELETE', `/item/${encodeURIComponent(item_id)}`)),
  );
  server.registerTool(
    'delete_meal',
    {
      title: 'Delete a meal',
      description: 'Delete a whole meal (marked entered-in-error).',
      inputSchema: z.object({ meal_id: z.string() }),
      annotations: destroy,
    },
    async ({ meal_id }) => run(() => api('DELETE', `/intake/${encodeURIComponent(meal_id)}`)),
  );

  // ---- foods and recipes ----
  server.registerTool(
    'list_my_foods',
    {
      title: 'My foods',
      description: 'The user’s own custom foods (from labels or entered by hand), with times logged.',
      annotations: read,
    },
    async () => run(() => api('GET', '/foods/mine')),
  );
  server.registerTool(
    'create_food',
    {
      title: 'Create a custom food',
      description: `Save a food that isn't in any database, from its nutrition label. Values are for one serving of serving_grams g (or ml). ${NUTRIENTS_NOTE} ENERC_KCAL is required.`,
      inputSchema: z.object({
        name: z.string().min(1),
        brand: z.string().optional(),
        serving_label: z.string().optional().describe('e.g. "1 bar", "Grande (16 fl oz)"'),
        serving_grams: z.number().positive(),
        per_serving: z.record(z.string(), z.number().nonnegative()),
      }),
      annotations: write,
    },
    async (body) => run(() => api('POST', '/foods', body)),
  );
  server.registerTool(
    'list_recipes',
    {
      title: 'Recipes',
      description: 'The user’s recipes (batches cooked once and eaten in servings), with per-serving nutrients and ingredients.',
      annotations: read,
    },
    async () => run(() => api('GET', '/recipes')),
  );

  // ---- goals, weight, coaching ----
  server.registerTool(
    'get_targets',
    {
      title: 'Targets',
      description: 'Current daily targets (energy kcal, protein, fat, carbs, fiber g) and body profile.',
      annotations: read,
    },
    async () => run(() => api('GET', '/goals')),
  );
  server.registerTool(
    'set_targets',
    {
      title: 'Set targets',
      description: 'Set daily targets from today on. Pass only the ones to change; null removes one.',
      inputSchema: z.object({
        energy: z.number().positive().nullable().optional().describe('kcal'),
        protein: z.number().positive().nullable().optional().describe('g'),
        fat: z.number().positive().nullable().optional().describe('g'),
        carbs: z.number().positive().nullable().optional().describe('g'),
        fiber: z.number().positive().nullable().optional().describe('g'),
      }),
      annotations: write,
    },
    async (body) => run(() => api('PUT', '/goals', body)),
  );
  server.registerTool(
    'get_weight',
    {
      title: 'Weight',
      description: 'Weigh-ins (kg) and the 7-day trend between two dates; defaults to the last 90 days.',
      inputSchema: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      annotations: read,
    },
    async ({ from, to }) => run(() => api('GET', `/weight?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`)),
  );
  server.registerTool(
    'log_weight',
    {
      title: 'Log weight',
      description: 'Record a weigh-in.',
      inputSchema: z.object({
        value: z.number().positive(),
        unit: z.enum(['kg', 'lb']),
        effective_at: z.string().optional().describe('ISO time; defaults to now'),
      }),
      annotations: write,
    },
    async (body) => run(() => api('POST', '/weight', body)),
  );
  registerAppTool(
    server,
    'get_coach_report',
    {
      title: 'Coach report',
      description:
        'The daily insights and coaching report: headline, observations for the day/week/month, wins, things to watch, coaching steps, logging quality, plus the numbers it was based on. Latest by default, or for a date. Also lists earlier reports.',
      inputSchema: z.object({
        date: z.string().optional().describe('YYYY-MM-DD'),
      }),
      annotations: read,
      _meta: CARD_META,
    },
    async ({ date }) => coach(() => api('GET', date ? `/coach/${date}` : '/coach')),
  );
  registerAppTool(
    server,
    'run_coach',
    {
      title: 'Update coach report',
      description: 'Write a fresh coach report for today so far (takes ~10 s).',
      annotations: write,
      _meta: CARD_META,
    },
    async () => coach(() => api('POST', '/coach/run')),
  );

  return server;
}

/** The /mcp endpoint: OAuthProvider has verified the token; props carry the user it was granted for. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const userId = (ctx.props as McpProps | undefined)?.userId;
    const user = userId ? await env.DB.prepare('SELECT id, access_sub, email, timezone FROM users WHERE id = ?').bind(userId).first<User>() : null;
    if (!user) return new Response('unknown user', { status: 401 });
    const api = apiFor(env, ctx, user);
    return createMcpHandler(() => buildServer(api, new URL(request.url).origin), { route: '/mcp' })(request, env, ctx);
  },
};
