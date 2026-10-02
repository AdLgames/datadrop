import { describe, expect, it } from 'vitest';
import defaultTemplate from '../data/default-template.json';
import { conditionHolds, evaluate, mergeData } from './rules';
import { parseTemplate } from './template';

const template = parseTemplate(defaultTemplate);
const NOW = new Date('2026-10-02T12:00:00Z');

const complete = {
  legal_name: 'Acme Electrical Ltd',
  business_type: 'Limited company',
  company_number: '12345678',
  registered_address: '1 Reg St, Leeds',
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

describe('rules engine', () => {
  it('parses the default template and protects the system keys', () => {
    expect(template.sections.length).toBeGreaterThan(3);
    expect(() => parseTemplate({ ...defaultTemplate, protectedKeys: ['nope'] })).toThrow(
      /protected key/,
    );
  });

  it('a complete limited-company application has nothing missing and normalised data', () => {
    const r = evaluate(template, complete, NOW);
    expect(r.missing).toEqual([]);
    expect(r.flags).toEqual([]);
    expect(r.data.credit_limit_requested).toBe('5000.00');
    expect(r.data.accounts_contact_phone).toBe('+441134960000');
    expect(r.data.trading_postcode).toBe('LS1 4AB');
    // Bank fields are hidden by default and never carried.
    expect(r.requirements.bank_sort_code).toBe('hidden');
  });

  it('applies conditional rules: sole traders need DOB and home address, limited companies a company number', () => {
    const sole = evaluate(
      template,
      { ...complete, business_type: 'Sole trader', company_number: null, registered_address: null },
      NOW,
    );
    expect(sole.missing).toEqual(['principal_1_dob', 'principal_1_home_address']);
    const ltd = evaluate(template, { ...complete, company_number: null }, NOW);
    expect(ltd.missing).toEqual(['company_number']);
  });

  it('requires the personal guarantee above £10,000', () => {
    const big = evaluate(template, { ...complete, credit_limit_requested: '£25,000' }, NOW);
    expect(big.missing).toEqual(['personal_guarantee_signed']);
    expect(
      conditionHolds(
        { field: 'credit_limit_requested', op: 'gt', value: 10000, then: 'required' },
        big.data,
      ),
    ).toBe(true);
  });

  it('flags invalid values and counts a flagged required field as missing', () => {
    const r = evaluate(
      template,
      { ...complete, accounts_contact_email: 'jane at acme', company_number: 'ABC' },
      NOW,
    );
    expect(r.flags.map((f) => f.key).sort()).toEqual(['accounts_contact_email', 'company_number']);
    expect(r.missing).toEqual(['company_number', 'accounts_contact_email']);
  });

  it('drops hidden-field data on merge and never lets nulls erase values', () => {
    expect(
      mergeData(
        { legal_name: 'A', vat_number: 'GB123456789' },
        { legal_name: null, vat_number: '', trading_name: 'B' },
      ),
    ).toEqual({
      legal_name: 'A',
      vat_number: 'GB123456789',
      trading_name: 'B',
    });
    const r = evaluate(template, { ...complete, bank_sort_code: '40-47-84' }, NOW);
    expect(r.data.bank_sort_code).toBeNull();
  });
});
