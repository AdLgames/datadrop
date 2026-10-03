import { toWhatsApp } from '../lib/twilio';

/**
 * Twilio REST, the two calls we need: send a WhatsApp message and fetch inbound media (media
 * URLs need the account credentials and expire, so they are fetched immediately and stored in
 * our own bucket). No SDK: two endpoints, basic auth.
 */
export type TwilioFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TwilioClientOptions {
  accountSid: string;
  authToken: string;
  /** whatsapp:+1415... */
  from: string;
  fetchImpl?: TwilioFetch;
}

export class TwilioClient {
  private readonly fetchImpl: TwilioFetch;
  constructor(private readonly opts: TwilioClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private get auth(): string {
    return `Basic ${Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64')}`;
  }

  /** Returns the Twilio message SID. Throws on failure (callers log and carry on). */
  async sendWhatsApp(toE164: string, body: string): Promise<string> {
    const form = new URLSearchParams({ From: this.opts.from, To: toWhatsApp(toE164), Body: body });
    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: { authorization: this.auth, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as {
        code?: number;
        message?: string;
      } | null;
      throw new Error(
        `twilio send failed (${res.status}${detail?.code ? `, code ${detail.code}` : ''}${detail?.message ? `: ${detail.message.slice(0, 120)}` : ''})`,
      );
    }
    const json = (await res.json()) as { sid?: string };
    return json.sid ?? '';
  }

  /** Follows Twilio's redirect to the media store; returns bytes and the final content type. */
  async fetchMedia(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.fetchImpl(url, {
      headers: { authorization: this.auth },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
      throw new Error(
        `twilio media fetch failed (${res.status} from ${new URL(res.url || url).host})`,
      );
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
  }
}
