/**
 * Response hardening: CSP with a per-response script nonce, HSTS in production, no framing.
 * Applied to every document response in entry.server.tsx and to resource routes that build their
 * own Response. Images on the review page are same-origin proxies of signed storage URLs, so the
 * policy needs no external image host; the Supabase origin is allowed for `connect-src` only
 * because the browser never talks to it directly today (kept for a future client-side upload).
 */
export const contentSecurityPolicy = (nonce: string): string =>
  [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${nonce}'`]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['style-src', ["'self'"]],
    ['connect-src', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ]
    .map(([d, s]) => `${d as string} ${(s as string[]).join(' ')}`)
    .join('; ');

export const applySecurityHeaders = (
  headers: Headers,
  nonce: string,
  opts: { hsts?: boolean } = {},
): Headers => {
  headers.set('Content-Security-Policy', contentSecurityPolicy(nonce));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('X-Frame-Options', 'DENY');
  if (opts.hsts ?? true) {
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  return headers;
};
