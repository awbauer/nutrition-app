import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { buildGraph } from '../lib/graph';

export const graph = new Hono<AppEnv>();

const WINDOWS = [30, 90, 365];

/** GET /api/graph?days=30|90|365 -> foods, meals, brands and recipes from the log, and how they connect. */
graph.get('/', async (c) => {
  const d = Number(c.req.query('days'));
  const days = WINDOWS.includes(d) ? d : 90;
  return c.json(await buildGraph(c.env.DB, c.get('user').id, days));
});
