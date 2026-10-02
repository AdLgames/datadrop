import type { FieldDef, FieldType } from './template';

/**
 * UK-specific field validators and normalisers. Each takes the raw string the extraction model or
 * the rep gave us and returns either a normalised value or a problem the bot can read back.
 * Money stays a decimal string, never a float.
 */
export interface Validation {
  ok: boolean;
  /** Normalised value when ok (and sometimes a best-effort cleanup even when not). */
  value: string | null;
  problem?: string;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export const UK_POSTCODE = /^(GIR 0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export const normalisePostcode = (raw: string): string | null => {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length < 5 || s.length > 7) return null;
  const out = `${s.slice(0, -3)} ${s.slice(-3)}`;
  return UK_POSTCODE.test(out) ? out : null;
};

export const normaliseCompanyNumber = (raw: string): string | null => {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^\d{1,8}$/.test(s)) return s.padStart(8, '0');
  if (/^[A-Z]{2}\d{6}$/.test(s)) return s;
  return null;
};

export const normaliseVat = (raw: string): string | null => {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^(NONE|NA|N\/?A|NOTREGISTERED)$/.test(s)) return 'NONE';
  const digits = s.startsWith('GB') ? s.slice(2) : s;
  return /^\d{9}(\d{3})?$/.test(digits) ? `GB${digits}` : null;
};

export const normaliseSortCode = (raw: string): string | null => {
  const d = raw.replace(/\D/g, '');
  return d.length === 6 ? `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}` : null;
};

export const normaliseAccountNumber = (raw: string): string | null => {
  const d = raw.replace(/\D/g, '');
  return d.length === 8 ? d : null;
};

/** UK numbers as +44…, anything else left as digits with a leading + when international. */
export const normalisePhone = (raw: string): string | null => {
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = `+${d.slice(1).replace(/\D/g, '')}`;
  if (d.startsWith('0044')) d = `+44${d.slice(4)}`;
  else if (d.startsWith('44') && d.length >= 12) d = `+${d}`;
  else if (d.startsWith('0') && d.length === 11) d = `+44${d.slice(1)}`;
  if (!/^\+\d{9,15}$/.test(d)) return null;
  return d;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** dd/mm/yyyy, dd-mm-yy, 14 March 1980, 2024-03-14 → ISO yyyy-mm-dd (UK day-first). */
export const normaliseDate = (raw: string, now = new Date()): string | null => {
  const s = clean(raw)
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)/g, '$1');
  let d: number | undefined;
  let m: number | undefined;
  let y: number | undefined;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2,4})$/.exec(s))) {
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3]);
  } else if ((match = /^(\d{1,2})\s+([a-z]+)\.?\s+(\d{2,4})$/.exec(s))) {
    d = Number(match[1]);
    m = MONTHS[match[2]!.slice(0, 4)] ?? MONTHS[match[2]!.slice(0, 3)];
    y = Number(match[3]);
  } else if ((match = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(s))) {
    m = MONTHS[match[1]!.slice(0, 4)] ?? MONTHS[match[1]!.slice(0, 3)];
    d = Number(match[2]);
    y = Number(match[3]);
  }
  if (!d || !m || y === undefined) return null;
  if (y < 100) y += y + 2000 > now.getFullYear() + 1 ? 1900 : 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
};

export const ageOn = (isoDob: string, now: Date): number => {
  const [y, m, d] = isoDob.split('-').map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age -= 1;
  return age;
};

