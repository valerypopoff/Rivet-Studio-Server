export function normalizeBasePath(value, fallback) {
    const trimmed = value?.trim();
    const candidate = trimmed && trimmed.length > 0 ? trimmed : fallback;
    const withLeadingSlash = candidate.startsWith('/') ? candidate : `/${candidate}`;
    const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
    return withoutTrailingSlash || fallback;
}
