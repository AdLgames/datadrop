import { beforeEach, describe, expect, it, vi } from 'vitest';
import defaultTemplate from '../data/default-template.json';
import { parseTemplate } from '../lib/template';
import type { ApplicationRow, RepRow, TemplateRow, TenantRow } from './db.server';
import { createLogger } from './logger.server';

/**
 * The intake pipeline with the database, Twilio, the model and the email transport all faked in
 * memory. What is asserted is the behaviour the rep and credit control see: which replies go
 * out, when, and what state the application ends in.
 */
const template = parseTemplate(defaultTemplate);
const tenant: TenantRow = {
  id: 't1',
  name: 'Acme Distribution',
  settings: { notify_emails: ['credit@acme.co.uk'], retention_days: 30 },
};
const rep: RepRow = {
  id: 'r1',
  tenant_id: 't1',
  phone: '+447700900123',
  name: 'Dave Jones',
  branch: 'Leeds',
  active: true,
};
const templateRow: TemplateRow = {
  id: 'tpl1',
  tenant_id: 't1',
  name: template.name,
  version: 1,
  status: 'active',
  definition: template,
};

const store = {
  applications: [] as ApplicationRow[],
  messages: [] as Array<{
    id: string;
    application_id: string | null;
    direction: 'in' | 'out';
    body: string | null;
    wa_message_id: string | null;
    created_at: string;
  }>,
  documents: [] as Array<{ application_id: string; bytes: number }>,
  audits: [] as string[],
  refs: 0,
};
let clock = new Date('2026-10-02T09:00:00Z');
const tick = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

vi.mock('./db.server', () => ({
  repByPhone: async (_db: unknown, phone: string) => (phone === rep.phone ? rep : null),
  tenantById: async () => tenant,
  activeTemplate: async () => templateRow,
  openApplicationFor: async () =>
    store.applications
      .filter((a) => ['collecting', 'awaiting_confirmation', 'returned'].includes(a.status))
      .at(-1) ?? null,
  latestApplicationFor: async () => store.applications.at(-1) ?? null,
  createApplication: async () => {
    store.refs += 1;
    const row: ApplicationRow = {
      id: `app${store.refs}`,
      tenant_id: 't1',
      rep_id: 'r1',
      template_id: 'tpl1',
      template_version: 1,
      ref: `AC-${String(store.refs).padStart(4, '0')}`,
      status: 'collecting',
      data: {},
      missing_fields: [],
      flagged_fields: [],
      lookups: {},
      last_question: null,
      submitted_at: null,
      decided_at: null,
      decided_by: null,
      decision_note: null,
      account_number: null,
      approved_limit: null,
      created_at: clock.toISOString(),
      updated_at: clock.toISOString(),
    };
    store.applications.push(row);
    return row;
  },
  updateApplication: async (_db: unknown, id: string, patch: Partial<ApplicationRow>) => {
    const row = store.applications.find((a) => a.id === id)!;
    Object.assign(row, patch, { updated_at: clock.toISOString() });
    return row;
  },
  recordMessage: async (
    _db: unknown,
    row: {
      application_id: string | null;
      direction: 'in' | 'out';
      body: string | null;
      wa_message_id: string | null;
    },
  ) => {
    if (row.wa_message_id && store.messages.some((m) => m.wa_message_id === row.wa_message_id))
      return 'duplicate';
    const id = `m${store.messages.length + 1}`;
    // Postgres stamps the row a few ms after the caller took its timestamp.
    const createdAt = new Date(clock.getTime() + 5).toISOString();
    store.messages.push({
      id,
      application_id: row.application_id,
      direction: row.direction,
      body: row.body,
      wa_message_id: row.wa_message_id,
      created_at: createdAt,
    });
    return { id };
  },
  newerInboundExists: async (
    _db: unknown,
    applicationId: string,
    sinceIso: string,
    excludeMessageId: string | null = null,
  ) =>
    store.messages.some(
      (m) =>
        m.application_id === applicationId &&
        m.direction === 'in' &&
        m.created_at > sinceIso &&
        m.id !== excludeMessageId,
    ),
  audit: async (_db: unknown, row: { action: string }) => {
    store.audits.push(row.action);
  },
  storeDocument: async (_db: unknown, input: { applicationId: string; bytes: Uint8Array }) => {
    store.documents.push({ application_id: input.applicationId, bytes: input.bytes.byteLength });
    return { id: `d${store.documents.length}` };
  },
  documentsFor: async (_db: unknown, applicationId: string) =>
    store.documents
      .filter((d) => d.application_id === applicationId)
      .map((d, i) => ({ id: `d${i}`, storage_path: `p${i}`, content_type: 'image/jpeg' })),
  downloadDocuments: async (_db: unknown, docs: unknown[]) =>
    docs.map(() => ({ bytes: new Uint8Array([1]), contentType: 'image/jpeg' })),
  DEFAULT_TEMPLATE: template,
  rowAs: (v: unknown) => v,
}));
vi.mock('./supabase.server', () => ({ serviceClient: () => ({}), isConfigured: () => true }));

