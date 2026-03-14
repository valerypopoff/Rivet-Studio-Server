import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

const PROXY_AUTH_HEADER = 'x-rivet-proxy-auth';
const TOKEN_FREE_HOST_HEADER = 'x-rivet-token-free-host';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function getSharedKey(): string {
  return process.env.RIVET_KEY?.trim() ?? '';
}

export function getExpectedProxyAuthToken(): string {
  const sharedKey = getSharedKey();
  return sharedKey ? sha256Hex(`${sharedKey}:proxy-auth`) : '';
}

export function getExpectedUiSessionToken(): string {
  const sharedKey = getSharedKey();
  return sharedKey ? sha256Hex(`${sharedKey}:ui-session`) : '';
}

export function isValidSharedKey(candidate: string | undefined | null): boolean {
  const sharedKey = getSharedKey();
  if (!sharedKey) {
    return false;
  }

  return timingSafeStringEqual((candidate ?? '').trim(), sharedKey);
}

export function isTrustedProxyRequest(request: Request | IncomingMessage): boolean {
  const expectedToken = getExpectedProxyAuthToken();
  if (!expectedToken) {
    return false;
  }

  const headerValue = request.headers[PROXY_AUTH_HEADER];
  const providedToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof providedToken === 'string' && timingSafeStringEqual(providedToken.trim(), expectedToken);
}

export function isTrustedTokenFreeHostRequest(request: Request | IncomingMessage): boolean {
  if (!isTrustedProxyRequest(request)) {
    return false;
  }

  const headerValue = request.headers[TOKEN_FREE_HOST_HEADER];
  const tokenFreeHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof tokenFreeHeader === 'string' && tokenFreeHeader.trim() === '1';
}
