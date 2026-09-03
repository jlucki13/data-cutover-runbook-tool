export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);
export const forbidden = (msg = "forbidden") => new HttpError(403, msg);
export const unauthorized = (msg = "unauthorized") => new HttpError(401, msg);
