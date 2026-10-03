import type { SupabaseClient } from '@supabase/supabase-js';
import {
  REPLIES,
  askedFields,
  isConfirmation,
  summaryMessage,
  updatedMessage,
} from '../lib/conversation';
import { evaluate, mergeData, type Evaluation } from '../lib/rules';
import type { ApplicationData } from '../lib/template';
import type { InboundMessage } from '../lib/twilio';
import type { AppServices } from './app.server';
import {
  activeTemplate,
  audit,
  createApplication,
  documentsFor,
  downloadDocuments,
  latestApplicationFor,
  newerInboundExists,
  openApplicationFor,
  recordMessage,
  repByPhone,
  storeDocument,
  tenantById,
  updateApplication,
  type ApplicationRow,
  type RepRow,
  type TemplateRow,
  type TenantRow,
} from './db.server';
import { extract, type ExtractionImage, type ExtractionResult } from './extraction.server';
import { notifyCreditControl } from './notify.server';
import { lookupCompany, lookupPostcode } from './lookups.server';
import { serviceClient } from './supabase.server';

/**
 * The intake pipeline for one inbound WhatsApp message:
 *
 *   1. dedupe on the Twilio message id (webhooks retry);
 *   2. resolve the rep by phone, or answer "not registered" and stop;
 *   3. find the rep's open application (or start one; a photo whose legal name differs from the
 *      open application's starts a new one; an open application untouched for 48 h is expired);
 *   4. store the media in the private bucket, then extract (every page so far, plus the text);
 *   5. merge, run the rules, save; a YES on a complete application submits it;
 *   6. after a quiet period (the rep may still be sending page 2), reply, unless a newer
 *      message has arrived, in which case that message's run replies instead.
 *
 * Step 6 runs after the webhook has answered Twilio (see routes/webhooks.twilio.tsx) so the
 * 15-second webhook timeout never matters.
 */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export interface IntakeDeps {
  app: AppServices;
  db?: SupabaseClient;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the model call. */
  extractImpl?: typeof extract;
}

export type IntakeOutcome =
  | { kind: 'duplicate' }
  | { kind: 'unregistered'; reply: string }
  | { kind: 'not_configured'; reply: string }
  | { kind: 'queued'; applicationId: string; work: () => Promise<void> };

/** Phase A (synchronous, before the webhook answers): dedupe and resolve. */
export const receive = async (msg: InboundMessage, deps: IntakeDeps): Promise<IntakeOutcome> => {
  const { app } = deps;
  const now = deps.now ?? (() => new Date());
  if (!app.databaseConfigured || !app.anthropic || !app.twilio) {
    return { kind: 'not_configured', reply: REPLIES.notConfigured };
  }
  const db = deps.db ?? serviceClient(app.env);
  const rep = await repByPhone(db, msg.from);
  if (!rep || !rep.active) {
    // Record the attempt without the body (we must not process unregistered senders' data).
    await recordMessage(db, {
      tenant_id: rep?.tenant_id ?? null,
      application_id: null,
      rep_id: null,
      direction: 'in',
      wa_message_id: msg.messageSid,
      from_phone: null,
      body: null,
      media_count: msg.media.length,
    });
    app.logger.info('intake.unregistered', { media: msg.media.length });
    return { kind: 'unregistered', reply: REPLIES.unregistered };
  }
  const tenant = await tenantById(db, rep.tenant_id);
  if (!tenant) return { kind: 'unregistered', reply: REPLIES.unregistered };
  const template = await activeTemplate(db, tenant.id);
  const t = now();

  let application = await openApplicationFor(db, rep.id);
  if (application && t.getTime() - new Date(application.updated_at).getTime() > STALE_AFTER_MS) {
    await updateApplication(db, application.id, { status: 'expired' });
    await audit(db, {
      tenant_id: tenant.id,
      application_id: application.id,
      actor: 'system',
      action: 'application.expired',
    });
    application = null;
  }
  // A rep with nothing open who sends a message about a decided application gets the status.
  if (!application && msg.media.length === 0) {
    const latest = await latestApplicationFor(db, rep.id);
    if (latest && ['submitted', 'under_review'].includes(latest.status)) {
      await recordMessage(db, {
        tenant_id: tenant.id,
        application_id: latest.id,
        rep_id: rep.id,
        direction: 'in',
        wa_message_id: msg.messageSid,
        from_phone: rep.phone,
        body: msg.body,
        media_count: 0,
      });
      return {
        kind: 'queued',
        applicationId: latest.id,
        work: async () => {
          await sendReply(
            deps,
            db,
            tenant,
            rep,
            latest,
            REPLIES.alreadySubmitted(latest.ref, latest.data.legal_name ?? null),
          );
        },
      };
    }
  }
  application ??= await createApplication(db, { tenantId: tenant.id, repId: rep.id, template });
  const stored = await recordMessage(db, {
    tenant_id: tenant.id,
    application_id: application.id,
    rep_id: rep.id,
    direction: 'in',
    wa_message_id: msg.messageSid,
    from_phone: rep.phone,
    body: msg.body || null,
    media_count: msg.media.length,
  });
  if (stored === 'duplicate') return { kind: 'duplicate' };
  const messageId = stored.id;
  const receivedAt = t.toISOString();
  const appRow = application;
  return {
    kind: 'queued',
    applicationId: application.id,
    work: () =>
      process(deps, db, { tenant, rep, template, application: appRow, msg, messageId, receivedAt }),
  };
};

