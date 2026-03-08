export type HttpError = Error & { status: number };

export function createHttpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

export function badRequest(message: string): HttpError {
  return createHttpError(400, message);
}

export function conflict(message: string): HttpError {
  return createHttpError(409, message);
}
