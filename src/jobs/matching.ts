import { randomUUID } from 'crypto';
import { sql, emitOutboxEvent } from '../db/index.js';
import { ExtractedRequirements } from './requirements.js';

export interface CandidateFact {
  id: string;
  candidateId: string;
  category: 'skill' | 'experience' | 'education' | 'project' | 'certification';
  statement: string;
  verified: boolean;
}

export interface MatchCriterionResult {
  criterion: string;
  result: 'met' | 'partial' | 'missing' | 'unknown';
  factIds: string[]; // Cited candidate fact IDs
  evidence: string[]; // Exact supporting phrases from facts
}

export interface MatchEvaluationResult {
  matchId: string;
  jobId: string;
  candidateId: string;
  score: number;
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  criteria: MatchCriterionResult[];
}

/**
 * Deterministically evaluates job requirements against candidate facts.
 * Anti-fabrication rule (HLD Part 2 §17): Every 'met' or 'partial' claim must cite a real candidate fact ID.
 */
export function evaluateCandidateFit(
  candidateFacts: CandidateFact[],
  requirements: ExtractedRequirements
): { score: number; verdict: 'PASS' | 'FAIL' | 'UNKNOWN'; criteria: MatchCriterionResult[] } {
  const criteria: MatchCriterionResult[] = [];
  const validFactIds = new Set(candidateFacts.map((f) => f.id));

  let metCount = 0;
  let partialCount = 0;
  const totalRequired = Math.max(requirements.requiredSkills.length, 1);

  // Evaluate each required skill
  for (const skill of requirements.requiredSkills) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const skillRegex = new RegExp(`\\b${escaped}\\b`, 'i');

    const matchingFacts = candidateFacts.filter(
      (f) => f.verified && skillRegex.test(f.statement)
    );

    if (matchingFacts.length > 0) {
      // Grounding Check: Ensure cited facts actually exist
      const citedIds = matchingFacts.map((f) => f.id).filter((id) => validFactIds.has(id));

      criteria.push({
        criterion: `Required Skill: ${skill}`,
        result: 'met',
        factIds: citedIds,
        evidence: matchingFacts.map((f) => f.statement),
      });
      metCount++;
    } else {
      criteria.push({
        criterion: `Required Skill: ${skill}`,
        result: 'missing',
        factIds: [],
        evidence: [],
      });
    }
  }

  // Evaluate preferred skills (bonus weight)
  for (const skill of requirements.preferredSkills) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const skillRegex = new RegExp(`\\b${escaped}\\b`, 'i');

    const matchingFacts = candidateFacts.filter(
      (f) => f.verified && skillRegex.test(f.statement)
    );

    if (matchingFacts.length > 0) {
      criteria.push({
        criterion: `Preferred Skill: ${skill}`,
        result: 'met',
        factIds: matchingFacts.map((f) => f.id),
        evidence: matchingFacts.map((f) => f.statement),
      });
      partialCount += 0.5;
    }
  }

  // Calculate deterministic score (0-100)
  const rawScore = ((metCount + partialCount) / totalRequired) * 100;
  const score = Math.min(Math.round(rawScore), 100);

  // Verdict logic: pass if >= 70% of requirements met and at least 1 core requirement matched
  let verdict: 'PASS' | 'FAIL' | 'UNKNOWN' = 'FAIL';
  if (score >= 70 && metCount > 0) {
    verdict = 'PASS';
  } else if (score >= 50) {
    verdict = 'UNKNOWN'; // Needs human or AI nuanced review
  }

  return { score, verdict, criteria };
}

export class MatchingService {
  /**
   * Runs explainable, anti-fabrication matching for a candidate against a job,
   * persists to jobs.job_matches & jobs.job_match_criteria, and emits outbox event.
   */
  async matchJob(jobId: string, candidateId: string): Promise<MatchEvaluationResult> {
    if (!sql) throw new Error('Database client not initialized');

    // 1. Fetch Candidate Facts
    const facts = await sql<CandidateFact[]>`
      SELECT id, candidate_id as "candidateId", category, statement, verified
      FROM profile.candidate_facts
      WHERE candidate_id = ${candidateId} AND verified = true
    `;

    // 2. Fetch Job Requirements
    const [reqRow] = await sql<{
      required_skills: string[];
      preferred_skills: string[];
      evidence: any[];
    }[]>`
      SELECT required_skills, preferred_skills, evidence
      FROM jobs.job_requirements
      WHERE job_id = ${jobId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const requirements: ExtractedRequirements = {
      requiredSkills: reqRow?.required_skills ?? [],
      preferredSkills: reqRow?.preferred_skills ?? [],
      evidence: reqRow?.evidence ?? [],
    };

    // 3. Deterministic Fit Analysis
    const evaluation = evaluateCandidateFit(facts, requirements);

    // 4. Atomic Database Persistence
    return await sql.begin(async (tx) => {
      const [match] = await tx<{ id: string }[]>`
        INSERT INTO jobs.job_matches (
          job_id,
          candidate_id,
          score,
          verdict
        ) VALUES (
          ${jobId},
          ${candidateId},
          ${evaluation.score},
          ${evaluation.verdict}
        )
        RETURNING id
      `;

      for (const crit of evaluation.criteria) {
        await tx`
          INSERT INTO jobs.job_match_criteria (
            match_id,
            criterion,
            result,
            fact_ids,
            evidence
          ) VALUES (
            ${match.id},
            ${crit.criterion},
            ${crit.result},
            ${tx.json(crit.factIds as any)},
            ${tx.json(crit.evidence as any)}
          )
        `;
      }

      // 5. Emit Outbox Event
      await emitOutboxEvent(tx, {
        type: 'JobMatched',
        producer: 'matching-service',
        correlationId: randomUUID(),
        idempotencyKey: `match:${match.id}`,
        entityRefs: {
          jobId,
          candidateId,
          matchId: match.id,
        },
        payload: {
          score: evaluation.score,
          verdict: evaluation.verdict,
          criteriaCount: evaluation.criteria.length,
        },
      });

      return {
        matchId: match.id,
        jobId,
        candidateId,
        score: evaluation.score,
        verdict: evaluation.verdict,
        criteria: evaluation.criteria,
      };
    });
  }
}

export const matchingService = new MatchingService();
