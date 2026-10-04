import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundMessage } from './messaging';

/**
 * Meta WhatsApp Cloud API webhook helpers, pure and unit-tested.
 *
 * Verification: Meta calls GET with hub.mode=subscribe, hub.verify_token and hub.challenge; we
 * echo the challenge when the token matches. Deliveries: POST with `X-Hub-Signature-256:
 * sha256=<HMAC-SHA256 of the raw body with the app secret>`. The payload nests messages under
 * entry[].changes[].value.messages[]; status receipts arrive on the same hook and are ignored.
 */
export const validMetaSignature = (
  appSecret: string,
  rawBody: string,
  header: string | null,
): boolean => {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const given = header.slice('sha256='.length);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

export const metaVerifyChallenge = (
  url: URL,
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false } => {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === verifyToken && challenge !== null) {
    return { ok: true, challenge };
  }
  return { ok: false };
};

interface MetaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
}
interface MetaMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMedia;
  document?: MetaMedia;
  video?: MetaMedia;
}
interface MetaValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaMessage[];
  statuses?: unknown[];
}

/** Every user message in a delivery, in order; receipts and unknown types yield nothing. */
export const parseMetaWebhook = (
  payload: unknown,
): { phoneNumberId: string | null; messages: InboundMessage[] } => {
  const out: InboundMessage[] = [];
  let phoneNumberId: string | null = null;
  const p = payload as {
    object?: string;
    entry?: Array<{ changes?: Array<{ field?: string; value?: MetaValue }> }>;
  } | null;
  if (!p || p.object !== 'whatsapp_business_account' || !Array.isArray(p.entry)) {
    return { phoneNumberId, messages: out };
  }
  for (const entry of p.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages' || !change.value) continue;
      const v = change.value;
      phoneNumberId = v.metadata?.phone_number_id ?? phoneNumberId;
      const names = new Map(
        (v.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name ?? null]),
      );
      for (const m of v.messages ?? []) {
        if (!m.from || !m.id) continue;
        const media = m.image ?? m.document ?? m.video ?? null;
        const mediaList = media?.id
          ? [{ ref: media.id, contentType: media.mime_type ?? 'application/octet-stream' }]
          : [];
        const body = (m.type === 'text' ? m.text?.body : media?.caption) ?? '';
        if (mediaList.length === 0 && m.type !== 'text') continue; // reactions, stickers, locations…
        out.push({
          provider: 'meta',
          messageId: m.id,
          from: `+${m.from.replace(/^\+/, '')}`,
          body: body.trim(),
          media: mediaList,
          profileName: names.get(m.from) ?? null,
          accountSid: null,
        });
      }
    }
  }
  return { phoneNumberId, messages: out };
};
