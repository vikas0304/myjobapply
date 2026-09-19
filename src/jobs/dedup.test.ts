import { describe, it, expect } from 'vitest';
import { sql } from '../db/index.js';
import { DeduplicationEngine } from './dedup.js';
import { DiscoveryService } from '../discovery/service.js';
import { normalizeJob } from './normalizer.js';

describe('Phase 2.2: Normalization & 4-Layer Deduplication Engine', () => {
  it('normalizes job attributes, classifies taxonomy, and generates signature hash', () => {
    const raw = {
      title: '<b>Senior</b> Fullstack Engineer (React / Node) 🚀',
      description: '<p>Join our remote engineering team building cloud services.</p>',
      applyUrl: 'https://acme.com/jobs/42?utm_source=linkedin&utm_medium=cpc&gh_src=123',
      location: { country: 'United States', workplaceType: 'remote' },
    };

    const norm = normalizeJob('comp-123', raw);

    expect(norm.title).toBe('Senior Fullstack Engineer (React / Node) 🚀');
    expect(norm.seniority).toBe('senior');
    expect(norm.roleFamily).toBe('fullstack');
    expect(norm.location.workplaceType).toBe('remote');
    expect(norm.location.country).toBe('united states');
    expect(norm.applyUrl).toBe('https://acme.com/jobs/42'); // Tracking params stripped
    expect(norm.signatureHash).toBeDefined();
    expect(norm.signatureHash.length).toBe(64);
  });

  it('verifies 4-layer deduplication against live database', async () => {
    if (!sql) {
      console.warn('Skipping test: No database connection');
      return;
    }

    const discoveryService = new DiscoveryService();
    const dedupEngine = new DeduplicationEngine();

    // 1. Setup Company
    const company = await discoveryService.registerCompany({
      name: `Dedup Test Corp ${Date.now()}`,
      domain: `deduptest-${Date.now()}.com`,
    });

    // 2. Setup Sources (e.g. Primary Career Page + 2 Aggregator Portals)
    const [src1] = await sql<{ id: string }[]>`
      INSERT INTO ingest.job_sources (company_id, connector, base_url)
      VALUES (${company.id}, 'generic', 'https://careers.acme.com')
      RETURNING id
    `;
    const [src2] = await sql<{ id: string }[]>`
      INSERT INTO ingest.job_sources (company_id, connector, base_url)
      VALUES (${company.id}, 'generic', 'https://linkedin.com/jobs')
      RETURNING id
    `;
    const [src3] = await sql<{ id: string }[]>`
      INSERT INTO ingest.job_sources (company_id, connector, base_url)
      VALUES (${company.id}, 'generic', 'https://indeed.com/jobs')
      RETURNING id
    `;

    // ------------------------------------------------------------------------
    // Step 1: Ingest Initial Job (Should create new canonical job)
    // ------------------------------------------------------------------------
    const res1 = await dedupEngine.processJob({
      sourceId: src1.id,
      companyId: company.id,
      externalId: 'REQ-1001',
      sourceUrl: 'https://careers.acme.com/job/1001',
      applyUrl: 'https://careers.acme.com/apply/1001',
      title: 'Senior Distributed Systems Engineer',
      description: 'Design and operate mission-critical backend systems in Go and PostgreSQL.',
      location: { country: 'Germany' },
    });

    expect(res1.isNew).toBe(true);
    expect(res1.matchedLayer).toBe(0);
    const canonicalJobId = res1.canonicalJobId;

    // ------------------------------------------------------------------------
    // Step 2: Layer 1 Dedup (Re-seeing same source + externalId)
    // ------------------------------------------------------------------------
    const res2 = await dedupEngine.processJob({
      sourceId: src1.id,
      companyId: company.id,
      externalId: 'REQ-1001',
      sourceUrl: 'https://careers.acme.com/job/1001',
      applyUrl: 'https://careers.acme.com/apply/1001',
      title: 'Senior Distributed Systems Engineer',
      description: 'Design and operate mission-critical backend systems in Go and PostgreSQL.',
      location: { country: 'Germany' },
    });

    expect(res2.isNew).toBe(false);
    expect(res2.matchedLayer).toBe(1);
    expect(res2.canonicalJobId).toBe(canonicalJobId);

    // ------------------------------------------------------------------------
    // Step 3: Layer 2 Dedup (Different Source, Same Apply URL)
    // ------------------------------------------------------------------------
    const res3 = await dedupEngine.processJob({
      sourceId: src2.id,
      companyId: company.id,
      externalId: 'LINKEDIN-999',
      sourceUrl: 'https://linkedin.com/jobs/view/999',
      applyUrl: 'https://careers.acme.com/apply/1001?utm_source=linkedin',
      title: 'Sr Systems Engineer',
      description: 'Same role reposted on LinkedIn with slightly different title',
      location: { country: 'Germany' },
    });

    expect(res3.isNew).toBe(false);
    expect(res3.matchedLayer).toBe(2);
    expect(res3.canonicalJobId).toBe(canonicalJobId);

    // ------------------------------------------------------------------------
    // Step 4: Layer 3 Dedup (Different Source & URL, Same Signature Hash)
    // ------------------------------------------------------------------------
    const res4 = await dedupEngine.processJob({
      sourceId: src3.id,
      companyId: company.id,
      externalId: 'INDEED-777',
      sourceUrl: 'https://indeed.com/viewjob?jk=777',
      applyUrl: 'https://indeed.com/apply/777', // Aggregator proxy apply url
      title: 'Senior Distributed Systems Engineer', // Same normalized title
      description: 'Reposted on Indeed with proxy URL',
      location: { country: 'Germany' }, // Same country -> identical signature_hash
    });

    expect(res4.isNew).toBe(false);
    expect(res4.matchedLayer).toBe(3);
    expect(res4.canonicalJobId).toBe(canonicalJobId);

    // Verify all 3 sources are linked to the single canonical job
    const links = await sql<{ source_id: string; external_id: string }[]>`
      SELECT source_id, external_id
      FROM jobs.job_source_links
      WHERE job_id = ${canonicalJobId}
    `;
    expect(links.length).toBe(3);

    // ------------------------------------------------------------------------
    // Step 5: Distinct Job (Different Role Title -> New Canonical Job)
    // ------------------------------------------------------------------------
    const res5 = await dedupEngine.processJob({
      sourceId: src1.id,
      companyId: company.id,
      externalId: 'REQ-2002',
      sourceUrl: 'https://careers.acme.com/job/2002',
      applyUrl: 'https://careers.acme.com/apply/2002',
      title: 'Staff AI / ML Engineer',
      description: 'Train and fine-tune foundation models.',
      location: { country: 'Germany' },
    });

    expect(res5.isNew).toBe(true);
    expect(res5.matchedLayer).toBe(0);
    expect(res5.canonicalJobId).not.toBe(canonicalJobId);
  });
});
