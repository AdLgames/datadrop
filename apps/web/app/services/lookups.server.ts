/**
 * Free public lookups that turn "we read this off the form" into "we checked it". Both are
 * best-effort: a failure returns `null` and the application carries on without the check.
 */
export type LookupFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CompaniesHouseResult {
  companyNumber: string;
  name: string;
  status: string;
  type: string;
  registeredAddress: string | null;
  checkedAt: string;
}

export const COMPANIES_HOUSE_URL = 'https://api.company-information.service.gov.uk/company/';

export const lookupCompany = async (
  apiKey: string,
  companyNumber: string,
  fetchImpl: LookupFetch = (i, init) => fetch(i, init),
  now = new Date(),
): Promise<CompaniesHouseResult | { notFound: true } | null> => {
  let res: Response;
  try {
    res = await fetchImpl(`${COMPANIES_HOUSE_URL}${encodeURIComponent(companyNumber)}`, {
      headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` },
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return { notFound: true };
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    company_number?: string;
    company_name?: string;
    company_status?: string;
    type?: string;
    registered_office_address?: Record<string, string | undefined>;
  } | null;
  if (!json?.company_name) return null;
  const a = json.registered_office_address ?? {};
  const registeredAddress =
    [a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code]
      .filter((x): x is string => Boolean(x))
      .join(', ') || null;
  return {
    companyNumber: json.company_number ?? companyNumber,
    name: json.company_name,
    status: json.company_status ?? 'unknown',
    type: json.type ?? 'unknown',
    registeredAddress,
    checkedAt: now.toISOString(),
  };
};

export const lookupPostcode = async (
  postcode: string,
  fetchImpl: LookupFetch = (i, init) => fetch(i, init),
): Promise<boolean | null> => {
  try {
    const res = await fetchImpl(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}/validate`,
      { signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: boolean };
    return typeof json.result === 'boolean' ? json.result : null;
  } catch {
    return null;
  }
};