interface ProcessInput {
  tenant: TenantRow;
  rep: RepRow;
  template: TemplateRow;
  application: ApplicationRow;
  msg: InboundMessage;
  messageId: string;
  receivedAt: string;
}

/** Phase B (background): media, extraction, rules, state, quiet period, reply. */
const process = async (
  deps: IntakeDeps,
  db: SupabaseClient,
  input: ProcessInput,
): Promise<void> => {
  const { app } = deps;
  const now = deps.now ?? (() => new Date());
  const log = app.logger.child({ applicationId: input.application.id, ref: input.application.ref });
  let application = input.application;
  const { tenant, rep, template, msg } = input;
  try {
    await audit(db, {
      tenant_id: tenant.id,
      application_id: application.id,
      actor: 'system',
      action: 'intake.started',
      detail: { media: msg.media.length, text: msg.body.length > 0 },
    });
    if (msg.accountSid && msg.accountSid !== app.twilio!.configuredAccountSid) {
      await audit(db, {
        tenant_id: tenant.id,
        application_id: application.id,
        actor: 'system',
        action: 'twilio.account_sid_mismatch',
        detail: {
          hint: 'TWILIO_ACCOUNT_SID differs from the account Twilio posted; using the posted one',
        },
      });
    }
    // 1. Media into our bucket (Twilio URLs expire and need our credentials).
    const fresh: ExtractionImage[] = [];
    for (const m of msg.media) {
      try {
        const { bytes, contentType } = await app.twilio!.fetchMedia(m.url, msg.accountSid);
        await storeDocument(db, {
          tenantId: tenant.id,
          applicationId: application.id,
          messageId: input.messageId,
          bytes,
          contentType,
          retentionDays: tenant.settings.retention_days ?? 30,
          now: now(),
        });
        fresh.push({ bytes, contentType });
      } catch (err) {
        log.warn('intake.media_failed', { error: err });
        await trace(db, tenant.id, application.id, 'intake.media_failed', err);
      }
    }

    // 2. YES on a complete application submits it; no model call needed.
    if (
      application.status === 'awaiting_confirmation' &&
      msg.media.length === 0 &&
      isConfirmation(msg.body)
    ) {
      await submit(deps, db, tenant, rep, template, application);
      return;
    }

    // 3. Extract from every page so far plus this message's text.
    const images = fresh.length > 0 ? await allPages(db, application, fresh) : [];
    if (images.length === 0 && msg.body.trim() === '') {
      await quietReply(deps, db, {
        tenant,
        rep,
        application,
        receivedAt: input.receivedAt,
        text: REPLIES.notAForm,
        accountSid: msg.accountSid,
      });
      return;
    }
    const extractImpl = deps.extractImpl ?? extract;
    const result: ExtractionResult = await extractImpl(app.anthropic!, app.env.EXTRACTION_MODEL, {
      template: template.definition,
      images,
      text: msg.body,
      existing: application.data,
      asked: askedFields(template.definition, application.missing_fields),
    });
    await audit(db, {
      tenant_id: tenant.id,
      application_id: application.id,
      actor: 'system',
      action: 'intake.extracted',
      detail: { images: images.length, isForm: result.isAccountForm },
    });
    log.info('intake.extracted', {
      images: images.length,
      isForm: result.isAccountForm,
      fieldsFound: Object.values(result.fields).filter(Boolean).length,
      illegible: result.illegible.length,
    });

    if (
      !result.isAccountForm &&
      images.length > 0 &&
      Object.values(result.fields).every((v) => !v)
    ) {
      await quietReply(deps, db, {
        tenant,
        rep,
        application,
        receivedAt: input.receivedAt,
        text: REPLIES.notAForm,
        accountSid: msg.accountSid,
      });
      return;
    }
    if (
      result.unreadableReason &&
      Object.values(result.fields).filter(Boolean).length < 3 &&
      images.length > 0
    ) {
      await quietReply(deps, db, {
        tenant,
        rep,
        application,
        receivedAt: input.receivedAt,
        text: REPLIES.unreadable(result.unreadableReason),
        accountSid: msg.accountSid,
      });
      return;
    }

    // 4. A photo of a different company while one is open: start a new application for it.
    const incomingName = result.fields.legal_name?.trim();
    const currentName = application.data.legal_name?.trim();
    if (
      images.length > 0 &&
      fresh.length > 0 &&
      incomingName &&
      currentName &&
      incomingName.toLowerCase() !== currentName.toLowerCase() &&
      Object.values(application.data).filter(Boolean).length >= 3
    ) {
      const next = await createApplication(db, { tenantId: tenant.id, repId: rep.id, template });
      await db
        .from('documents')
        .update({ application_id: next.id })
        .eq('message_id', input.messageId);
      await db.from('messages').update({ application_id: next.id }).eq('id', input.messageId);
      await audit(db, {
        tenant_id: tenant.id,
        application_id: next.id,
        actor: 'system',
        action: 'application.split',
        detail: { from: application.id },
      });
      application = next;
    }

    // 5. Merge, evaluate, look things up, save.
    const merged = mergeData(application.data, result.fields);
    const evaluation = evaluate(template.definition, merged, now());
    const lookups = await runLookups(app, application, evaluation.data);
    const complete = evaluation.missing.length === 0 && evaluation.flags.length === 0;
    const wasEmpty = Object.values(application.data).filter(Boolean).length === 0;
    application = await updateApplication(db, application.id, {
      data: evaluation.data,
      missing_fields: evaluation.missing,
      flagged_fields: evaluation.flags,
      lookups,
      status: complete
        ? 'awaiting_confirmation'
        : application.status === 'returned'
          ? 'returned'
          : 'collecting',
      last_question: evaluation.missing[0] ?? null,
    });
    await audit(db, {
      tenant_id: tenant.id,
      application_id: application.id,
      actor: `rep:${rep.id}`,
      action: 'application.updated',
      detail: {
        fields: Object.keys(result.fields).filter((k) => result.fields[k]),
        missing: evaluation.missing.length,
      },
    });
    const text =
      wasEmpty || fresh.length > 0
        ? summaryMessage({
            template: template.definition,
            data: application.data,
            evaluation,
            companiesHouse: lookups.companies_house ?? null,
          })
        : updatedMessage({ template: template.definition, data: application.data, evaluation });
    await quietReply(deps, db, {
      tenant,
      rep,
      application,
      receivedAt: input.receivedAt,
      text,
      accountSid: msg.accountSid,
    });
  } catch (err) {
    log.error('intake.failed', { error: err });
    await trace(db, tenant.id, application.id, 'intake.failed', err);
    try {
      await sendReply(
        deps,
        db,
        tenant,
        rep,
        application,
        "Something went wrong reading that. I'll try again if you resend it, or type the details.",
      );
    } catch {
      // nothing more to do
    }
  }
};

