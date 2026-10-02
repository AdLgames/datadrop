import {
  fieldsOf,
  type ApplicationData,
  type Condition,
  type FieldDef,
  type Requirement,
  type TemplateDefinition,
} from './template';
import { validateField } from './validators';

/**
 * The rules engine: given a template and the data so far, decide what each field's effective
 * requirement is (conditional rules win over the default), which required fields are missing,
 * and which present values fail validation. Pure, so it is unit-tested exhaustively and runs the
 * same on the server and in the template preview.
 */
export interface Flag {
  key: string;
  label: string;
  value: string | null;
  problem: string;
}

export interface Evaluation {
  /** Field keys whose effective requirement is required and that have no valid value, in template order. */
  missing: string[];
  /** Present values that failed validation (also counted as missing when required). */
  flags: Flag[];
  /** Normalised data: valid values replaced by their canonical form; invalid ones kept as typed. */
  data: ApplicationData;
  /** Effective requirement per field, for the review page and the preview. */
  requirements: Record<string, Requirement>;
}

const asNumber = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[£,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export const conditionHolds = (c: Condition, data: ApplicationData): boolean => {
  const actual = data[c.field] ?? null;
  switch (c.op) {
    case 'present':
      return actual !== null && actual !== '';
    case 'eq':
      return (
        actual !== null && String(actual).toLowerCase() === String(c.value ?? '').toLowerCase()
      );
    case 'neq':
      return (
        actual === null || String(actual).toLowerCase() !== String(c.value ?? '').toLowerCase()
      );
    case 'in':
      return (
        actual !== null &&
        Array.isArray(c.value) &&
        c.value.some((v) => v.toLowerCase() === String(actual).toLowerCase())
      );
    case 'gt': {
      const a = asNumber(actual);
      const b = asNumber(
        typeof c.value === 'number' || typeof c.value === 'string' ? String(c.value) : null,
      );
      return a !== null && b !== null && a > b;
    }
    case 'gte': {
      const a = asNumber(actual);
      const b = asNumber(
        typeof c.value === 'number' || typeof c.value === 'string' ? String(c.value) : null,
      );
      return a !== null && b !== null && a >= b;
    }
    default: {
      const never: never = c.op;
      return never;
    }
  }
};

export const effectiveRequirement = (field: FieldDef, data: ApplicationData): Requirement => {
  let req: Requirement = field.requirement;
  for (const rule of field.rules) if (conditionHolds(rule, data)) req = rule.then;
  return req;
};

export const evaluate = (
  template: TemplateDefinition,
  input: ApplicationData,
  now = new Date(),
): Evaluation => {
  const data: ApplicationData = {};
  const flags: Flag[] = [];
  const fields = fieldsOf(template);
  // First pass: validate and normalise everything present (rules may depend on normalised values).
  for (const f of fields) {
    const raw = input[f.key];
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      data[f.key] = null;
      continue;
    }
    const v = validateField(f, String(raw), now);
    data[f.key] = v.value;
    if (!v.ok)
      flags.push({ key: f.key, label: f.label, value: v.value, problem: v.problem ?? 'invalid' });
  }
  const requirements: Record<string, Requirement> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const req = effectiveRequirement(f, data);
    requirements[f.key] = req;
    if (req === 'hidden') {
      // Hidden fields are never asked for; data captured anyway is dropped (data minimisation).
      data[f.key] = null;
      continue;
    }
    const valid = data[f.key] !== null && !flags.some((x) => x.key === f.key);
    if (req === 'required' && !valid) missing.push(f.key);
  }
  return {
    missing,
    flags: flags.filter((x) => requirements[x.key] !== 'hidden'),
    data,
    requirements,
  };
};

/** New values overwrite old ones; explicit nulls from the model never erase what we already had. */
export const mergeData = (
  previous: ApplicationData,
  incoming: ApplicationData,
): ApplicationData => {
  const out: ApplicationData = { ...previous };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined || String(v).trim() === '') continue;
    out[k] = v;
  }
  return out;
};
