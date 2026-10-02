import { describe, expect, it } from 'vitest';
import defaultTemplate from '../data/default-template.json';
import { REPLIES, isConfirmation, money, summaryMessage, updatedMessage } from './conversation';
import { evaluate } from './rules';
import { parseTemplate } from './template';

const template = parseTemplate(defaultTemplate);
const NOW = new Date('2026-10-02T12:00:00Z');

describe('conversation', () => {
  it('reads back the key facts, the Companies House check and the missing list in the rep-facing order', () => {
    const data = {
      legal_name: 'Acme Electrical Ltd',
      business_type: 'Limited company',
      company_number: '12345678',
      trading_address: '14 High St, Leeds',
      accounts_contact_name: 'Jane Smith',
      credit_limit_requested: '5000.00',
      principal_1_dob: '1980-03-14',
    };
    const evaluation = evaluate(template, data, NOW);
    const text = summaryMessage({
      template,
      data: evaluation.data,
      evaluation,
      companiesHouse: {
        companyNumber: '12345678',
        name: 'ACME ELECTRICAL LTD',
        status: 'active',
        type: 'ltd',
        registeredAddress: null,
        checkedAt: NOW.toISOString(),
      },
    });
    expect(text).toContain("Here's what I've got for ACME ELECTRICAL LTD:");
    expect(text).toContain('• Company no: 12345678 ✓ (Active on Companies House)');
    expect(text).toContain('• Credit limit requested: £5,000');
    expect(text).toContain('Still need:');
    expect(text).toContain('1. What is the registered office address?');
    expect(text).toContain('2. What is the trading address postcode?');
    expect(text).toContain("Just reply with those and I'll add them.");
    // Sensitive values are never read back.
    expect(text).not.toContain('1980');
  });

  it('asks for confirmation once nothing is missing', () => {
    const data = {
      legal_name: 'Acme',
      business_type: 'Sole trader',
      trading_address: 'x',
      trading_postcode: 'LS1 4AB',
      accounts_contact_name: 'J',
      accounts_contact_email: 'j@a.co',
      accounts_contact_phone: '07700900123',
      credit_limit_requested: '1000',
      principal_1_name: 'J',
      principal_1_dob: '1980-01-01',
      principal_1_home_address: 'h',
      trade_ref_1_business: 'a',
      trade_ref_2_business: 'b',
      signatory_name: 'J',
      signatory_position: 'Owner',
      signature_present: 'yes',
    };
    const evaluation = evaluate(template, data, NOW);
    expect(evaluation.missing).toEqual([]);
    expect(summaryMessage({ template, data: evaluation.data, evaluation })).toContain(
      REPLIES.confirmPrompt,
    );
    expect(updatedMessage({ template, data: evaluation.data, evaluation })).toBe(
      `Updated. ${REPLIES.confirmPrompt}`,
    );
  });

  it('marks a dissolved or unknown company clearly', () => {
    const evaluation = evaluate(template, { legal_name: 'X', company_number: '00000001' }, NOW);
    expect(
      summaryMessage({
        template,
        data: evaluation.data,
        evaluation,
        companiesHouse: { notFound: true },
      }),
    ).toContain('✗ (not found on Companies House, please check)');
  });

  it('recognises confirmations and formats money', () => {
    expect(isConfirmation('YES')).toBe(true);
    expect(isConfirmation(' yes please ')).toBe(true);
    expect(isConfirmation('yes but change the limit')).toBe(false);
    expect(money('1234567.50')).toBe('1,234,567.50');
    expect(money('5000.00')).toBe('5,000');
    expect(
      REPLIES.decision('AC-0142', 'ACME ELECTRICAL LTD', 'approved', null, '10492', '5000.00'),
    ).toBe(
      'Update on AC-0142 (ACME ELECTRICAL LTD): Approved, credit limit £5,000. Account number 10492.',
    );
  });
});