const allPages = async (
  db: SupabaseClient,
  application: ApplicationRow,
  fresh: ExtractionImage[],
): Promise<ExtractionImage[]> => {
  const docs = await documentsFor(db, application.id);
  // Everything stored so far, which includes this message's pages (stored above); fall back to
  // the fresh bytes if the download fails for any reason.
  const stored = await downloadDocuments(db, docs);
  return stored.length >= fresh.length ? stored.slice(-6) : fresh;
};

const runLookups = async (app: AppServices, application: ApplicationRow, data: ApplicationData) => {
  const lookups = { ...application.lookups };
  const number = data.company_number;
  const previous = lookups.companies_house;
  const previousNumber = previous && !('notFound' in previous) ? previous.companyNumber : null;
  if (number && app.env.COMPANIES_HOUSE_API_KEY && number !== previousNumber) {
    lookups.companies_house = await lookupCompany(app.env.COMPANIES_HOUSE_API_KEY, number);
  }
  for (const key of ['trading_postcode', 'delivery_postcode']) {
    const pc = data[key];
    if (pc && lookups.postcode_valid?.[pc] === undefined) {
      const ok = await lookupPostcode(pc);
      if (ok !== null) lookups.postcode_valid = { ...(lookups.postcode_valid ?? {}), [pc]: ok };
    }
  }
  return lookups;
};

