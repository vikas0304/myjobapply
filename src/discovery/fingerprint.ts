import * as cheerio from 'cheerio';
import { FingerprintResult, PageClass } from '../connectors/types.js';

interface AtsPattern {
  ats: string;
  hostPatterns: RegExp[];
  htmlPatterns: RegExp[];
  extractTenant?: (url: string, html: string) => string | undefined;
}

const ATS_PATTERNS: AtsPattern[] = [
  {
    ats: 'greenhouse',
    hostPatterns: [/boards\.greenhouse\.io/i, /api\.greenhouse\.io/i],
    htmlPatterns: [/grnh\.se/i, /greenhouse-job-board/i, /boards\.greenhouse\.io\/embed/i],
    extractTenant: (url: string) => {
      const match = url.match(/boards\.greenhouse\.io\/([^/?#]+)/i);
      return match ? match[1] : undefined;
    },
  },
  {
    ats: 'lever',
    hostPatterns: [/jobs\.lever\.co/i],
    htmlPatterns: [/jobs\.lever\.co/i, /lever-jobs-embed/i],
    extractTenant: (url: string) => {
      const match = url.match(/jobs\.lever\.co\/([^/?#]+)/i);
      return match ? match[1] : undefined;
    },
  },
  {
    ats: 'ashby',
    hostPatterns: [/jobs\.ashbyhq\.com/i],
    htmlPatterns: [/jobs\.ashbyhq\.com/i, /ashby-embed/i],
    extractTenant: (url: string) => {
      const match = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i);
      return match ? match[1] : undefined;
    },
  },
  {
    ats: 'workable',
    hostPatterns: [/apply\.workable\.com/i],
    htmlPatterns: [/workable\.com/i],
    extractTenant: (url: string) => {
      const match = url.match(/apply\.workable\.com\/([^/?#]+)/i);
      return match ? match[1] : undefined;
    },
  },
  {
    ats: 'keka',
    hostPatterns: [/[a-z0-9-]+\.keka\.com\/careers/i],
    htmlPatterns: [/keka\.com\/careers/i, /cdn\.keka\.com/i],
    extractTenant: (url: string) => {
      const match = url.match(/([a-z0-9-]+)\.keka\.com/i);
      return match ? match[1] : undefined;
    },
  },
];

export interface ClassifyPageInput {
  url: string;
  html: string;
  headers?: Headers | Record<string, string>;
}

/**
 * Classifies a career page into job-list, talent-pool, hub-to-spoke, or unknown.
 * Detects embedded/hosted ATS and extracts spoke URL or talent pool form specifications.
 */
export function classifyCareerPage(input: ClassifyPageInput): FingerprintResult {
  const { url, html } = input;
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const $ = cheerio.load(html);

  // 1. Check direct ATS patterns on hostname and HTML
  for (const pattern of ATS_PATTERNS) {
    const hostMatch = pattern.hostPatterns.some((re) => re.test(hostname));
    const htmlMatch = pattern.htmlPatterns.some((re) => re.test(html));

    if (hostMatch || htmlMatch) {
      const tenant = pattern.extractTenant?.(url, html);
      return {
        ats: pattern.ats,
        tenant,
        confidence: hostMatch ? 'high' : 'medium',
        pageClass: 'job-list',
        evidence: { hostMatch, htmlMatch, detectedAts: pattern.ats },
      };
    }
  }

  // 2. Check for JSON-LD JobPosting schema
  let hasJsonLdJobs = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const content = $(el).html();
      if (!content) return;
      const data = JSON.parse(content);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'JobPosting' || item['@type'] === 'jobPosting') {
          hasJsonLdJobs = true;
          break;
        }
      }
    } catch {
      // Ignore invalid JSON-LD scripts
    }
  });

  if (hasJsonLdJobs) {
    return {
      ats: 'generic',
      confidence: 'high',
      pageClass: 'job-list',
      evidence: { format: 'json-ld' },
    };
  }

  // 3. Check for Hub-to-Spoke pattern (e.g. techmahindra.com/careers -> careers.techmahindra.com)
  const candidateSpokes: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const resolved = new URL(href, url);
      const isSubdomain =
        resolved.hostname.startsWith('careers.') ||
        resolved.hostname.startsWith('jobs.') ||
        resolved.hostname.startsWith('career.');
      const isExternalAts = ATS_PATTERNS.some((p) =>
        p.hostPatterns.some((re) => re.test(resolved.hostname))
      );

      // Distinct host from main career hub
      if ((isSubdomain || isExternalAts) && resolved.hostname !== hostname) {
        candidateSpokes.push(resolved.href);
      }
    } catch {
      // Skip invalid URLs
    }
  });

  if (candidateSpokes.length > 0) {
    const spokeUrl = candidateSpokes[0];
    return {
      ats: 'generic',
      confidence: 'high',
      pageClass: 'hub-to-spoke',
      spokeUrl,
      evidence: { spokeUrl, allCandidateSpokes: candidateSpokes.slice(0, 5) },
    };
  }

  // 4. Check for Talent-Pool pattern (Form-only without discrete job listings)
  const formFields: string[] = [];
  let hasResumeUpload = false;

  $('form').each((_, form) => {
    $(form)
      .find('input, select, textarea')
      .each((_, input) => {
        const type = $(input).attr('type')?.toLowerCase();
        const name = $(input).attr('name')?.toLowerCase() || '';
        const placeholder = $(input).attr('placeholder')?.toLowerCase() || '';
        const combined = `${name} ${placeholder}`;

        if (type === 'file' || combined.includes('resume') || combined.includes('cv')) {
          hasResumeUpload = true;
        }

        if (combined.includes('name') && !formFields.includes('name')) formFields.push('name');
        if (combined.includes('email') && !formFields.includes('email')) formFields.push('email');
        if ((combined.includes('phone') || combined.includes('mobile')) && !formFields.includes('mobile')) {
          formFields.push('mobile');
        }
        if ((combined.includes('role') || combined.includes('position')) && !formFields.includes('role')) {
          formFields.push('role');
        }
        if (combined.includes('experience') && !formFields.includes('experience')) {
          formFields.push('experience');
        }
        if (combined.includes('consent') || combined.includes('agree') || combined.includes('terms')) {
          formFields.push('consent');
        }
      });
  });

  if (hasResumeUpload && formFields.length >= 2) {
    if (hasResumeUpload && !formFields.includes('resume')) {
      formFields.push('resume');
    }
    return {
      ats: 'generic',
      confidence: 'high',
      pageClass: 'talent-pool',
      formSpec: {
        formFields,
        hasResumeUpload,
      },
      evidence: { formFields, hasResumeUpload },
    };
  }

  // 5. Default fallback
  return {
    ats: 'generic',
    confidence: 'low',
    pageClass: 'unknown',
    evidence: { reason: 'No matching pattern or form detected' },
  };
}
