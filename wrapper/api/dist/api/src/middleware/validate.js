import { badRequest } from '../utils/httpError.js';
export function validateBody(schema) {
    return (req, _res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            next(badRequest(result.error.issues[0]?.message ?? 'Invalid request body'));
            return;
        }
        req.body = result.data;
        next();
    };
}
