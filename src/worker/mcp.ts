/**
 * Clem as an MCP server, for Claude and other MCP clients.
 *
 * Every tool calls the app's own /api routes as the signed-in user, so validation, matching,
 * nutrient maths and history updates are exactly what the app does. The user comes from the
 * OAuth grant (props.userId, set on the consent page); it reaches the API through env.MCP_USER,
 * which only this handler can set (env isn't reachable from a request).
 */
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { app } from './app';
import type { Env, User } from './env';

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

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true });
const run = async (f: () => Promise<unknown>) => {
  try {
    return ok(await f());
  } catch (e) {
    return fail(e);
  }
};

const date = z.string().regex(/^(\d{4}-\d{2}-\d{2}|today)$/).describe('YYYY-MM-DD, or "today"');
const mealType = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
const read = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destroy = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const NUTRIENTS_NOTE =
  'Nutrients use INFOODS codes: ENERC_KCAL kcal, PROCNT protein g, CHOCDF carbs g, FAT fat g, FIBTG fiber g, SUGAR sugars g, NA sodium mg.';

export function buildServer(api: Api): McpServer {
  const server = new McpServer({ name: 'clem', version: '1.0.0' }, { instructions: `Clem is the user's food and nutrition log. ${NUTRIENTS_NOTE} Dates are the user's log dates (their day ends at their day cutoff, 04:00 by default).` });

  // ---- reading the log ----
  server.registerTool(
    'get_day',
    {
      title: 'Get a day',
      description: `Meals, items and totals for one log date, with targets and what's left. ${NUTRIENTS_NOTE}`,
      inputSchema: z.object({ date: date.default('today') }),
      annotations: read,
    },
    async ({ date }) => run(() => api('GET', `/day/${date}`)),
  );
  server.registerTool(
    'get_range',
    {
      title: 'Daily totals for a range',
      description: 'Per-day totals and meal counts between two dates (inclusive, up to a year), plus current targets. Defaults to the last 7 days.',
      inputSchema: z.object({ from: z.string().optional().describe('YYYY-MM-DD'), to: z.string().optional().describe('YYYY-MM-DD') }),
      annotations: read,
    },
    async ({ from, to }) => run(() => api('GET', `/range?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`)),
  );
  server.registerTool(
    'get_meal',
    { title: 'Get a meal', description: 'One meal with its items, nutrients and any open questions.', inputSchema: z.object({ meal_id: z.string() }), annotations: read },
    async ({ meal_id }) => run(() => api('GET', `/intake/${encodeURIComponent(meal_id)}`)),
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

  // ---- logging ----
  server.registerTool(
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
    },
    async ({ description, meal_type, occurrence_at, add_to_meal_id }) =>
      run(async () => {
        const f = new FormData();
        f.append('text', description);
        if (meal_type) f.append('meal_type', meal_type);
        if (occurrence_at) f.append('occurrence_at', occurrence_at);
        if (add_to_meal_id) f.append('append_to', add_to_meal_id);
        return finished(api, (await api('POST', '/intake', f)) as Meal);
      }),
  );
  server.registerTool(
    'answer_meal_questions',
    {
      title: 'Answer a meal’s questions',
      description: 'Answer the clarifying questions on a meal (e.g. cooking oil, portion size). Keys are question ids, values one of the offered options; unanswered questions take their default.',
      inputSchema: z.object({ meal_id: z.string(), answers: z.record(z.string(), z.string()).default({}) }),
      annotations: write,
    },
    async ({ meal_id, answers }) => run(() => api('POST', `/intake/${encodeURIComponent(meal_id)}/answers`, { answers })),
  );
  server.registerTool(
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
    },
    async (a) =>
      run(() => {
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
            : { meal_type: a.meal_type, merge: true, ...(a.occurrence_at ? { occurrence_at: a.occurrence_at } : {}), items: [item] },
        );
      }),
  );
  server.registerTool(
    'search_foods',
    {
      title: 'Search foods',
      description:
        'Search the user’s history (foods they’ve eaten, by meaning: "those chicken meatballs I like"), their own foods and recipes, USDA and FatSecret. Nutrients are per 100 g. Use the ids with log_food or edit_item.',
      inputSchema: z.object({ query: z.string().min(2) }),
      annotations: read,
    },
    async ({ query }) => run(() => api('GET', `/foods?q=${encodeURIComponent(query)}`)),
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
    { title: 'Remove an item', description: 'Remove one item from a meal.', inputSchema: z.object({ item_id: z.string() }), annotations: destroy },
    async ({ item_id }) => run(() => api('DELETE', `/item/${encodeURIComponent(item_id)}`)),
  );
  server.registerTool(
    'delete_meal',
    { title: 'Delete a meal', description: 'Delete a whole meal (marked entered-in-error).', inputSchema: z.object({ meal_id: z.string() }), annotations: destroy },
    async ({ meal_id }) => run(() => api('DELETE', `/intake/${encodeURIComponent(meal_id)}`)),
  );

  // ---- foods and recipes ----
  server.registerTool(
    'list_my_foods',
    { title: 'My foods', description: 'The user’s own custom foods (from labels or entered by hand), with times logged.', annotations: read },
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
    { title: 'Recipes', description: 'The user’s recipes (batches cooked once and eaten in servings), with per-serving nutrients and ingredients.', annotations: read },
    async () => run(() => api('GET', '/recipes')),
  );

  // ---- goals, weight, coaching ----
  server.registerTool(
    'get_targets',
    { title: 'Targets', description: 'Current daily targets (energy kcal, protein, fat, carbs, fiber g) and body profile.', annotations: read },
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
      inputSchema: z.object({ from: z.string().optional(), to: z.string().optional() }),
      annotations: read,
    },
    async ({ from, to }) => run(() => api('GET', `/weight?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`)),
  );
  server.registerTool(
    'log_weight',
    {
      title: 'Log weight',
      description: 'Record a weigh-in.',
      inputSchema: z.object({ value: z.number().positive(), unit: z.enum(['kg', 'lb']), effective_at: z.string().optional().describe('ISO time; defaults to now') }),
      annotations: write,
    },
    async (body) => run(() => api('POST', '/weight', body)),
  );
  server.registerTool(
    'get_coach_report',
    {
      title: 'Coach report',
      description:
        'The daily insights and coaching report: headline, observations for the day/week/month, wins, things to watch, coaching steps, logging quality, plus the numbers it was based on. Latest by default, or for a date. Also lists earlier reports.',
      inputSchema: z.object({ date: z.string().optional().describe('YYYY-MM-DD') }),
      annotations: read,
    },
    async ({ date }) => run(() => api('GET', date ? `/coach/${date}` : '/coach')),
  );
  server.registerTool(
    'run_coach',
    { title: 'Update coach report', description: 'Write a fresh coach report for today so far (takes ~10 s).', annotations: write },
    async () => run(() => api('POST', '/coach/run')),
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
    return createMcpHandler(() => buildServer(api), { route: '/mcp' })(request, env, ctx);
  },
};