const emails: Array<{ to: string; subject: string; text: string }> = [];
const sent: string[] = [];
const extractImpl = vi.fn();

const fakeProvider = {
  name: 'twilio' as const,
  sendText: async (_to: string, body: string) => {
    sent.push(body);
    return `SM${sent.length}`;
  },
  fetchMedia: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }),
};

const app = () =>
  ({
    env: {
      EXTRACTION_MODEL: 'test-model',
      REPLY_QUIET_SECONDS: 45,
      COMPANIES_HOUSE_API_KEY: undefined,
      NODE_ENV: 'test',
    },
    logger: createLogger({ level: 'error' }),
    databaseConfigured: true,
    anthropic: {},
    twilio: { configuredAccountSid: 'ACtest' },
    messaging: { default: fakeProvider, for: () => fakeProvider },
    twilioUnused: {
      sendWhatsApp: async (_to: string, body: string) => {
        sent.push(body);
        return `SM${sent.length}`;
      },
      fetchMedia: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }),
    },
    email: {
      name: 'memory',
      send: async (m: { to: string; subject: string; text: string }) => void emails.push(m),
    },
    appUrl: 'https://accountdrop.test',
  }) as never;

const deps = () => ({
  app: app(),
  db: {} as never,
  now: () => clock,
  sleep: async (ms: number) => tick(ms),
  extractImpl,
});

const photo = (sid: string, body = '') => ({
  provider: 'twilio' as const,
  messageId: sid,
  accountSid: null,
  from: rep.phone,
  body,
  media: [{ ref: 'https://m/1', contentType: 'image/jpeg' }],
  profileName: null,
});
const text = (sid: string, body: string) => ({
  provider: 'twilio' as const,
  messageId: sid,
  accountSid: null,
  from: rep.phone,
  body,
  media: [],
  profileName: null,
});

const COMPLETE = {
  legal_name: 'Acme Electrical Ltd',
  business_type: 'Limited company',
  company_number: '12345678',
  registered_address: '1 Reg St',
  trading_address: '14 High St, Leeds',
  trading_postcode: 'LS1 4AB',
  accounts_contact_name: 'Jane Smith',
  accounts_contact_email: 'jane@acme.co.uk',
  accounts_contact_phone: '0113 496 0000',
  credit_limit_requested: '£5,000',
  principal_1_name: 'John Doe',
  trade_ref_1_business: 'Bolt Supplies',
  trade_ref_2_business: 'Cable Co',
  signatory_name: 'John Doe',
  signatory_position: 'Director',
  signature_present: 'yes',
};

beforeEach(() => {
  store.applications = [];
  store.messages = [];
  store.documents = [];
  store.audits = [];
  store.refs = 0;
  emails.length = 0;
  sent.length = 0;
  extractImpl.mockReset();
  clock = new Date('2026-10-02T09:00:00Z');
});

