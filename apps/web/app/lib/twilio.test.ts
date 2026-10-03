import { describe, expect, it } from 'vitest';
import {
  candidateWebhookUrls,
  parseInbound,
  twiml,
  twilioSignature,
  validTwilioSignature,
  validTwilioSignatureForRequest,
} from './twilio';

describe('twilio helpers', () => {
  it('computes the documented signature (Twilio security docs example)', () => {
    // From https://www.twilio.com/docs/usage/webhooks/webhooks-security
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675310',
      Digits: '1234',
      From: '+14158675310',
      To: '+18005551212',
    };
    const sig = twilioSignature('12345', url, params);
    expect(sig).toBe('GvWf1cFY/Q7PnoempGyD5oXAezc=');
    expect(validTwilioSignature('12345', url, params, sig)).toBe(true);
    expect(validTwilioSignature('12345', url, params, 'nope')).toBe(false);
    expect(validTwilioSignature('12345', url, params, null)).toBe(false);
  });

  it('parses an inbound WhatsApp message with media', () => {
    const msg = parseInbound({
      MessageSid: 'SM1',
      AccountSid: 'ACf04282e3100000000000000000000000',
      From: 'whatsapp:+447700900123',
      Body: ' hi ',
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/m/0',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/m/1',
      MediaContentType1: 'image/png',
      ProfileName: 'Dave',
    });
    expect(msg).toEqual({
      messageSid: 'SM1',
      accountSid: 'ACf04282e3100000000000000000000000',
      from: '+447700900123',
      body: 'hi',
      media: [
        { url: 'https://api.twilio.com/m/0', contentType: 'image/jpeg' },
        { url: 'https://api.twilio.com/m/1', contentType: 'image/png' },
      ],
      profileName: 'Dave',
    });
    expect(parseInbound({ Body: 'x' })).toBeNull();
  });

  it('escapes TwiML', () => {
    expect(twiml('a < b & "c"')).toContain('<Message>a &lt; b &amp; &quot;c&quot;</Message>');
    expect(twiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('accepts a signature made over the public URL with or without a trailing slash, behind a proxy', () => {
    const params = { MessageSid: 'SM1', From: 'whatsapp:+447718050880', Body: 'hi' };
    const req = (url: string, headers: Record<string, string> = {}) => ({
      url,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    });
    const internal = req('http://127.0.0.1:3000/webhooks/twilio', {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'freightx-chi.vercel.app',
    });
    const tried = candidateWebhookUrls(internal, 'https://freightx-chi.vercel.app/');
    expect(tried).toContain('https://freightx-chi.vercel.app/webhooks/twilio');
    expect(tried).toContain('https://freightx-chi.vercel.app/webhooks/twilio/');
    for (const signedUrl of [
      'https://freightx-chi.vercel.app/webhooks/twilio',
      'https://freightx-chi.vercel.app/webhooks/twilio/',
    ]) {
      const sig = twilioSignature('tok', signedUrl, params);
      expect(
        validTwilioSignatureForRequest(
          'tok',
          internal,
          'https://freightx-chi.vercel.app',
          params,
          sig,
        ),
      ).toBe(true);
    }
    const other = twilioSignature('tok', 'https://evil.example/webhooks/twilio', params);
    expect(
      validTwilioSignatureForRequest(
        'tok',
        internal,
        'https://freightx-chi.vercel.app',
        params,
        other,
      ),
    ).toBe(false);
    const good = twilioSignature('tok', 'https://freightx-chi.vercel.app/webhooks/twilio', params);
    expect(
      validTwilioSignatureForRequest(
        'wrong',
        internal,
        'https://freightx-chi.vercel.app',
        params,
        good,
      ),
    ).toBe(false);
  });
});
