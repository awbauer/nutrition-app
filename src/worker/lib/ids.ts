export const newId = (): string => crypto.randomUUID();
export const nowIso = (): string => new Date().toISOString();

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
