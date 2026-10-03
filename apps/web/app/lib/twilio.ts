import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio webhook helpers, pure and unit-tested. The request signature is HMAC-SHA1 over the
 * exact public URL Twilio posted to plus every POST parameter (sorted by name, name then value
 * concatenated), base64, in the `X-Twilio-Signature` header. The URL must be the one Twilio sees
 * (APP_URL + path), not the one the function sees behind the proxy.
 */
export const twilioSignature = (authToken: string, url: string, params: Record<string, string>) => {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
};

export const validTwilioSignature = (
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean => {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

/**
 * The URLs Twilio may have signed for this request: the canonical APP_URL form, the request's own
 * URL as the platform saw it (behind Vercel's proxy, via x-forwarded-*), and each with and
 * without a trailing slash and with the port stripped. Twilio signs exactly the string configured
 * in its console, so a mismatch in any of those details otherwise rejects every message.
 */
export const candidateWebhookUrls = (
  request: { url: string; headers: { get(name: string): string | null } },
  appUrl: string | null,
): string[] => {
  const u = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto') ?? u.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? u.host;
  const pathAndQuery = `${u.pathname}${u.search}`;
  const bases = new Set<string>();
  if (appUrl) bases.add(appUrl.replace(/\/+$/, ''));
  bases.add(`${proto}://${host}`);
  bases.add(`https://${host.replace(/:\d+$/, '')}`);
  const out = new Set<string>();
  for (const base of bases) {
    const plain = `${base}${pathAndQuery}`;
    out.add(plain);
    out.add(u.search ? plain.replace(u.search, `/${u.search}`) : `${plain}/`);
  }
  return [...out];
};

export const validTwilioSignatureForRequest = (
  authToken: string,
  request: { url: string; headers: { get(name: string): string | null } },
  appUrl: string | null,
  params: Record<string, string>,
  signature: string | null,
): boolean =>
  candidateWebhookUrls(request, appUrl).some((url) =>
    validTwilioSignature(authToken, url, params, signature),
  );

export interface InboundMessage {
  messageSid: string;
  /** E.164 without the whatsapp: prefix. */
  from: string;
  body: string;
  media: Array<{ url: string; contentType: string }>;
  profileName: string | null;
}

export const parseInbound = (params: Record<string, string>): InboundMessage | null => {
  const sid = params.MessageSid ?? params.SmsMessageSid;
  const from = params.From;
  if (!sid || !from) return null;
  const count = Number(params.NumMedia ?? '0');
  const media: InboundMessage['media'] = [];
  for (let i = 0; i < (Number.isFinite(count) ? count : 0); i += 1) {
    const url = params[`MediaUrl${i}`];
    const contentType = params[`MediaContentType${i}`] ?? 'application/octet-stream';
    if (url) media.push({ url, contentType });
  }
  return {
    messageSid: sid,
    from: from.replace(/^whatsapp:/, ''),
    body: (params.Body ?? '').trim(),
    media,
    profileName: params.ProfileName ?? null,
  };
};

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** TwiML reply, or the empty response when we answer later via the REST API. */
export const twiml = (message?: string): string =>
  message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

export const toWhatsApp = (e164: string): string =>
  e164.startsWith('whatsapp:') ? e164 : `whatsapp:${e164}`;
