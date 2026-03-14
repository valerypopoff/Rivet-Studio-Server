import { Router } from 'express';
import { getExpectedUiSessionToken, isTrustedProxyRequest, isValidSharedKey } from '../auth.js';
import { createHttpError } from '../utils/httpError.js';
export const uiAuthRouter = Router();
function isFormPost(contentType) {
    return (contentType ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded');
}
function setNoStoreHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
}
uiAuthRouter.post('/ui-auth', (req, res, next) => {
    const formPost = isFormPost(req.get('content-type'));
    setNoStoreHeaders(res);
    if (!isTrustedProxyRequest(req)) {
        if (formPost) {
            res.redirect(303, '/?auth_error=forbidden');
            return;
        }
        next(createHttpError(403, 'Forbidden'));
        return;
    }
    const configuredKey = process.env.RIVET_KEY?.trim();
    if (!configuredKey) {
        if (formPost) {
            res.redirect(303, '/?auth_error=unavailable');
            return;
        }
        next(createHttpError(500, 'UI access key is not configured'));
        return;
    }
    const providedKey = typeof req.body?.key === 'string'
        ? req.body.key
        : typeof req.body?.token === 'string'
            ? req.body.token
            : '';
    if (!isValidSharedKey(providedKey)) {
        if (formPost) {
            res.redirect(303, '/?auth_error=invalid');
            return;
        }
        next(createHttpError(401, 'Invalid access key'));
        return;
    }
    const forwardedProto = req.get('x-forwarded-proto');
    const protocol = forwardedProto?.split(',')[0]?.trim().toLowerCase() || req.protocol || 'http';
    const secureSuffix = protocol === 'https' ? '; Secure' : '';
    const sessionToken = getExpectedUiSessionToken();
    res.setHeader('Set-Cookie', `rivet_ui_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax${secureSuffix}`);
    if (formPost) {
        res.redirect(303, '/');
        return;
    }
    res.status(204).end();
});
