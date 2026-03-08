import type { Request, Response, NextFunction, RequestHandler } from 'express';
export declare function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler;
