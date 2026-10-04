import { z } from 'zod';
import { parseLogLevel } from './logger.server';

/**
 * Environment, validated once at startup. Secrets never leave the server; the only values that
 * reach the browser are APP_URL-derived links. `blank()` treats empty strings as unset so Vercel's
 * "set but empty" variables behave like missing ones.
 */
const blank = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().optional(),
  /** Canonical origin, e.g. https://accountdrop.example. Twilio signatures are computed over it. */
  APP_URL: z.string().url().optional(),

  SUPABASE_URL: z.string().url().optional(),
  /** Publishable (anon) key: used with the signed-in user's token, so RLS applies. */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(10).optional(),
  /** Service role: intake webhook, cron and admin only. Never sent to the browser. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10).optional(),

  TWILIO_ACCOUNT_SID: z.string().min(10).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(10).optional(),
  /** The WhatsApp sender, e.g. whatsapp:+14155238886 (sandbox) or your approved number. */
  TWILIO_WHATSAPP_FROM: z
    .string()
    .regex(/^whatsapp:\+\d{7,15}$/)
    .optional(),

  /** Meta WhatsApp Cloud API (a test number or a registered business number). */
  META_ACCESS_TOKEN: z.string().min(20).optional(),
  META_PHONE_NUMBER_ID: z
    .string()
    .regex(/^\d{6,32}$/)
    .optional(),
  META_APP_SECRET: z.string().min(16).optional(),
  /** Any string you choose; pasted into Meta's webhook settings to prove the callback URL is yours. */
  META_VERIFY_TOKEN: z.string().min(12).max(200).optional(),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v22.0'),

  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  EXTRACTION_MODEL: z.string().min(1).default('claude-opus-5-5'),

  COMPANIES_HOUSE_API_KEY: z.string().min(10).optional(),

  EMAIL_TRANSPORT: z.enum(['console', 'resend']).optional(),
  RESEND_API_KEY: z.string().min(10).optional(),
  EMAIL_FROM: z.string().min(3).optional(),

  /** Bearer token Vercel sends to cron routes. Unset: the cron routes answer 503. */
  CRON_SECRET: z.string().min(16).optional(),
  /** Seconds a rep is left quiet before the bot replies (multi-page forms arrive in bursts). */
  REPLY_QUIET_SECONDS: z.coerce.number().int().min(2).max(120).default(15),
});

export type Env = z.infer<typeof schema> & { logLevel: ReturnType<typeof parseLogLevel> };

let cached: Env | null = null;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  if (cached && source === process.env) return cached;
  const parsed = schema.safeParse({
    NODE_ENV: blank(source.NODE_ENV),
    LOG_LEVEL: blank(source.LOG_LEVEL),
    APP_URL: blank(source.APP_URL),
    SUPABASE_URL: blank(source.SUPABASE_URL),
    SUPABASE_PUBLISHABLE_KEY: blank(source.SUPABASE_PUBLISHABLE_KEY),
    SUPABASE_SERVICE_ROLE_KEY: blank(source.SUPABASE_SERVICE_ROLE_KEY),
    TWILIO_ACCOUNT_SID: blank(source.TWILIO_ACCOUNT_SID),
    TWILIO_AUTH_TOKEN: blank(source.TWILIO_AUTH_TOKEN),
    TWILIO_WHATSAPP_FROM: blank(source.TWILIO_WHATSAPP_FROM),
    META_ACCESS_TOKEN: blank(source.META_ACCESS_TOKEN),
    META_PHONE_NUMBER_ID: blank(source.META_PHONE_NUMBER_ID),
    META_APP_SECRET: blank(source.META_APP_SECRET),
    META_VERIFY_TOKEN: blank(source.META_VERIFY_TOKEN),
    META_GRAPH_VERSION: blank(source.META_GRAPH_VERSION),
    ANTHROPIC_API_KEY: blank(source.ANTHROPIC_API_KEY),
    EXTRACTION_MODEL: blank(source.EXTRACTION_MODEL),
    COMPANIES_HOUSE_API_KEY: blank(source.COMPANIES_HOUSE_API_KEY),
    EMAIL_TRANSPORT: blank(source.EMAIL_TRANSPORT),
    RESEND_API_KEY: blank(source.RESEND_API_KEY),
    EMAIL_FROM: blank(source.EMAIL_FROM),
    CRON_SECRET: blank(source.CRON_SECRET),
    REPLY_QUIET_SECONDS: blank(source.REPLY_QUIET_SECONDS),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const env: Env = {
    ...parsed.data,
    ...(parsed.data.APP_URL ? { APP_URL: parsed.data.APP_URL.replace(/\/+$/, '') } : {}),
    logLevel: parseLogLevel(parsed.data.LOG_LEVEL),
  };
  if (source === process.env) cached = env;
  return env;
};

/** Test seam. */
export const resetEnvCache = (): void => {
  cached = null;
};
