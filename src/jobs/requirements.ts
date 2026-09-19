import { randomUUID } from 'crypto';
import { sql, emitOutboxEvent } from '../db/index.js';

export interface ExtractedRequirements {
  requiredSkills: string[];
  preferredSkills: string[];
  experienceYears?: { min?: number; max?: number };
  evidence: Array<{ skill: string; evidenceText: string; isRequired: boolean }>;
}

export interface HardFilterEvaluation {
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  reasons: string[];
}

export const COMMON_TECH_SKILLS = [
  'typescript', 'javascript', 'python', 'go', 'golang', 'rust', 'java', 'c++', 'c#',
  'react', 'next.js', 'vue', 'angular', 'node.js', 'express', 'nestjs', 'fastapi', 'django',
  'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'supabase',
  'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'terraform', 'graphql', 'rest', 'grpc',
  'vitest', 'jest', 'playwright', 'cypress', 'git', 'ci/cd', 'linux'
];

/**
 * Deterministically extracts skills, experience years, and evidence spans from job text.
 * Follows HLD principle: cheapest deterministic extraction first before LLM enrichment.
 */
export function extractRequirementsFromText(description: string): ExtractedRequirements {
  const requiredSkills: Set<string> = new Set();
  const preferredSkills: Set<string> = new Set();
  const evidence: Array<{ skill: string; evidenceText: string; isRequired: boolean }> = [];

  // 1. Detect experience years (e.g. "5+ years", "3-5 years of experience")
  let minExp: number | undefined;
  let maxExp: number | undefined;

  const expRangeMatch = description.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*(?:\+)?\s*years?(?:\s+of)?\s*(?:experience)?/i);
  if (expRangeMatch) {
    minExp = parseInt(expRangeMatch[1], 10);
    maxExp = parseInt(expRangeMatch[2], 10);
  } else {
    const singleExpMatch = description.match(/(\d+)\s*\+\s*years?(?:\s+of)?\s*(?:experience)?/i);
    if (singleExpMatch) {
      minExp = parseInt(singleExpMatch[1], 10);
    }
  }

  // 2. Identify clauses & sections (split by lines or sentence boundaries)
  const clauses = description.split(/\n+|(?<=[.;])\s+/);
  let currentSectionIsPreferred = false;

  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause) continue;

    if (/\b(preferred|nice to have|bonus|plus|desired|optional)\b/i.test(clause)) {
      currentSectionIsPreferred = true;
    } else if (/\b(required|requirements|qualifications|must have|minimum|what you bring)\b/i.test(clause)) {
      currentSectionIsPreferred = false;
    }

    for (const skill of COMMON_TECH_SKILLS) {
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const skillRegex = new RegExp(`\\b${escaped}\\b`, 'i');

      if (skillRegex.test(clause)) {
        // If the clause specifically starts with or mentions preferred, it's preferred
        const isPreferredClause =
          currentSectionIsPreferred || /\b(preferred|nice to have|bonus|plus|optional)\b/i.test(clause);
        const isReq = !isPreferredClause;

        if (isReq) {
          requiredSkills.add(skill);
        } else {
          preferredSkills.add(skill);
        }

        evidence.push({
          skill,
          evidenceText: clause.slice(0, 150),
          isRequired: isReq,
        });
      }
    }
  }

  // Required wins if a skill is mentioned in both contexts
  for (const req of requiredSkills) {
    preferredSkills.delete(req);
  }
  for (const req of requiredSkills) {
    preferredSkills.delete(req);
  }

  return {
    requiredSkills: Array.from(requiredSkills),
    preferredSkills: Array.from(preferredSkills),
    experienceYears: minExp !== undefined ? { min: minExp, max: maxExp } : undefined,
    evidence,
  };
}

/**
 * Deterministic Hard Filter Evaluation (HLD §17).
 * Evaluates candidate attributes against extracted requirements before AI enrichment.
 */
export function evaluateHardFilters(
  requirements: ExtractedRequirements,
  candidate: {
    totalExperienceYears: number;
    skills: string[];
    allowedWorkplaceTypes?: string[];
    jobWorkplaceType?: string;
  }
): HardFilterEvaluation {
  const reasons: string[] = [];

  // Check 1: Experience Years Hard Filter
  if (requirements.experienceYears?.min !== undefined) {
    if (candidate.totalExperienceYears < requirements.experienceYears.min) {
      reasons.push(
        `Insufficient experience: Job requires min ${requirements.experienceYears.min} years, candidate has ${candidate.totalExperienceYears} years`
      );
    }
  }

  // Check 2: Workplace Type Hard Filter
  if (
    candidate.allowedWorkplaceTypes &&
    candidate.jobWorkplaceType &&
    candidate.jobWorkplaceType !== 'unknown'
  ) {
    if (!candidate.allowedWorkplaceTypes.includes(candidate.jobWorkplaceType)) {
      reasons.push(
        `Workplace mismatch: Job is ${candidate.jobWorkplaceType}, candidate accepts [${candidate.allowedWorkplaceTypes.join(', ')}]`
      );
    }
  }

  if (reasons.length > 0) {
    return { verdict: 'FAIL', reasons };
  }

  return { verdict: 'PASS', reasons: ['All deterministic hard filters satisfied'] };
}

export class RequirementsService {
  /**
   * Extracts requirements, persists to jobs.job_requirements, and emits outbox event.
   */
  async processJobRequirements(jobId: string, description: string) {
    if (!sql) throw new Error('Database client not initialized');

    const extracted = extractRequirementsFromText(description);

    return await sql.begin(async (tx) => {
      const [record] = await tx<{ id: string }[]>`
        INSERT INTO jobs.job_requirements (
          job_id,
          required_skills,
          preferred_skills,
          evidence
        ) VALUES (
          ${jobId},
          ${tx.json(extracted.requiredSkills as any)},
          ${tx.json(extracted.preferredSkills as any)},
          ${tx.json(extracted.evidence as any)}
        )
        RETURNING id
      `;

      await emitOutboxEvent(tx, {
        type: 'JobRequirementsExtracted',
        producer: 'requirements-service',
        correlationId: randomUUID(),
        idempotencyKey: `req:${jobId}`,
        entityRefs: { jobId, requirementsId: record.id },
        payload: {
          requiredCount: extracted.requiredSkills.length,
          preferredCount: extracted.preferredSkills.length,
          minExperience: extracted.experienceYears?.min,
        },
      });

      return {
        requirementsId: record.id,
        extracted,
      };
    });
  }
}

export const requirementsService = new RequirementsService();
