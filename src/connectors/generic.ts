import { createHash } from 'crypto';
import * as cheerio from 'cheerio';
import { JobConnector, Source, RawJob, CrawlStats, FingerprintResult } from './types.js';
import { classifyCareerPage } from '../discovery/fingerprint.js';

export function computeContentHash(data: Record<string, unknown>): string {
  // Sort keys for deterministic JSON serialization
  const sorted = Object.keys(data)
    .sort()
    .reduce((acc, key) => {
      acc[key] = data[key];
      return acc;
    }, {} as Record<string, unknown>);

  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export class GenericCareerConnector implements JobConnector {
  readonly name = 'generic';

  async fingerprint(url: string, html?: string, headers?: Headers): Promise<FingerprintResult | null> {
    if (!html) return null;
    return classifyCareerPage({ url, html, headers });
  }

  async listJobs(
    source: Source,
    _cursor?: string,
    providedHtml?: string
  ): Promise<{ jobs: RawJob[]; nextCursor?: string; stats: CrawlStats }> {
    const stats: CrawlStats = {
      fetched: 0,
      updated: 0,
      unchanged: 0,
      expired: 0,
      failed: 0,
    };

    let html = providedHtml;
    if (!html) {
      try {
        const resp = await fetch(source.baseUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobHuntBot/1.0)' },
        });
        if (!resp.ok) {
          stats.failed++;
          stats.failureClass = `HTTP_${resp.status}`;
          return { jobs: [], stats };
        }
        html = await resp.text();
      } catch (err) {
        stats.failed++;
        stats.failureClass = err instanceof Error ? err.name : 'FetchError';
        return { jobs: [], stats };
      }
    }

    const $ = cheerio.load(html);
    const jobs: RawJob[] = [];

    // Waterfall step 1: Extract JSON-LD JobPosting schema
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const text = $(el).html();
        if (!text) return;
        const parsed = JSON.parse(text);
        const entries = Array.isArray(parsed) ? parsed : [parsed];

        for (const item of entries) {
          if (item['@type'] === 'JobPosting' || item['@type'] === 'jobPosting') {
            const externalId =
              item.identifier?.value ||
              item.identifier ||
              item.url ||
              createHash('md5').update(item.title + (item.datePosted || '')).digest('hex');

            const payload: Record<string, unknown> = {
              title: item.title,
              description: item.description,
              datePosted: item.datePosted,
              validThrough: item.validThrough,
              employmentType: item.employmentType,
              hiringOrganization: item.hiringOrganization?.name,
              jobLocation: item.jobLocation,
              baseSalary: item.baseSalary,
              directApply: item.directApply,
            };

            const contentHash = computeContentHash(payload);

            jobs.push({
              externalId: String(externalId),
              sourceUrl: source.baseUrl,
              applyUrl: item.url || source.baseUrl,
              title: item.title || 'Untitled',
              description: item.description,
              location: item.jobLocation,
              payload,
              contentHash,
            });
            stats.fetched++;
          }
        }
      } catch {
        // Skip unparseable JSON-LD blocks
      }
    });

    return { jobs, stats };
  }

  async getJob(_source: Source, _externalId: string): Promise<RawJob> {
    throw new Error('Direct getJob not supported for generic static connector');
  }

  capabilities() {
    return {
      incremental: false,
      expirySignal: false,
    };
  }
}

export const genericCareerConnector = new GenericCareerConnector();
