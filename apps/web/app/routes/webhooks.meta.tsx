import { waitUntil } from '@vercel/functions';
import type { Route } from './+types/webhooks.meta';
import { metaVerifyChallenge, parseMetaWebhook, validMetaSignature } from '../lib/meta';
import { getApp } from '../services/app.server';
import { receive } from '../services/intake.server';

/**
 * Meta WhatsApp Cloud API webhook. GET is Meta's one-off verification handshake (echo the
 * challenge when the verify token matches); POST carries message deliveries, signed with the app
 * secret. Meta expects a fast 200 and retries otherwise, so the slow part runs under `waitUntil`.
 */
export const config = { maxDuration: 120 };

export const loader = ({ request }: Route.LoaderArgs) => {
  const app = getApp();
  if (!app.env.META_VERIFY_TOKEN) return new Response('meta not configured', { status: 503 });
  const result = metaVerifyChallenge(new URL(request.url), app.env.META_VERIFY_TOKEN);
  if (!result.ok) return new Response('forbidden', { status: 403 });
  app.logger.info('meta.webhook_verified');
  return new Response(result.challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
};

export const action = async ({ request }: Route.ActionArgs) => {
  const app = getApp();
  if (!app.env.META_APP_SECRET || !app.meta)
    return new Response('meta not configured', { status: 503 });
  const raw = await request.text();
  if (
    !validMetaSignature(app.env.META_APP_SECRET, raw, request.headers.get('x-hub-signature-256'))
  ) {
    app.logger.warn('meta.bad_signature');
    return new Response('forbidden', { status: 403 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const { messages } = parseMetaWebhook(payload);
  const meta = app.meta;
  for (const msg of messages) {
    const outcome = await receive(msg, { app });
    switch (outcome.kind) {
      case 'duplicate':
        break;
      case 'unregistered':
      case 'not_configured': {
        // No TwiML here: the refusal goes back through the API, off the request path.
        const reply = meta
          .sendText(msg.from, outcome.reply)
          .catch((err: unknown) => app.logger.warn('meta.reply_failed', { error: err }));
        try {
          waitUntil(reply);
        } catch {
          // not on Vercel
        }
        break;
      }
      case 'queued': {
        const work = outcome
          .work()
          .catch((err: unknown) => app.logger.error('intake.background_failed', { error: err }));
        try {
          waitUntil(work);
        } catch {
          // not on Vercel
        }
        break;
      }
      default: {
        const never: never = outcome;
        return never;
      }
    }
  }
  return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } });
};
