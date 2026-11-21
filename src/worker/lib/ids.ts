export const newId = (): string => crypto.randomUUID();
/** How long a call to an outside food database may take before it's given up on (a hung one held up the meal). */
export const FETCH_TIMEOUT_MS = 8000;

export const nowIso = (): string => new Date().toISOString();

/** D1 allows at most 100 bound parameters per query: split `IN (...)` lists into chunks that leave room for others. */
export function chunks<T>(xs: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
