import Anthropic from '@anthropic-ai/sdk';
import { createEmailTransport, type EmailTransport } from './email.server';
import { loadEnv, type Env } from './env.server';
import { createLogger, type Logger } from './logger.server';
import { isConfigured } from './supabase.server';
import type { MessagingProvider, MessagingProviderName } from '../lib/messaging';
import { MetaClient } from './meta.server';
import { TwilioClient } from './twilio.server';

/**
 * Process-wide services, built once per server process. Routes read them through `getApp()`.
 * Anything missing is reported here at startup and surfaces as a clear 503 at the route that
 * needs it, never as a stack trace.
 */
export interface AppServices {
  env: Env;
  logger: Logger;
  startedAt: Date;
  email: EmailTransport | null;
  emailProblem: string | null;
  twilio: TwilioClient | null;
  meta: MetaClient | null;
  /** The configured WhatsApp providers; replies use the one a message arrived on. */
  messaging: Messaging;
  anthropic: Anthropic | null;
  databaseConfigured: boolean;
  /** Public origin for links in emails and messages, and for Twilio signature checks. */
  appUrl: string | null;
}

export interface Messaging {
  /** Decision notifications and anything not tied to an inbound message: Meta when configured, else Twilio. */
  readonly default: MessagingProvider | null;
  for(name: MessagingProviderName): MessagingProvider | null;
}

export const createAppServices = (overrides: { env?: Env; logger?: Logger } = {}): AppServices => {
  const env = overrides.env ?? loadEnv();
  const logger = overrides.logger ?? createLogger({ level: env.logLevel, base: { app: 'web' } });
  const email = createEmailTransport(env, logger);
  const twilio =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM
      ? new TwilioClient({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          from: env.TWILIO_WHATSAPP_FROM,
        })
      : null;
  const meta =
    env.META_ACCESS_TOKEN && env.META_PHONE_NUMBER_ID
      ? new MetaClient({
          accessToken: env.META_ACCESS_TOKEN,
          phoneNumberId: env.META_PHONE_NUMBER_ID,
          graphVersion: env.META_GRAPH_VERSION,
        })
      : null;
  const messaging: Messaging = {
    default: meta ?? twilio,
    for: (name) => (name === 'meta' ? meta : twilio),
  };
  const anthropic = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
  const services: AppServices = {
    env,
    logger,
    startedAt: new Date(),
    email: email.transport,
    emailProblem: email.problem,
    twilio,
    meta,
    messaging,
    anthropic,
    databaseConfigured: isConfigured(env),
    appUrl: env.APP_URL ?? null,
  };
  logger.info('app.started', {
    nodeEnv: env.NODE_ENV,
    database: services.databaseConfigured,
    twilio: twilio !== null,
    meta: meta !== null,
    extraction: anthropic !== null,
    model: env.EXTRACTION_MODEL,
    emailTransport: email.transport?.name ?? null,
    emailProblem: email.problem,
    companiesHouse: env.COMPANIES_HOUSE_API_KEY !== undefined,
    appUrl: env.APP_URL ?? null,
  });
  return services;
};

const KEY = Symbol.for('accountdrop.app');
const holder = globalThis as unknown as Record<symbol, AppServices | undefined>;

export const getApp = (): AppServices => {
  holder[KEY] ??= createAppServices();
  return holder[KEY];
};
