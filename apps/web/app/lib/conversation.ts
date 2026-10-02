import type { Evaluation } from './rules';
import { fieldByKey, fieldsOf, type ApplicationData, type TemplateDefinition } from './template';
import type { CompaniesHouseResult } from '../services/lookups.server';

/**
 * Everything the bot says, in one place, so the copy can be read end to end. Short, plain,
 * predictable: reps are on phones, in vans, in a hurry. Nothing sensitive is ever read back in
 * full (DOB, home address and bank fields are shown as "provided").
 */
export const REPLIES = {
  unregistered:
    "This number isn't registered with AccountDrop. Ask your manager to add you, then send the form again.",
  notAForm:
    "I can only help with new account applications. Send me a photo of the form (or type the details) and I'll take it from there.",
  unreadable: (hint: string | null) =>
    `I couldn't read that${hint ? `: ${hint}` : ''}. Can you retake the photo in better light, flat on, with the whole page in shot?`,
  received: 'Got it. Reading the form now, give me a few seconds.',
  notConfigured:
    "AccountDrop isn't fully set up yet, so I can't read forms right now. Please try again later.",
  confirmPrompt: 'Reply YES to send to credit control, or tell me what to change.',
  submitted: (ref: string) =>
    `Sent to credit control, ref ${ref}. I'll message you when there's an update.`,
  alreadySubmitted: (ref: string, legalName: string | null) =>
    `${legalName ? `${legalName} (${ref})` : ref} is with credit control. Send a photo of a new form to start another application.`,
  expiredRestart:
    "Your previous application was left unfinished for over 48 hours, so I've closed it. Send the form again to start fresh.",
  decision: (
    ref: string,
    legalName: string | null,
    status: 'approved' | 'returned' | 'rejected',
    note: string | null,
    accountNumber: string | null,
    limit: string | null,
  ) => {
    const who = legalName ? `${ref} (${legalName})` : ref;
    if (status === 'approved') {
      return `Update on ${who}: Approved${limit ? `, credit limit £${money(limit)}` : ''}${accountNumber ? `. Account number ${accountNumber}` : ''}.`;
    }
    if (status === 'returned') {
      return `Update on ${who}: Returned by credit control${note ? `: ${note}` : ''}. Reply with the corrections and I'll resubmit.`;
    }
    return `Update on ${who}: Not approved${note ? `: ${note}` : ''}.`;
  },
} as const;

const SENSITIVE_PLACEHOLDER = 'provided';

export const money = (decimal: string): string => {
  const [whole = '0', frac = '00'] = decimal.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === '00' ? grouped : `${grouped}.${frac}`;
};

const show = (
  template: TemplateDefinition,
  key: string,
  value: string | null | undefined,
): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const f = fieldByKey(template, key);
  if (!f) return value;
  if (f.sensitive) return SENSITIVE_PLACEHOLDER;
  if (f.type === 'currency') return `£${money(value)}`;
  if (f.type === 'yes_no') return value === 'yes' ? 'yes' : 'no';
  return value;
};

/** Keys read back in the summary, in this order, when present. */
const SUMMARY_KEYS = [
  'business_type',
  'company_number',
  'vat_number',
  'trading_address',
  'trading_postcode',
  'accounts_contact_name',
  'accounts_contact_email',
  'accounts_contact_phone',
  'credit_limit_requested',
  'principal_1_name',
  'trade_ref_1_business',
  'trade_ref_2_business',
  'signatory_name',
  'signature_present',
];

export const companiesHouseLine = (
  data: ApplicationData,
  ch: CompaniesHouseResult | { notFound: true } | null | undefined,
): string => {
  const n = data.company_number;
  if (!n) return '';
  if (!ch) return `• Company no: ${n}`;
  if ('notFound' in ch) return `• Company no: ${n} ✗ (not found on Companies House, please check)`;
  const status = ch.status.toLowerCase();
  const mark = status === 'active' ? '✓' : '✗';
  return `• Company no: ${n} ${mark} (${capitalise(status)} on Companies House${status === 'active' ? '' : ', please check'})`;
};

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export interface SummaryInput {
  template: TemplateDefinition;
  data: ApplicationData;
  evaluation: Evaluation;
  companiesHouse?: CompaniesHouseResult | { notFound: true } | null;
}

/** "Here's what I've got..." plus either the missing list or the confirm prompt. */
export const summaryMessage = ({
  template,
  data,
  evaluation,
  companiesHouse,
}: SummaryInput): string => {
  const name = data.legal_name ?? data.trading_name ?? 'this application';
  const lines: string[] = [`Here's what I've got for ${name.toUpperCase()}:`];
  for (const key of SUMMARY_KEYS) {
    if (key === 'company_number') {
      const l = companiesHouseLine(data, companiesHouse);
      if (l) lines.push(l);
      continue;
    }
    const f = fieldByKey(template, key);
    const v = show(template, key, data[key]);
    if (f && v !== null && evaluation.requirements[key] !== 'hidden')
      lines.push(`• ${f.label}: ${v}`);
  }
  const problems = evaluation.flags.filter((x) => !evaluation.missing.includes(x.key) || x.value);
  if (problems.length > 0) {
    lines.push('', 'Please check:');
    for (const p of problems) lines.push(`• ${p.label}: "${p.value ?? ''}" (${p.problem})`);
  }
  if (evaluation.missing.length > 0) {
    lines.push('', 'Still need:');
    evaluation.missing.forEach((key, i) => {
      const f = fieldByKey(template, key);
      lines.push(`${i + 1}. ${f?.ask ?? `${f?.label ?? key}?`}`);
    });
    lines.push('', "Just reply with those and I'll add them.");
  } else {
    lines.push('', REPLIES.confirmPrompt);
  }
  return lines.join('\n');
};

/** After the rep answers: a short "Updated." plus whatever is still needed. */
export const updatedMessage = (input: SummaryInput): string => {
  const { template, evaluation } = input;
  if (evaluation.missing.length === 0 && evaluation.flags.length === 0) {
    return `Updated. ${REPLIES.confirmPrompt}`;
  }
  const lines: string[] = ['Updated.'];
  if (evaluation.flags.length > 0) {
    lines.push('', 'Please check:');
    for (const p of evaluation.flags) lines.push(`• ${p.label}: "${p.value ?? ''}" (${p.problem})`);
  }
  if (evaluation.missing.length > 0) {
    lines.push('', 'Still need:');
    evaluation.missing.forEach((key, i) => {
      const f = fieldByKey(template, key);
      lines.push(`${i + 1}. ${f?.ask ?? `${f?.label ?? key}?`}`);
    });
  }
  return lines.join('\n');
};

export const isConfirmation = (body: string): boolean =>
  /^\s*(yes|y|yes please|yep|yeah|confirm|confirmed|send it|send|ok send|submit)\s*[.!]*\s*$/i.test(
    body,
  );

/** Fields a rep could plausibly be answering, for the extraction prompt on text replies. */
export const askedFields = (template: TemplateDefinition, missing: string[]): string[] =>
  missing.length > 0 ? missing : fieldsOf(template).map((f) => f.key);
