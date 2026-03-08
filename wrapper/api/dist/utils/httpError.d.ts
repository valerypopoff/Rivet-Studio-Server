export type HttpError = Error & {
    status: number;
};
export declare function createHttpError(status: number, message: string): HttpError;
export declare function badRequest(message: string): HttpError;
export declare function conflict(message: string): HttpError;