describe('intake', () => {
  it('rejects unregistered numbers without processing anything', async () => {
    const { receive } = await import('./intake.server');
    const out = await receive({ ...text('SM0', 'hello'), from: '+447000000000' }, deps());
    expect(out).toMatchObject({ kind: 'unregistered' });
    expect(store.applications).toEqual([]);
    expect(extractImpl).not.toHaveBeenCalled();
  });

  it('reads a photo, asks for what is missing after the quiet period, then submits on YES', async () => {
    const { receive } = await import('./intake.server');
    const { signature_present: _s, ...partial } = COMPLETE;
    extractImpl.mockResolvedValueOnce({
      isAccountForm: true,
      fields: partial,
      illegible: [],
      unreadableReason: null,
    });
    const first = await receive(photo('SM1'), deps());
    expect(first.kind).toBe('queued');
    if (first.kind !== 'queued') return;
    await first.work();
    expect(store.documents).toHaveLength(1);
    expect(store.applications[0]?.status).toBe('collecting');
    expect(store.applications[0]?.missing_fields).toEqual(['signature_present']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Here's what I've got for ACME ELECTRICAL LTD:");
    expect(sent[0]).toContain('1. Is the form signed?');

    // The rep answers in free text.
    tick(60_000);
    extractImpl.mockResolvedValueOnce({
      isAccountForm: true,
      fields: { signature_present: 'yes' },
      illegible: [],
      unreadableReason: null,
    });
    const second = await receive(text('SM2', 'yes it is signed'), deps());
    if (second.kind !== 'queued') throw new Error('expected queued');
    await second.work();
    expect(store.applications[0]?.status).toBe('awaiting_confirmation');
    expect(sent[1]).toBe(
      'Updated. Reply YES to send to credit control, or tell me what to change.',
    );

    // YES submits, emails credit control, and tells the rep the reference.
    tick(60_000);
    const third = await receive(text('SM3', 'YES'), deps());
    if (third.kind !== 'queued') throw new Error('expected queued');
    await third.work();
    expect(extractImpl).toHaveBeenCalledTimes(2);
    expect(store.applications[0]?.status).toBe('submitted');
    expect(sent[2]).toBe(
      "Sent to credit control, ref AC-0001. I'll message you when there's an update.",
    );
    expect(emails).toHaveLength(1);
    expect(emails[0]?.subject).toBe(
      'New account application AC-0001 — Acme Electrical Ltd (Rep: Dave Jones)',
    );
    expect(emails[0]?.text).toContain('https://accountdrop.test/app/applications/app1');
    expect(emails[0]?.text).not.toContain('1980');

    // A later text about it gets the status, not a new application.
    tick(60_000);
    const fourth = await receive(text('SM4', 'any news?'), deps());
    if (fourth.kind !== 'queued') throw new Error('expected queued');
    await fourth.work();
    expect(sent[3]).toContain('is with credit control');
    expect(store.applications).toHaveLength(1);
  });

  it('dedupes Twilio retries and lets the later message of a burst do the talking', async () => {
    const { receive } = await import('./intake.server');
    extractImpl.mockResolvedValue({
      isAccountForm: true,
      fields: { legal_name: 'Acme Ltd' },
      illegible: [],
      unreadableReason: null,
    });
    const p1 = await receive(photo('SM1'), deps());
    expect((await receive(photo('SM1'), deps())).kind).toBe('duplicate');
    if (p1.kind !== 'queued') throw new Error('expected queued');
    // Page 2 arrives 5 s later, before page 1's quiet period ends.
    const d = deps();
    const work1 = (async () => {
      await p1.work();
    })();
    tick(5_000);
    const p2 = await receive(photo('SM2'), d);
    if (p2.kind !== 'queued') throw new Error('expected queued');
    await work1;
    await p2.work();
    expect(sent).toHaveLength(1);
    expect(store.documents).toHaveLength(2);
  });

  it('asks for a retake when the photo is unreadable and ignores non-forms', async () => {
    const { receive } = await import('./intake.server');
    extractImpl.mockResolvedValueOnce({
      isAccountForm: true,
      fields: {},
      illegible: [],
      unreadableReason: 'the address block is out of focus',
    });
    const r = await receive(photo('SM1'), deps());
    if (r.kind !== 'queued') throw new Error('expected queued');
    await r.work();
    expect(sent[0]).toContain("I couldn't read that: the address block is out of focus");
    tick(60_000);
    extractImpl.mockResolvedValueOnce({
      isAccountForm: false,
      fields: {},
      illegible: [],
      unreadableReason: 'a photo of a van',
    });
    const r2 = await receive(photo('SM2'), deps());
    if (r2.kind !== 'queued') throw new Error('expected queued');
    await r2.work();
    expect(sent[1]).toContain('I can only help with new account applications');
  });

  it('expires an application left for 48 hours and starts a fresh one', async () => {
    const { receive } = await import('./intake.server');
    extractImpl.mockResolvedValue({
      isAccountForm: true,
      fields: { legal_name: 'Old Co' },
      illegible: [],
      unreadableReason: null,
    });
    const r = await receive(photo('SM1'), deps());
    if (r.kind !== 'queued') throw new Error('expected queued');
    await r.work();
    tick(49 * 60 * 60 * 1000);
    const r2 = await receive(photo('SM2'), deps());
    if (r2.kind !== 'queued') throw new Error('expected queued');
    expect(store.applications.map((a) => a.status)).toEqual(['expired', 'collecting']);
    expect(store.audits).toContain('application.expired');
  });
});
