import { z } from 'zod';

/**
 * A form template is JSON (stored in `form_templates.definition`): sections of fields, each with
 * a type, a requirement and an optional conditional rule, plus the exact question the bot asks
 * on WhatsApp when the field is missing. The same definition is compiled into the extraction
 * schema (lib/extraction-schema.ts), evaluated by the rules engine (lib/rules.ts) and rendered by
 * the review page. No per-customer code, ever.
 */
export const FIELD_TYPES = [
  'text',
  'multiline',
  'number',
  'currency',
  'date',
  'email',
  'phone',
  'postcode',
  'company_number',
  'vat_number',
  'sort_code',
  'account_number',
  'yes_no',
  'choice',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const REQUIREMENTS = ['required', 'optional', 'hidden'] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

const conditionSchema = z.object({
  /** Field key the rule looks at. */
  field: z.string().min(1).max(64),
  op: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'present']),
  value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  /** What the field becomes when the condition holds. */
  then: z.enum(['required', 'optional', 'hidden']),
});
export type Condition = z.infer<typeof conditionSchema>;

export const fieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  label: z.string().min(1).max(120),
  type: z.enum(FIELD_TYPES),
  requirement: z.enum(REQUIREMENTS).default('optional'),
  /** Evaluated in order; the last matching rule wins. */
  rules: z.array(conditionSchema).default([]),
  /** For `choice`: the allowed values. */
  options: z.array(z.string().min(1).max(80)).optional(),
  /** The exact question the bot asks when this field is missing. */
  ask: z.string().min(1).max(300).optional(),
  /** Hint for the extraction model about where/how this appears on the paper form. */
  hint: z.string().max(300).optional(),
  /** Marks personal/financial data: off by default, retention reminder in the builder. */
  sensitive: z.boolean().default(false),
  /** Column name in CSV/ERP exports. */
  exportKey: z.string().max(64).optional(),
  /** Minimum/maximum for numbers and currency, as decimal strings. */
  min: z.string().optional(),
  max: z.string().optional(),
});
export type FieldDef = z.infer<typeof fieldSchema>;

export const sectionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  title: z.string().min(1).max(120),
  fields: z.array(fieldSchema).min(1),
});

export const templateDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  /** Shown to the model so it knows what paper form it is reading. */
  description: z.string().max(600).optional(),
  sections: z.array(sectionSchema).min(1),
  /** Keys the system itself needs; cannot be removed or hidden. */
  protectedKeys: z.array(z.string()).default(['legal_name', 'business_type', 'signatory_name']),
});
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;

export const parseTemplate = (raw: unknown): TemplateDefinition => {
  const parsed = templateDefinitionSchema.parse(raw);
  const keys = new Set<string>();
  for (const s of parsed.sections) {
    for (const f of s.fields) {
      if (keys.has(f.key)) throw new Error(`duplicate field key: ${f.key}`);
      keys.add(f.key);
      if (f.type === 'choice' && (!f.options || f.options.length === 0)) {
        throw new Error(`choice field without options: ${f.key}`);
      }
    }
  }
  for (const k of parsed.protectedKeys) {
    if (!keys.has(k)) throw new Error(`protected key missing from template: ${k}`);
    const f = fieldsOf(parsed).find((x) => x.key === k);
    if (f && f.requirement === 'hidden') throw new Error(`protected key cannot be hidden: ${k}`);
  }
  return parsed;
};

export const fieldsOf = (t: TemplateDefinition): FieldDef[] => t.sections.flatMap((s) => s.fields);

export const fieldByKey = (t: TemplateDefinition, key: string): FieldDef | undefined =>
  fieldsOf(t).find((f) => f.key === key);

/** Extracted/merged application data: field key → value as the validators normalised it. */
export type ApplicationData = Record<string, string | null | undefined>;
