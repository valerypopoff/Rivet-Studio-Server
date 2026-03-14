import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
export declare function getExpectedProxyAuthToken(): string;
export declare function getExpectedUiSessionToken(): string;
export declare function isValidSharedKey(candidate: string | undefined | null): boolean;
export declare function isTrustedProxyRequest(request: Request | IncomingMessage): boolean;
export declare function isTrustedTokenFreeHostRequest(request: Request | IncomingMessage): boolean;
