/**
 * One inbound-message shape and one provider interface for every WhatsApp route into the app.
 * Twilio (sandbox or a registered sender) and Meta's Cloud API (a test number or a verified
 * business number) both produce `InboundMessage`; the intake pipeline never knows which. A reply
 * always goes back through the provider the message arrived on.
 */
export type MessagingProviderName = 'twilio' | 'meta';

export interface InboundMedia {
  /** Twilio: the media URL. Meta: the media id, resolved to a URL at fetch time. */
  ref: string;
  contentType: string;
}

export interface InboundMessage {
  provider: MessagingProviderName;
  /** Provider's unique message id; the dedupe key. */
  messageId: string;
  /** E.164 with a leading +. */
  from: string;
  body: string;
  media: InboundMedia[];
  profileName: string | null;
  /** Twilio only: the account that posted the webhook, authoritative for media and replies. Null elsewhere. */
  accountSid: string | null;
}

export interface MessagingProvider {
  readonly name: MessagingProviderName;
  /** Sends a free-text WhatsApp message; returns the provider's message id. */
  sendText(toE164: string, body: string, ctx?: { accountSid?: string | null }): Promise<string>;
  fetchMedia(
    media: InboundMedia,
    ctx?: { accountSid?: string | null },
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
}
