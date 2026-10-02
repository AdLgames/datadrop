import { describe, expect, it } from 'vitest';
import { lookupCompany, lookupPostcode } from './lookups.server';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('lookups', () => {
  it('reads a Companies House record with basic auth and flattens the address', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const r = await lookupCompany(
      'key',
      '12345678',
      async (url, init) => {
        calls.push({ url, auth: (init?.headers as Record<string, string>).authorization });
        return json({
          company_number: '12345678',
          company_name: 'ACME ELECTRICAL LTD',
          company_status: 'active',
          type: 'ltd',
          registered_office_address: {
            address_line_1: '1 Reg St',
            locality: 'Leeds',
            postal_code: 'LS1 4AB',
          },
        });
      },
      new Date('2026-10-02T00:00:00Z'),
    );
    expect(r).toEqual({
      companyNumber: '12345678',
      name: 'ACME ELECTRICAL LTD',
      status: 'active',
      type: 'ltd',
      registeredAddress: '1 Reg St, Leeds, LS1 4AB',
      checkedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(calls[0]?.url).toBe('https://api.company-information.service.gov.uk/company/12345678');
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('key:').toString('base64')}`);
  });

  it('distinguishes not found from unavailable', async () => {
    expect(await lookupCompany('k', '1', async () => json({}, 404))).toEqual({ notFound: true });
    expect(await lookupCompany('k', '1', async () => json({}, 500))).toBeNull();
    expect(
      await lookupCompany('k', '1', async () => {
        throw new Error('down');
      }),
    ).toBeNull();
  });

  it('validates postcodes', async () => {
    expect(await lookupPostcode('LS1 4AB', async () => json({ result: true }))).toBe(true);
    expect(await lookupPostcode('ZZ1 1ZZ', async () => json({ result: false }))).toBe(false);
    expect(await lookupPostcode('x', async () => json({}, 500))).toBeNull();
  });
});
