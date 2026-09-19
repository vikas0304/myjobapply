import { describe, it, expect } from 'vitest';
import { sql } from '../db/index.js';
import {
  extractRequirementsFromText,
  evaluateHardFilters,
  RequirementsService,
} from './requirements.js';
import { DiscoveryService } from '../discovery/service.js';
import { DeduplicationEngine } from './dedup.js';

describe('Phase 2.3: Deterministic Requirements Extraction & Hard Filters', () => {
  it('extracts required and preferred skills with evidence text and experience bounds', () => {
    const jobDescription = `
      About the Role:
      We are looking for a Senior Distributed Systems Engineer.
      
      Requirements:
      - 5+ years of experience building production backend systems.
      - Strong proficiency in TypeScript and Go.
      - Hands-on experience with PostgreSQL and Docker.
      
      Nice to Have:
      - Familiarity with GraphQL and Redis caching.
      - Experience with Kubernetes.
    `;

    const extracted = extractRequirementsFromText(jobDescription);

    expect(extracted.experienceYears?.min).toBe(5);
    expect(extracted.requiredSkills).toContain('typescript');
    expect(extracted.requiredSkills).toContain('go');
    expect(extracted.requiredSkills).toContain('postgresql');
    expect(extracted.requiredSkills).toContain('docker');

    expect(extracted.preferredSkills).toContain('graphql');
    expect(extracted.preferredSkills).toContain('redis');
    expect(extracted.preferredSkills).toContain('kubernetes');

    // Verify evidence spans
    expect(extracted.evidence.length).toBeGreaterThan(0);
    const tsEvidence = extracted.evidence.find((e) => e.skill === 'typescript');
    expect(tsEvidence?.isRequired).toBe(true);
    expect(tsEvidence?.evidenceText).toContain('TypeScript');
  });

  it('evaluates deterministic hard filters with three-valued logic', () => {
    const reqs = extractRequirementsFromText(`
      Requirements:
      - 5+ years of experience with Python.
    `);

    // Candidate 1: Junior with 2 years (FAIL)
    const failCandidate = evaluateHardFilters(reqs, {
      totalExperienceYears: 2,
      skills: ['python'],
      allowedWorkplaceTypes: ['remote'],
      jobWorkplaceType: 'remote',
    });
    expect(failCandidate.verdict).toBe('FAIL');
    expect(failCandidate.reasons[0]).toContain('Insufficient experience');

    // Candidate 2: Workplace mismatch (onsite job vs remote candidate)
    const locationFail = evaluateHardFilters(reqs, {
      totalExperienceYears: 6,
      skills: ['python'],
      allowedWorkplaceTypes: ['remote'],
      jobWorkplaceType: 'onsite',
    });
    expect(locationFail.verdict).toBe('FAIL');
    expect(locationFail.reasons[0]).toContain('Workplace mismatch');

    // Candidate 3: Senior meeting all criteria (PASS)
    const passCandidate = evaluateHardFilters(reqs, {
      totalExperienceYears: 7,
      skills: ['python'],
      allowedWorkplaceTypes: ['remote', 'hybrid'],
      jobWorkplaceType: 'remote',
    });
    expect(passCandidate.verdict).toBe('PASS');
  });

  it('persists job requirements and emits outbox event in Supabase', async () => {
    if (!sql) {
      console.warn('Skipping test: No database connection');
      return;
    }

    const discoveryService = new DiscoveryService();
    const dedupEngine = new DeduplicationEngine();
    const reqService = new RequirementsService();

    // 1. Create Company and Job
    const company = await discoveryService.registerCompany({
      name: `Req Test Corp ${Date.now()}`,
      domain: `reqtest-${Date.now()}.com`,
    });

    const [src] = await sql<{ id: string }[]>`
      INSERT INTO ingest.job_sources (company_id, connector, base_url)
      VALUES (${company.id}, 'generic', 'https://reqtest.com/careers')
      RETURNING id
    `;

    const job = await dedupEngine.processJob({
      sourceId: src.id,
      companyId: company.id,
      externalId: `REQ-${Date.now()}`,
      sourceUrl: 'https://reqtest.com/job/1',
      applyUrl: 'https://reqtest.com/apply/1',
      title: 'Senior Cloud Engineer',
      description: 'Requirements: 4+ years of experience with AWS and Terraform. Preferred: Kubernetes.',
    });

    // 2. Extract and Persist Requirements
    const outcome = await reqService.processJobRequirements(
      job.canonicalJobId,
      'Requirements: 4+ years of experience with AWS and Terraform. Preferred: Kubernetes.'
    );

    expect(outcome.requirementsId).toBeDefined();
    expect(outcome.extracted.requiredSkills).toContain('aws');
    expect(outcome.extracted.requiredSkills).toContain('terraform');
    expect(outcome.extracted.preferredSkills).toContain('kubernetes');

    // 3. Verify in Database
    const [row] = await sql<{ required_skills: string[]; preferred_skills: string[] }[]>`
      SELECT required_skills, preferred_skills
      FROM jobs.job_requirements
      WHERE id = ${outcome.requirementsId}
    `;
    expect(row.required_skills).toEqual(expect.arrayContaining(['aws', 'terraform']));
    expect(row.preferred_skills).toEqual(expect.arrayContaining(['kubernetes']));

    // 4. Verify Outbox Event
    const outbox = await sql<{ id: string; payload: any }[]>`
      SELECT id, payload
      FROM platform.outbox_events
      WHERE entity_refs->>'requirementsId' = ${outcome.requirementsId}
    `;
    expect(outbox.length).toBe(1);
    expect(outbox[0].payload.minExperience).toBe(4);
  });
});
