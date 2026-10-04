import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { metaVerifyChallenge, parseMetaWebhook, validMetaSignature } from './meta';

describe('meta webhook helpers', () => {
  it('echoes the challenge only for the right verify token', () => {
    const url = new URL(
      'https://x.test/webhooks/meta?hub.mode=subscribe&hub.verify_token=secret-token-123&hub.challenge=42',
    );
    expect(metaVerifyChallenge(url, 'secret-token-123')).toEqual({ ok: true, challenge: '42' });
    expect(metaVerifyChallenge(url, 'other')).toEqual({ ok: false });
  });

  it('validates the sha256 signature over the raw body', () => {
    const body = '{"object":"whatsapp_business_account"}';
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    expect(validMetaSignature('app-secret', body, sig)).toBe(true);
    expect(validMetaSignature('app-secret', body + ' ', sig)).toBe(false);
    expect(validMetaSignature('wrong', body, sig)).toBe(false);
    expect(validMetaSignature('app-secret', body, null)).toBe(false);
  });

  it('parses text and image messages and ignores status receipts', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1234567890' },
                contacts: [{ profile: { name: 'Dave' }, wa_id: '447718050880' }],
                messages: [
                  { from: '447718050880', id: 'wamid.1', type: 'text', text: { body: ' YES ' } },
                  {
                    from: '447718050880',
                    id: 'wamid.2',
                    type: 'image',
                    image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'page 1' },
                  },
                  { from: '447718050880', id: 'wamid.3', type: 'sticker' },
                ],
              },
            },
            { field: 'messages', value: { statuses: [{ id: 'wamid.0', status: 'delivered' }] } },
          ],
        },
      ],
    };
    const { phoneNumberId, messages } = parseMetaWebhook(payload);
    expect(phoneNumberId).toBe('1234567890');
    expect(messages).toEqual([
      {
        provider: 'meta',
        messageId: 'wamid.1',
        from: '+447718050880',
        body: 'YES',
        media: [],
        profileName: 'Dave',
        accountSid: null,
      },
      {
        provider: 'meta',
        messageId: 'wamid.2',
        from: '+447718050880',
        body: 'page 1',
        media: [{ ref: 'MEDIA1', contentType: 'image/jpeg' }],
        profileName: 'Dave',
        accountSid: null,
      },
    ]);
    expect(parseMetaWebhook({ object: 'page' }).messages).toEqual([]);
  });
});
