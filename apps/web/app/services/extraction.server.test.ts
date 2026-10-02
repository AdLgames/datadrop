import { describe, expect, it } from 'vitest';
import defaultTemplate from '../data/default-template.json';
import { parseTemplate } from '../lib/template';
import { buildPrompt, extractionSchema } from './extraction.server';

const template = parseTemplate(defaultTemplate);

describe('extraction', () => {
  it('compiles the template into a schema with every field nullable', () => {
    const schema = extractionSchema(template);
    const parsed = schema.parse({
      is_account_form: true,
      unreadable_reason: null,
      fields: Object.fromEntries(
        template.sections.flatMap((s) => s.fields.map((f) => [f.key, null])),
      ),
      illegible: ['principal_1_dob'],
    });
    expect(parsed.fields.legal_name).toBeNull();
    expect(() =>
      schema.parse({ is_account_form: true, unreadable_reason: null, fields: {}, illegible: [] }),
    ).toThrow();
  });

  it('builds a prompt that lists the fields, the existing data and what was asked', () => {
    const { system, user } = buildPrompt({
      template,
      images: [],
      text: '14/03/1980',
      existing: { legal_name: 'Acme Ltd', vat_number: null },
      asked: ['principal_1_dob', 'delivery_postcode'],
    });
    expect(system).toContain('Never invent');
    expect(user).toContain('- company_number (company_number): Company registration number');
    expect(user).toContain(
      'Already captured (do not repeat unless corrected):\nlegal_name: Acme Ltd',
    );
    expect(user).toContain('Fields just asked for: principal_1_dob, delivery_postcode');
    expect(user).toContain('"""\n14/03/1980\n"""');
    expect(user).not.toContain('vat_number: null');
  });
});
