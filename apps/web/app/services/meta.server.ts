import type { InboundMedia, MessagingProvider } from '../lib/messaging';

/**
 * Meta WhatsApp Cloud API: send a text, resolve and download a media id. Bearer token on every
 * call. The test number Meta gives every app works exactly like a real one for messages from
 * numbers on its allow-list, which is all a pilot at one company needs.
 */
export type MetaFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface MetaClientOptions {
  accessToken: string;
  phoneNumberId: string;
  graphVersion?: string;
  fetchImpl?: MetaFetch;
}

export class MetaClient implements MessagingProvider {
  readonly name = 'meta' as const;
  private readonly fetchImpl: MetaFetch;
  private readonly base: string;

  constructor(private readonly opts: MetaClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.base = `https://graph.facebook.com/${opts.graphVersion ?? 'v22.0'}`;
  }

  get phoneNumberId(): string {
    return this.opts.phoneNumberId;
  }

  async sendText(toE164: string, body: string): Promise<string> {
    const res = await this.fetchImpl(
      `${this.base}/${encodeURIComponent(this.opts.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toE164.replace(/^\+/, ''),
          type: 'text',
          text: { preview_url: false, body },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as {
        error?: { code?: number; message?: string };
      } | null;
      throw new Error(
        `meta send failed (${res.status}${detail?.error?.code ? `, code ${detail.error.code}` : ''}${detail?.error?.message ? `: ${detail.error.message.slice(0, 160)}` : ''})`,
      );
    }
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    return json.messages?.[0]?.id ?? '';
  }

  async fetchMedia(media: InboundMedia): Promise<{ bytes: Uint8Array; contentType: string }> {
    const meta = await this.fetchImpl(`${this.base}/${encodeURIComponent(media.ref)}`, {
      headers: { authorization: `Bearer ${this.opts.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!meta.ok) throw new Error(`meta media lookup failed (${meta.status})`);
    const info = (await meta.json()) as { url?: string; mime_type?: string };
    if (!info.url) throw new Error('meta media lookup returned no url');
    const file = await this.fetchImpl(info.url, {
      headers: { authorization: `Bearer ${this.opts.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!file.ok) throw new Error(`meta media download failed (${file.status})`);
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: info.mime_type ?? file.headers.get('content-type') ?? media.contentType,
    };
  }
}
