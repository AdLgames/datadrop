import type { SupabaseClient } from '@supabase/supabase-js';
import { REPLIES, companiesHouseLine, money } from '../lib/conversation';
import type { TemplateDefinition } from '../lib/template';
import type { AppServices } from './app.server';
import { recordMessage, type ApplicationRow, type RepRow, type TenantRow } from './db.server';

/**
 * Outbound notices. The email to credit control carries key fields only: never DOB, home
 * addresses or bank details (those are on the review page, behind sign-in). The rep's WhatsApp
 * status update is sent as a plain message; outside the 24-hour window Twilio needs an approved
 * template, so a failure here is logged, never fatal.
 */
export const notifyCreditControl = async (
  app: AppServices,
  db: SupabaseClient,
  input: {
    tenant: TenantRow;
    rep: RepRow;
    application: ApplicationRow;
    template: TemplateDefinition;
  },
): Promise<void> => {
  const { tenant, rep, application } = input;
  const recipients = tenant.settings.notify_emails ?? [];
  if (!app.email || recipients.length === 0) {
    app.logger.warn('notify.skipped', {
      reason: app.email ? 'no notify_emails' : 'no email transport',
    });
    return;
  }
  const d = application.data;
  const name = d.legal_name ?? 'Unnamed business';
  const link = `${app.appUrl ?? ''}/app/applications/${application.id}`;
  const ch = companiesHouseLine(d, application.lookups.companies_house);
  const lines = [
    `New account application ${application.ref} from ${rep.name}${rep.branch ? ` (${rep.branch})` : ''}.`,
    '',
    `Business: ${name}${d.trading_name ? ` (t/a ${d.trading_name})` : ''}`,
    `Type: ${d.business_type ?? '-'}`,
    ch ? ch.replace(/^• /, '') : null,
    `Accounts contact: ${d.accounts_contact_name ?? '-'}${d.accounts_contact_email ? `, ${d.accounts_contact_email}` : ''}`,
    `Credit limit requested: ${d.credit_limit_requested ? `£${money(d.credit_limit_requested)}` : '-'}`,
    `Signed: ${d.signature_present === 'yes' ? 'yes' : 'NO'}`,
    application.flagged_fields.length > 0
      ? `Flags: ${application.flagged_fields.map((f) => f.label).join(', ')}`
      : null,
    '',
    `Open application: ${link}`,
    '',
    'The original form images are attached to the application in AccountDrop.',
  ].filter((l): l is string => l !== null);
  for (const to of recipients) {
    await app.email.send({
      to,
      subject: `New account application ${application.ref} — ${name} (Rep: ${rep.name})`,
      text: lines.join('\n'),
    });
  }
};

export const notifyRepDecision = async (
  app: AppServices,
  db: SupabaseClient,
  input: { tenant: TenantRow; rep: RepRow; application: ApplicationRow },
): Promise<void> => {
  const { tenant, rep, application } = input;
  if (tenant.settings.rep_notifications === false || !app.twilio) return;
  const status = application.status;
  if (status !== 'approved' && status !== 'returned' && status !== 'rejected') return;
  const text = REPLIES.decision(
    application.ref,
    application.data.legal_name ?? null,
    status,
    application.decision_note,
    application.account_number,
    application.approved_limit,
  );
  try {
    const sid = await app.twilio.sendWhatsApp(rep.phone, text);
    await recordMessage(db, {
      tenant_id: tenant.id,
      application_id: application.id,
      rep_id: rep.id,
      direction: 'out',
      wa_message_id: sid || null,
      from_phone: null,
      body: text,
      media_count: 0,
    });
  } catch (err) {
    app.logger.warn('notify.rep_failed', { error: err, applicationId: application.id });
  }
};
