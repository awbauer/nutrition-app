import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { app } from '../src/worker/app';
import type { Env } from '../src/worker/env';

export const testEnv = env as unknown as Env;

export async function api(path: string, init: RequestInit & { json?: unknown } = {}, e: Partial<Env> = {}) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  // By default no queue is bound, so AI jobs run inline and the response reflects the finished meal;
  // no history index either (Vectorize has no local mode), and never the real FatSecret keys from
  // .dev.vars: tests that need them pass fakes.
  const res = await app.request(
    `http://app.test/api${path}`,
    { ...init, headers, body },
    { ...testEnv, JOBS: undefined, HISTORY: undefined, FATSECRET_CONSUMER_KEY: undefined, FATSECRET_CONSUMER_SECRET: undefined, ...e },
  );
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, res };
}

/** Route outbound fetches to USDA (and others) through a handler. */
export function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    // USDA searches are POSTed; expose the body as query params so handlers can match on them.
    if (url.hostname === 'api.nal.usda.gov' && typeof init?.body === 'string') {
      const b = JSON.parse(init.body) as { query?: string; dataType?: string[]; pageSize?: number };
      if (b.query != null) url.searchParams.set('query', b.query);
      if (b.dataType) url.searchParams.set('dataType', b.dataType.join(','));
      if (b.pageSize != null) url.searchParams.set('pageSize', String(b.pageSize));
    }
    const r = await handler(url, init);
    if (r) return r;
    return real(input, init);
  });
}

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
