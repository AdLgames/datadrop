import { describe, expect, it } from 'vitest';
import { MetaClient } from './meta.server';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('MetaClient', () => {
  it('sends a text through the Graph API with the bearer token', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new MetaClient({
      accessToken: 'tok',
      phoneNumberId: '123',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return json({ messages: [{ id: 'wamid.out' }] });
      },
    });
    expect(await client.sendText('+447718050880', 'hello')).toBe('wamid.out');
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v22.0/123/messages');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0]?.init?.body as string)).toMatchObject({
      to: '447718050880',
      type: 'text',
      text: { body: 'hello' },
    });
  });

  it('resolves a media id to a URL and downloads it', async () => {
    const client = new MetaClient({
      accessToken: 'tok',
      phoneNumberId: '123',
      fetchImpl: async (url) => {
        if (url.endsWith('/MEDIA1'))
          return json({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' });
        if (url === 'https://lookaside.fbsbx.com/x')
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        return new Response('nope', { status: 404 });
      },
    });
    const out = await client.fetchMedia({ ref: 'MEDIA1', contentType: 'image/jpeg' });
    expect(out.contentType).toBe('image/jpeg');
    expect([...out.bytes]).toEqual([1, 2, 3]);
  });

  it('surfaces Meta error codes', async () => {
    const client = new MetaClient({
      accessToken: 'tok',
      phoneNumberId: '123',
      fetchImpl: async () =>
        json(
          { error: { code: 131030, message: 'Recipient phone number not in allowed list' } },
          400,
        ),
    });
    await expect(client.sendText('+1', 'x')).rejects.toThrow(/131030.*not in allowed list/);
  });
});
