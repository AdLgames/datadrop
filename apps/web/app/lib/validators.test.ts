import { describe, expect, it } from 'vitest';
import {
  ageOn,
  normaliseAccountNumber,
  normaliseCompanyNumber,
  normaliseCurrency,
  normaliseDate,
  normalisePhone,
  normalisePostcode,
  normaliseSortCode,
  normaliseVat,
  normaliseYesNo,
  validateField,
} from './validators';

const NOW = new Date('2026-10-02T12:00:00Z');

describe('UK validators', () => {
  it('normalises postcodes and rejects nonsense', () => {
    expect(normalisePostcode('ls14ab')).toBe('LS1 4AB');
    expect(normalisePostcode('SW1A 1AA')).toBe('SW1A 1AA');
    expect(normalisePostcode('12345')).toBeNull();
    expect(normalisePostcode('')).toBeNull();
  });

  it('pads and checks company numbers', () => {
    expect(normaliseCompanyNumber('1234567')).toBe('01234567');
    expect(normaliseCompanyNumber('SC123456')).toBe('SC123456');
    expect(normaliseCompanyNumber('123456789')).toBeNull();
  });

  it('handles VAT numbers including "none"', () => {
    expect(normaliseVat('GB 123 4567 89')).toBe('GB123456789');
    expect(normaliseVat('123456789')).toBe('GB123456789');
    expect(normaliseVat('not registered')).toBe('NONE');
    expect(normaliseVat('GB12')).toBeNull();
  });

  it('formats sort codes and account numbers', () => {
    expect(normaliseSortCode('40 47 84')).toBe('40-47-84');
    expect(normaliseSortCode('4047')).toBeNull();
    expect(normaliseAccountNumber('1234 5678')).toBe('12345678');
    expect(normaliseAccountNumber('1234567')).toBeNull();
  });

  it('turns UK phone numbers into E.164', () => {
    expect(normalisePhone('07700 900123')).toBe('+447700900123');
    expect(normalisePhone('+44 (0)7700 900123')).toBe('+4407700900123');
    expect(normalisePhone('0044 7700 900123')).toBe('+447700900123');
    expect(normalisePhone('0113 496 0000')).toBe('+441134960000');
    expect(normalisePhone('123')).toBeNull();
  });

  it('parses day-first dates in the forms reps actually write', () => {
    expect(normaliseDate('14/03/1980', NOW)).toBe('1980-03-14');
    expect(normaliseDate('14-3-80', NOW)).toBe('1980-03-14');
    expect(normaliseDate('14th March 1980', NOW)).toBe('1980-03-14');
    expect(normaliseDate('March 14, 1980', NOW)).toBe('1980-03-14');
    expect(normaliseDate('2024-03-14', NOW)).toBe('2024-03-14');
    expect(normaliseDate('31/02/2024', NOW)).toBeNull();
    expect(normaliseDate('yesterday', NOW)).toBeNull();
    expect(ageOn('1980-03-14', NOW)).toBe(46);
  });

  it('keeps money as a decimal string', () => {
    expect(normaliseCurrency('£5,000')).toBe('5000.00');
    expect(normaliseCurrency('5k')).toBe('5000.00');
    expect(normaliseCurrency('1234.5')).toBe('1234.50');
    expect(normaliseCurrency('five grand')).toBeNull();
  });

  it('reads yes/no marks', () => {
    expect(normaliseYesNo('Signed')).toBe('yes');
    expect(normaliseYesNo('not signed')).toBe('no');
    expect(normaliseYesNo('maybe')).toBeNull();
  });

  it('validates typed fields with the right problems', () => {
    expect(
      validateField({ key: 'principal_1_dob', type: 'date' }, '14/03/2015', NOW),
    ).toMatchObject({
      ok: false,
      problem: 'age 11 is implausible',
    });
    expect(validateField({ key: 'x', type: 'email' }, 'JANE@Acme.co.uk')).toEqual({
      ok: true,
      value: 'jane@acme.co.uk',
    });
    expect(
      validateField(
        { key: 'x', type: 'choice', options: ['Limited company', 'Sole trader'] },
        'ltd',
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateField(
        { key: 'x', type: 'choice', options: ['Limited company', 'Sole trader'] },
        'sole',
      ),
    ).toEqual({
      ok: true,
      value: 'Sole trader',
    });
    expect(validateField({ key: 'x', type: 'currency', max: '10000' }, '£12,000')).toMatchObject({
      ok: false,
      problem: 'too high',
    });
  });
});
