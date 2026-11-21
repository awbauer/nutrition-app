export const newId = (): string => crypto.randomUUID();
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
