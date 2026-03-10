import type { RequestHandler } from 'express';
import { type ZodType } from 'zod';
export declare function validateBody<T>(schema: ZodType<T>): RequestHandler;
