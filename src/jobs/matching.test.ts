import { describe, it, expect } from 'vitest';
import { sql } from '../db/index.js';
import { evaluateCandidateFit, MatchingService, CandidateFact } from './matching.js';
import { DiscoveryService } from '../discovery/service.js';
import { DeduplicationEngine } from './dedup.js';
import { RequirementsService } from './requirements.js';

describe('Phase 2.4: Candidate Matching & Anti-Fabrication Engine', () => {
  it('strictly grounds all match criteria in verified candidate facts', () => {
    const facts: CandidateFact[] = [
      {
        id: 'fact-001',
        candidateId: 'cand-1',
        category: 'skill',
        statement: 'Extensive production experience writing TypeScript services.',
        verified: true,
      },
      {
        id: 'fact-002',
        candidateId: 'cand-1',
        category: 'skill',
        statement: 'Designed complex relational schemas in PostgreSQL with indexes.',
        verified: true,
      },
    ];

    const requirements = {
      requiredSkills: ['typescript', 'postgresql', 'rust'],
      preferredSkills: ['docker'],
      evidence: [],
    };

    const result = evaluateCandidateFit(facts, requirements);

    expect(result.criteria.length).toBe(3);

    // TypeScript Criterion
    const tsCriterion = result.criteria.find((c) => c.criterion.includes('typescript'));
    expect(tsCriterion?.result).toBe('met');
    expect(tsCriterion?.factIds).toEqual(['fact-001']);
    expect(tsCriterion?.evidence[0]).toContain('TypeScript');

    // PostgreSQL Criterion
    const pgCriterion = result.criteria.find((c) => c.criterion.includes('postgresql'));
    expect(pgCriterion?.result).toBe('met');
    expect(pgCriterion?.factIds).toEqual(['fact-002']);

    // Rust Criterion (Missing - must cite zero facts)
    const rustCriterion = result.criteria.find((c) => c.criterion.includes('rust'));
    expect(rustCriterion?.result).toBe('missing');
    expect(rustCriterion?.factIds).toEqual([]);

    // 2 out of 3 met = 67%
    expect(result.score).toBe(67);
    expect(result.verdict).toBe('UNKNOWN');
  });

  it('persists match evaluation and criteria with outbox event to Supabase', async () => {
    if (!sql) {
      console.warn('Skipping test: No database connection');
      return;
    }

    const discoveryService = new DiscoveryService();
    const dedupEngine = new DeduplicationEngine();
    const reqService = new RequirementsService();
    const matchService = new MatchingService();

    // 1. Create Candidate Profile & Verified Facts
    const [candidate] = await sql<{ id: string }[]>`
      INSERT INTO profile.candidate_profiles (full_name, email)
      VALUES ('Vikas Pal', 'vikas@example.com')
      RETURNING id
    `;

    const [fact1] = await sql<{ id: string }[]>`
      INSERT INTO profile.candidate_facts (candidate_id, category, statement, verified)
      VALUES (
        ${candidate.id},
        'skill',
        'Built enterprise microservices using TypeScript, Node.js, and PostgreSQL.',
        true
      )
      RETURNING id
    `;

    const [fact2] = await sql<{ id: string }[]>`
      INSERT INTO profile.candidate_facts (candidate_id, category, statement, verified)
      VALUES (
        ${candidate.id},
        'skill',
        'Configured Docker containers and CI/CD deployment pipelines.',
        true
      )
      RETURNING id
    `;

    // 2. Create Job & Requirements
    const company = await discoveryService.registerCompany({
      name: `Match Test Corp ${Date.now()}`,
      domain: `matchtest-${Date.now()}.com`,
    });

    const [src] = await sql<{ id: string }[]>`
      INSERT INTO ingest.job_sources (company_id, connector, base_url)
      VALUES (${company.id}, 'generic', 'https://matchtest.com/careers')
      RETURNING id
    `;

    const job = await dedupEngine.processJob({
      sourceId: src.id,
      companyId: company.id,
      externalId: `MATCH-JOB-${Date.now()}`,
      sourceUrl: 'https://matchtest.com/job/42',
      applyUrl: 'https://matchtest.com/apply/42',
      title: 'Full Stack Engineer',
      description: 'Requirements: Strong knowledge of TypeScript and PostgreSQL. Nice to have: Docker.',
    });

    await reqService.processJobRequirements(
      job.canonicalJobId,
      'Requirements: Strong knowledge of TypeScript and PostgreSQL. Nice to have: Docker.'
    );

    // 3. Execute Matching
    const matchResult = await matchService.matchJob(job.canonicalJobId, candidate.id);

    expect(matchResult.matchId).toBeDefined();
    expect(matchResult.score).toBeGreaterThanOrEqual(70);
    expect(matchResult.verdict).toBe('PASS');

    // 4. Verify Database Persistence in jobs.job_matches
    const [matchRow] = await sql<{ score: number; verdict: string }[]>`
      SELECT score, verdict
      FROM jobs.job_matches
      WHERE id = ${matchResult.matchId}
    `;
    expect(Number(matchRow.score)).toBeGreaterThanOrEqual(70);
    expect(matchRow.verdict).toBe('PASS');

    // 5. Verify Criteria link to actual candidate fact IDs
    const criteriaRows = await sql<{ criterion: string; result: string; fact_ids: string[] }[]>`
      SELECT criterion, result, fact_ids
      FROM jobs.job_match_criteria
      WHERE match_id = ${matchResult.matchId}
    `;

    expect(criteriaRows.length).toBeGreaterThan(0);
    const tsCrit = criteriaRows.find((c) => c.criterion.includes('typescript'));
    expect(tsCrit?.result).toBe('met');
    expect(tsCrit?.fact_ids).toContain(fact1.id);

    // 6. Verify Outbox Event
    const outboxRows = await sql<{ id: string; payload: any }[]>`
      SELECT id, payload
      FROM platform.outbox_events
      WHERE entity_refs->>'matchId' = ${matchResult.matchId}
    `;
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].payload.verdict).toBe('PASS');
  });
});
