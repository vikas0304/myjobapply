import { createHash } from 'crypto';

export interface NormalizedJobData {
  title: string;
  roleFamily?: string;
  seniority?: string;
  location: {
    city?: string;
    state?: string;
    country?: string;
    workplaceType: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  };
  employmentType?: string;
  salary?: { min?: number; max?: number; currency?: string };
  experience?: { min?: number; max?: number };
  description: string;
  applyUrl: string;
  signatureHash: string;
}

export function cleanHtmlText(htmlOrText: string): string {
  return htmlOrText
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractSeniority(title: string): string | undefined {
  const lower = title.toLowerCase();
  if (/\b(principal|staff|distinguished)\b/.test(lower)) return 'principal';
  if (/\b(lead|architect|head|director)\b/.test(lower)) return 'lead';
  if (/\b(senior|sr\.?|sr)\b/.test(lower)) return 'senior';
  if (/\b(mid|intermediate)\b/.test(lower)) return 'mid';
  if (/\b(junior|jr\.?|associate|entry)\b/.test(lower)) return 'junior';
  if (/\b(intern|internship|trainee)\b/.test(lower)) return 'intern';
  return undefined;
}

export function extractRoleFamily(title: string): string | undefined {
  const lower = title.toLowerCase();
  if (/\b(fullstack|full-stack|full stack)\b/.test(lower)) return 'fullstack';
  if (/\b(backend|back-end|api|server)\b/.test(lower)) return 'backend';
  if (/\b(frontend|front-end|ui|web|react|angular|vue)\b/.test(lower)) return 'frontend';
  if (/\b(devops|sre|infrastructure|cloud|platform)\b/.test(lower)) return 'devops';
  if (/\b(data engineer|big data|etl|analytics engineer)\b/.test(lower)) return 'data';
  if (/\b(machine learning|ai|ml|data scientist|nlp|llm)\b/.test(lower)) return 'ai_ml';
  if (/\b(qa|quality|tester|sdet|automation)\b/.test(lower)) return 'qa';
  if (/\b(security|infosec|cyber)\b/.test(lower)) return 'security';
  if (/\b(mobile|ios|android|flutter|react native)\b/.test(lower)) return 'mobile';
  return undefined;
}

export function extractWorkplaceType(
  rawLocation?: any,
  title?: string,
  description?: string
): 'remote' | 'hybrid' | 'onsite' | 'unknown' {
  const text = `${JSON.stringify(rawLocation || {})} ${title || ''} ${description || ''}`.toLowerCase();
  if (/\b(remote|work from home|wfh|anywhere)\b/.test(text)) return 'remote';
  if (/\b(hybrid)\b/.test(text)) return 'hybrid';
  if (/\b(onsite|on-site|in-office)\b/.test(text)) return 'onsite';
  return 'unknown';
}

export function normalizeJob(
  companyId: string,
  raw: {
    title: string;
    description?: string;
    applyUrl: string;
    location?: any;
    payload?: Record<string, unknown>;
  }
): NormalizedJobData {
  const cleanedTitle = cleanHtmlText(raw.title);
  const cleanedDesc = cleanHtmlText(raw.description || '');
  const seniority = extractSeniority(cleanedTitle);
  const roleFamily = extractRoleFamily(cleanedTitle);
  const workplaceType = extractWorkplaceType(raw.location, cleanedTitle, cleanedDesc);

  let country = 'unknown';
  if (raw.location) {
    if (typeof raw.location === 'string') {
      country = raw.location;
    } else if (raw.location.address?.addressCountry) {
      country = String(raw.location.address.addressCountry);
    } else if (raw.location.country) {
      country = String(raw.location.country);
    }
  }

  // Canonical Signature Hash: sha256(company_id + normalized_title + country)
  const normalizedTitleKey = cleanedTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedCountryKey = country.toLowerCase().trim();
  const signatureHash = createHash('sha256')
    .update(`${companyId}:${normalizedTitleKey}:${normalizedCountryKey}`)
    .digest('hex');

  // Strip tracking query parameters from apply URL
  let canonicalApplyUrl = raw.applyUrl;
  try {
    const parsed = new URL(raw.applyUrl);
    parsed.searchParams.delete('utm_source');
    parsed.searchParams.delete('utm_medium');
    parsed.searchParams.delete('utm_campaign');
    parsed.searchParams.delete('gh_src');
    parsed.searchParams.delete('lever-source');
    canonicalApplyUrl = parsed.toString();
  } catch {
    // Keep raw url if invalid URL format
  }

  return {
    title: cleanedTitle,
    roleFamily,
    seniority,
    location: {
      country: normalizedCountryKey !== 'unknown' ? normalizedCountryKey : undefined,
      workplaceType,
    },
    employmentType: (raw.payload?.employmentType as string) || undefined,
    description: cleanedDesc,
    applyUrl: canonicalApplyUrl,
    signatureHash,
  };
}
