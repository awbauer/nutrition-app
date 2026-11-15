/**
 * Offline queue (spec §10): meals logged without a connection are stored in IndexedDB
 * and replayed when the app is back online. iOS has no Background Sync, so we flush on
 * `online`, on start, and whenever the app becomes visible.
 */
import { openDB, type IDBPDatabase } from 'idb';
import { api, ApiError, type Intake } from './api';

type Body = { kind: 'json'; json: unknown } | { kind: 'form'; fields: [string, string | Blob, string?][] };

export interface QueuedMeal {
  id?: number;
  path: string;
  body: Body;
  created_at: string;
  attempts: number;
  error?: string; // set when the server rejected it (4xx); kept for the user to review
}

let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB('meal-queue', 1, { upgrade: (d) => d.createObjectStore('pending', { keyPath: 'id', autoIncrement: true }) }));

const listeners = new Set<() => void>();
export const onQueueChange = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
const notify = () => listeners.forEach((f) => f());

export async function pending(): Promise<QueuedMeal[]> {
  try {
    return await (await db()).getAll('pending');
  } catch {
    return [];
  }
}

export async function discard(id: number) {
  await (await db()).delete('pending', id);
  notify();
}

function toBody(body: unknown): Body {
  if (body instanceof FormData) {
    const fields: [string, string | Blob, string?][] = [];
    body.forEach((v, k) => fields.push(typeof v === 'string' ? [k, v] : [k, v, (v as File).name]));
    return { kind: 'form', fields };
  }
  return { kind: 'json', json: body };
}

function fromBody(b: Body): unknown {
  if (b.kind === 'json') return b.json;
  const f = new FormData();
  for (const [k, v, name] of b.fields) typeof v === 'string' ? f.append(k, v) : f.append(k, v, name);
  return f;
}

/** Worth retrying later: no connection, gateway/server hiccup, or an expired Access session. */
const isTransient = (e: unknown) => !(e instanceof ApiError) || e.status === 401 || e.status === 503 || e.status === 504;

/** Pin the meal time to now so a queued meal keeps the time it was eaten. */
function withTime(body: unknown): unknown {
  const now = new Date().toISOString();
  if (body instanceof FormData) {
    if (!body.has('occurrence_at')) body.append('occurrence_at', now);
    return body;
  }
  if (body && typeof body === 'object' && !('occurrence_at' in body)) return { ...body, occurrence_at: now };
  return body;
}

/**
 * POST a new meal; if offline (or the request fails at the network level), queue it.
 * Returns the created intake, or null when queued.
 */
export async function submitMeal(path: string, body: unknown): Promise<Intake | null> {
  const timed = withTime(body);
  if (navigator.onLine !== false) {
    try {
      return await api.post<Intake>(path, timed);
    } catch (e) {
      // AI failures (502) are not connectivity problems; surface those.
      if (e instanceof ApiError) throw e;
    }
  }
  await (await db()).add('pending', { path, body: toBody(timed), created_at: new Date().toISOString(), attempts: 0 } satisfies QueuedMeal);
  notify();
  return null;
}

let flushing = false;
/** Replay queued meals in order. Returns how many were sent. */
export async function flush(): Promise<number> {
  if (flushing || navigator.onLine === false) return 0;
  flushing = true;
  let sent = 0;
  try {
    const d = await db();
    for (const item of await d.getAll('pending')) {
      if (item.error) continue;
      try {
        await api.post(item.path, fromBody(item.body));
        await d.delete('pending', item.id);
        sent++;
      } catch (e) {
        if (isTransient(e)) break; // try again later
        await d.put('pending', { ...item, attempts: item.attempts + 1, error: (e as Error).message });
      }
    }
  } finally {
    flushing = false;
    if (sent) notify();
  }
  return sent;
}

export function startQueue() {
  const kick = () => void flush();
  addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && kick());
  kick();
}
