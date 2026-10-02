import { waitUntil } from '@vercel/functions';
import type { Route } from './+types/webhooks.twilio';
import { parseInbound, twiml, validTwilioSignature } from '../lib/twilio';
import { getApp } from '../services/app.server';
import { receive } from '../services/intake.server';

/**
 * POST /webhooks/twilio: one inbound WhatsApp message. Signature-checked against the public URL
 * (APP_URL + path), answered within Twilio's timeout, with the slow part (media, extraction, the
 * quiet period, the reply) kept alive after the response by `waitUntil`.
 */
const xml = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' },
  });

export const action = async ({ request }: Route.ActionArgs) => {
  const app = getApp();
  if (!app.env.TWILIO_AUTH_TOKEN) return new Response('twilio not configured', { status: 503 });
  const raw = await request.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
  const publicUrl = `${app.appUrl ?? new URL(request.url).origin}/webhooks/twilio`;
  if (
    !validTwilioSignature(
      app.env.TWILIO_AUTH_TOKEN,
      publicUrl,
      params,
      request.headers.get('x-twilio-signature'),
    )
  ) {
    app.logger.warn('twilio.bad_signature');
    return new Response('forbidden', { status: 403 });
  }
  const msg = parseInbound(params);
  if (!msg) return new Response('bad request', { status: 400 });

  const outcome = await receive(msg, { app });
  switch (outcome.kind) {
    case 'duplicate':
      return xml(twiml());
    case 'unregistered':
    case 'not_configured':
      return xml(twiml(outcome.reply));
    case 'queued': {
      const work = outcome
        .work()
        .catch((err: unknown) => app.logger.error('intake.background_failed', { error: err }));
      try {
        waitUntil(work);
      } catch {
        // not on Vercel: the promise simply runs
      }
      return xml(twiml());
    }
    default: {
      const never: never = outcome;
      return never;
    }
  }
};

export const loader = () => new Response('method not allowed', { status: 405 });