/** "£5,000", "5k", "5000.00" → "5000.00". Decimal string, two places. */
export const normaliseCurrency = (raw: string): string | null => {
  let s = raw.toLowerCase().replace(/[£$,\s]|gbp/g, '');
  let mult = 1n;
  if (s.endsWith('k')) {
    mult = 1000n;
    s = s.slice(0, -1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.') as [string, string?];
  const pence = BigInt(whole) * 100n * mult + BigInt((frac ?? '').padEnd(2, '0')) * mult;
  const p = pence.toString().padStart(3, '0');
  return `${p.slice(0, -2)}.${p.slice(-2)}`;
};

export const normaliseYesNo = (raw: string): string | null => {
  const s = clean(raw).toLowerCase();
  if (/^(yes|y|true|signed|present|ticked|accepted|✓|✔)$/.test(s)) return 'yes';
  if (/^(no|n|false|unsigned|not signed|missing|blank|absent|x|✗)$/.test(s)) return 'no';
  return null;
};

export const validateField = (
  field: Pick<FieldDef, 'type' | 'options' | 'min' | 'max' | 'key'>,
  raw: string,
  now = new Date(),
): Validation => {
  const value = clean(raw);
  if (value === '') return { ok: false, value: null, problem: 'empty' };
  const type: FieldType = field.type;
  switch (type) {
    case 'text':
    case 'multiline':
      return { ok: true, value };
    case 'number': {
      const n = value.replace(/,/g, '');
      return /^-?\d+(\.\d+)?$/.test(n)
        ? { ok: true, value: n }
        : { ok: false, value, problem: 'not a number' };
    }
    case 'currency': {
      const v = normaliseCurrency(value);
      if (!v) return { ok: false, value, problem: 'not an amount in £' };
      if (field.min && Number(v) < Number(field.min))
        return { ok: false, value: v, problem: 'too low' };
      if (field.max && Number(v) > Number(field.max))
        return { ok: false, value: v, problem: 'too high' };
      return { ok: true, value: v };
    }
    case 'date': {
      const v = normaliseDate(value, now);
      if (!v) return { ok: false, value, problem: 'not a date (use dd/mm/yyyy)' };
      if (field.key.endsWith('_dob')) {
        const age = ageOn(v, now);
        if (age < 18 || age > 100)
          return { ok: false, value: v, problem: `age ${age} is implausible` };
      }
      return { ok: true, value: v };
    }
    case 'email':
      return EMAIL.test(value)
        ? { ok: true, value: value.toLowerCase() }
        : { ok: false, value, problem: 'not an email address' };
    case 'phone': {
      const v = normalisePhone(value);
      return v ? { ok: true, value: v } : { ok: false, value, problem: 'not a phone number' };
    }
    case 'postcode': {
      const v = normalisePostcode(value);
      return v ? { ok: true, value: v } : { ok: false, value, problem: 'not a UK postcode' };
    }
    case 'company_number': {
      const v = normaliseCompanyNumber(value);
      return v
        ? { ok: true, value: v }
        : { ok: false, value, problem: 'not a company number (8 characters)' };
    }
    case 'vat_number': {
      const v = normaliseVat(value);
      return v
        ? { ok: true, value: v }
        : { ok: false, value, problem: 'not a VAT number (GB + 9 digits)' };
    }
    case 'sort_code': {
      const v = normaliseSortCode(value);
      return v
        ? { ok: true, value: v }
        : { ok: false, value, problem: 'not a sort code (6 digits)' };
    }
    case 'account_number': {
      const v = normaliseAccountNumber(value);
      return v
        ? { ok: true, value: v }
        : { ok: false, value, problem: 'not an account number (8 digits)' };
    }
    case 'yes_no': {
      const v = normaliseYesNo(value);
      return v ? { ok: true, value: v } : { ok: false, value, problem: 'answer yes or no' };
    }
    case 'choice': {
      const options = field.options ?? [];
      const hit =
        options.find((o) => o.toLowerCase() === value.toLowerCase()) ??
        options.find((o) => o.toLowerCase().startsWith(value.toLowerCase())) ??
        options.find((o) => value.toLowerCase().includes(o.toLowerCase().split(' ')[0] ?? ''));
      return hit
        ? { ok: true, value: hit }
        : { ok: false, value, problem: `one of: ${options.join(', ')}` };
    }
    default: {
      const never: never = type;
      return never;
    }
  }
};