const submit = async (
  deps: IntakeDeps,
  db: SupabaseClient,
  tenant: TenantRow,
  rep: RepRow,
  template: TemplateRow,
  application: ApplicationRow,
) => {
  const now = deps.now ?? (() => new Date());
  const evaluation: Evaluation = evaluate(template.definition, application.data, now());
  if (evaluation.missing.length > 0 || evaluation.flags.length > 0) {
    await sendReply(
      deps,
      db,
      tenant,
      rep,
      application,
      updatedMessage({ template: template.definition, data: application.data, evaluation }),
    );
    return;
  }
  const updated = await updateApplication(db, application.id, {
    status: 'submitted',
    submitted_at: now().toISOString(),
  });
  await audit(db, {
    tenant_id: tenant.id,
    application_id: application.id,
    actor: `rep:${rep.id}`,
    action: 'application.submitted',
  });
  await sendReply(deps, db, tenant, rep, updated, REPLIES.submitted(updated.ref));
  try {
    await notifyCreditControl(deps.app, db, {
      tenant,
      rep,
      application: updated,
      template: template.definition,
    });
  } catch (err) {
    deps.app.logger.error('intake.notify_failed', { error: err, applicationId: updated.id });
  }
};

/**
 * Failures in the background step are invisible from the outside (the webhook already answered
 * Twilio), so each one is also written to the audit log with its message. The message carries no
 * personal data (provider status lines, our own error text), never the form contents.
 */
const trace = async (
  db: SupabaseClient,
  tenantId: string,
  applicationId: string | null,
  action: string,
  err: unknown,
): Promise<void> => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  try {
    await audit(db, {
      tenant_id: tenantId,
      application_id: applicationId,
      actor: 'system',
      action,
      detail: { error: message.slice(0, 300) },
    });
  } catch {
    // the audit log itself is unavailable; nothing more to do
  }
};

/** Wait for the rep to go quiet, then reply unless a later message is handling it. */
const quietReply = async (
  deps: IntakeDeps,
  db: SupabaseClient,
  input: {
    tenant: TenantRow;
    rep: RepRow;
    application: ApplicationRow;
    receivedAt: string;
    text: string;
    accountSid?: string | null;
  },
) => {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await audit(db, {
    tenant_id: input.tenant.id,
    application_id: input.application.id,
    actor: 'system',
    action: 'intake.reply_scheduled',
    detail: { quietSeconds: deps.app.env.REPLY_QUIET_SECONDS },
  });
  await sleep(deps.app.env.REPLY_QUIET_SECONDS * 1000);
  if (await newerInboundExists(db, input.application.id, input.receivedAt)) {
    deps.app.logger.info('intake.reply_superseded', { applicationId: input.application.id });
    await audit(db, {
      tenant_id: input.tenant.id,
      application_id: input.application.id,
      actor: 'system',
      action: 'intake.reply_superseded',
    });
    return;
  }
  await sendReply(
    deps,
    db,
    input.tenant,
    input.rep,
    input.application,
    input.text,
    input.accountSid,
  );
};

export const sendReply = async (
  deps: IntakeDeps,
  db: SupabaseClient,
  tenant: TenantRow,
  rep: RepRow,
  application: ApplicationRow | null,
  text: string,
  accountSid?: string | null,
) => {
  let sid: string;
  try {
    sid = await deps.app.twilio!.sendWhatsApp(rep.phone, text, accountSid);
  } catch (err) {
    await trace(db, tenant.id, application?.id ?? null, 'intake.reply_failed', err);
    throw err;
  }
  await recordMessage(db, {
    tenant_id: tenant.id,
    application_id: application?.id ?? null,
    rep_id: rep.id,
    direction: 'out',
    wa_message_id: sid || null,
    from_phone: null,
    body: text,
    media_count: 0,
  });
};
