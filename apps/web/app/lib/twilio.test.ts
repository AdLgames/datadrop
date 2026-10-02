import { describe, expect, it } from 'vitest';
import { parseInbound, twiml, twilioSignature, validTwilioSignature } from './twilio';

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
});
