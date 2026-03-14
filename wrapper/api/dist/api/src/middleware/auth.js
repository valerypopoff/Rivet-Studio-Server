import { createHttpError } from '../utils/httpError.js';
import { isTrustedProxyRequest } from '../auth.js';
export const requireAuth = (req, _res, next) => {
    if (!isTrustedProxyRequest(req)) {
        next(createHttpError(403, 'Forbidden'));
        return;
    }
    next();
};
