import { describe, it, expect } from 'vitest';
import { sql } from '../db/index.js';
import { IngestionCrawler } from './crawler.js';
import { DiscoveryService } from '../discovery/service.js';

describe('Phase 2.1: Ingestion & Raw Postings Engine', () => {
  it('idempotently crawls, stores raw postings, and emits outbox events', async () => {
    if (!sql) {
      console.warn('Skipping test: No database connection');
      return;
    }

    const discoveryService = new DiscoveryService();
    const crawler = new IngestionCrawler();

    // 1. Setup Company & Source Connector
    const company = await discoveryService.registerCompany({
      name: `Ingest Test Corp ${Date.now()}`,
      domain: `ingest-test-${Date.now()}.com`,
    });

    await sql`
      INSERT INTO ingest.source_connectors (name, capabilities)
      VALUES ('generic', '{"incremental": false}')
      ON CONFLICT (name) DO NOTHING
    `;

    const [jobSource] = await sql<{ id: string }[]>`
      INSERT INTO ingest.job_sources (
        company_id,
        connector,
        base_url,
        active
      ) VALUES (
        ${company.id},
        'generic',
        'https://ingest-test.com/careers',
        true
      )
      RETURNING id
    `;

    // 2. Sample HTML with 2 JSON-LD JobPostings
    const sampleHtmlV1 = `
      <!DOCTYPE html>
      <html>
        <head>
          <script type="application/ld+json">
          [
            {
              "@context": "https://schema.org",
              "@type": "JobPosting",
              "title": "Senior Backend Engineer",
              "identifier": {
                "@type": "PropertyValue",
                "name": "Acme",
                "value": "JOB-101"
              },
              "description": "Develop scalable distributed backend services with TypeScript and PostgreSQL.",
              "datePosted": "2026-09-18",
              "employmentType": "FULL_TIME",
              "jobLocation": {
                "@type": "Place",
                "address": { "addressCountry": "Remote" }
              },
              "url": "https://ingest-test.com/jobs/101"
            },
            {
              "@context": "https://schema.org",
              "@type": "JobPosting",
              "title": "Full Stack Developer",
              "identifier": {
                "@type": "PropertyValue",
                "name": "Acme",
                "value": "JOB-102"
              },
              "description": "Build high-performance web applications with React and Node.js.",
              "datePosted": "2026-09-18",
              "employmentType": "FULL_TIME",
              "jobLocation": {
                "@type": "Place",
                "address": { "addressCountry": "India" }
              },
              "url": "https://ingest-test.com/jobs/102"
            }
          ]
          </script>
        </head>
        <body><h1>Careers</h1></body>
      </html>
    `;

    // 3. First Crawl (Initial Ingestion)
    const run1 = await crawler.crawlSource({
      jobSourceId: jobSource.id,
      htmlOverride: sampleHtmlV1,
    });

    expect(run1.stats.fetched).toBe(2);
    expect(run1.stats.updated).toBe(2);
    expect(run1.stats.unchanged).toBe(0);
    expect(run1.insertedPostingIds.length).toBe(2);

    // Verify outbox events emitted
    const outboxAfterRun1 = await sql<{ id: string; payload: any }[]>`
      SELECT id, payload
      FROM platform.outbox_events
      WHERE entity_refs->>'sourceId' = ${jobSource.id}
    `;
    expect(outboxAfterRun1.length).toBe(2);

    // 4. Second Crawl (Identical HTML -> Idempotency Check)
    const run2 = await crawler.crawlSource({
      jobSourceId: jobSource.id,
      htmlOverride: sampleHtmlV1,
    });

    expect(run2.stats.fetched).toBe(2);
    expect(run2.stats.updated).toBe(0); // 0 new rows written
    expect(run2.stats.unchanged).toBe(2); // Exactly 2 unchanged no-ops
    expect(run2.insertedPostingIds.length).toBe(0);

    // Verify NO additional outbox events were emitted
    const outboxAfterRun2 = await sql<{ id: string }[]>`
      SELECT id
      FROM platform.outbox_events
      WHERE entity_refs->>'sourceId' = ${jobSource.id}
    `;
    expect(outboxAfterRun2.length).toBe(2);

    // 5. Third Crawl (Job 101 Description Modified -> Revision Ingestion)
    const sampleHtmlV2 = sampleHtmlV1.replace(
      'Develop scalable distributed backend services with TypeScript and PostgreSQL.',
      'Develop scalable distributed backend services with Go, TypeScript and PostgreSQL.'
    );

    const run3 = await crawler.crawlSource({
      jobSourceId: jobSource.id,
      htmlOverride: sampleHtmlV2,
    });

    expect(run3.stats.fetched).toBe(2);
    expect(run3.stats.updated).toBe(1); // 1 updated revision
    expect(run3.stats.unchanged).toBe(1); // 1 unchanged job (102)
    expect(run3.insertedPostingIds.length).toBe(1);

    // Verify 1 new outbox event emitted for the revised job
    const outboxAfterRun3 = await sql<{ id: string }[]>`
      SELECT id
      FROM platform.outbox_events
      WHERE entity_refs->>'sourceId' = ${jobSource.id}
    `;
    expect(outboxAfterRun3.length).toBe(3);
  });
});
