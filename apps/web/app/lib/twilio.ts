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
