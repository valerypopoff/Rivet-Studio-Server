export function createHttpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}
export function badRequest(message) {
    return createHttpError(400, message);
}
export function conflict(message) {
    return createHttpError(409, message);
}
