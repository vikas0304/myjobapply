import { randomUUID } from 'crypto';
import { sql, emitOutboxEvent } from '../db/index.js';
import { normalizeJob } from './normalizer.js';

export interface ProcessRawPostingInput {
  sourceId: string;
  companyId: string;
  externalId: string;
  sourceUrl: string;
  applyUrl: string;
  title: string;
  description?: string;
  location?: any;
  payload?: Record<string, unknown>;
}

export interface DedupOutcome {
  canonicalJobId: string;
  matchedLayer: number; // 0 = new job, 1 = source identity, 2 = apply url, 3 = signature hash
  isNew: boolean;
}

export class DeduplicationEngine {
  /**
   * Resolves a raw posting against existing jobs in 4 hierarchical layers.
   * If a match is found at any layer, links the source without creating a duplicate job.
   */
  async processJob(input: ProcessRawPostingInput): Promise<DedupOutcome> {
    if (!sql) throw new Error('Database client not initialized');

    const normalized = normalizeJob(input.companyId, {
      title: input.title,
      description: input.description,
      applyUrl: input.applyUrl,
      location: input.location,
      payload: input.payload,
    });

    return await sql.begin(async (tx) => {
      // ----------------------------------------------------------------------
      // Layer 1: Source Identity Match (source_id + external_id)
      // ----------------------------------------------------------------------
      const [layer1Match] = await tx<{ job_id: string }[]>`
        SELECT job_id 
        FROM jobs.job_source_links
        WHERE source_id = ${input.sourceId} AND external_id = ${input.externalId}
      `;

      if (layer1Match) {
        await tx`
          UPDATE jobs.jobs
          SET last_seen_at = now()
          WHERE id = ${layer1Match.job_id}
        `;
        return {
          canonicalJobId: layer1Match.job_id,
          matchedLayer: 1,
          isNew: false,
        };
      }

      // ----------------------------------------------------------------------
      // Layer 2: Canonical Apply URL Match (within same company)
      // ----------------------------------------------------------------------
      const [layer2Match] = await tx<{ id: string }[]>`
        SELECT id 
        FROM jobs.jobs
        WHERE company_id = ${input.companyId}
          AND apply_url = ${normalized.applyUrl}
          AND status = 'ACTIVE'
        LIMIT 1
      `;

      if (layer2Match) {
        await tx`
          INSERT INTO jobs.job_source_links (
            job_id,
            source_id,
            external_id,
            source_url
          ) VALUES (
            ${layer2Match.id},
            ${input.sourceId},
            ${input.externalId},
            ${input.sourceUrl}
          )
          ON CONFLICT (source_id, external_id) DO NOTHING
        `;
        await tx`
          UPDATE jobs.jobs
          SET last_seen_at = now()
          WHERE id = ${layer2Match.id}
        `;
        return {
          canonicalJobId: layer2Match.id,
          matchedLayer: 2,
          isNew: false,
        };
      }

      // ----------------------------------------------------------------------
      // Layer 3: Content Fingerprint Match (signature_hash within company)
      // ----------------------------------------------------------------------
      const [layer3Match] = await tx<{ id: string }[]>`
        SELECT id 
        FROM jobs.jobs
        WHERE company_id = ${input.companyId}
          AND signature_hash = ${normalized.signatureHash}
          AND status = 'ACTIVE'
        LIMIT 1
      `;

      if (layer3Match) {
        await tx`
          INSERT INTO jobs.job_source_links (
            job_id,
            source_id,
            external_id,
            source_url
          ) VALUES (
            ${layer3Match.id},
            ${input.sourceId},
            ${input.externalId},
            ${input.sourceUrl}
          )
          ON CONFLICT (source_id, external_id) DO NOTHING
        `;
        await tx`
          UPDATE jobs.jobs
          SET last_seen_at = now()
          WHERE id = ${layer3Match.id}
        `;
        return {
          canonicalJobId: layer3Match.id,
          matchedLayer: 3,
          isNew: false,
        };
      }

      // ----------------------------------------------------------------------
      // New Canonical Job: Create canonical job row & initial source link
      // ----------------------------------------------------------------------
      const [newJob] = await tx<{ id: string }[]>`
        INSERT INTO jobs.jobs (
          company_id,
          title,
          signature_hash,
          role_family,
          seniority,
          location,
          employment_type,
          description,
          apply_url,
          status,
          source_attribution
        ) VALUES (
          ${input.companyId},
          ${normalized.title},
          ${normalized.signatureHash},
          ${normalized.roleFamily ?? null},
          ${normalized.seniority ?? null},
          ${tx.json(normalized.location as any)},
          ${normalized.employmentType ?? null},
          ${normalized.description},
          ${normalized.applyUrl},
          'ACTIVE',
          ${tx.json({ primarySourceId: input.sourceId } as any)}
        )
        RETURNING id
      `;

      await tx`
        INSERT INTO jobs.job_source_links (
          job_id,
          source_id,
          external_id,
          source_url
        ) VALUES (
          ${newJob.id},
          ${input.sourceId},
          ${input.externalId},
          ${input.sourceUrl}
        )
      `;

      // Emit JobCanonicalized outbox event
      await emitOutboxEvent(tx, {
        type: 'JobCanonicalized',
        producer: 'deduplication-engine',
        correlationId: randomUUID(),
        idempotencyKey: `job:${newJob.id}`,
        entityRefs: {
          jobId: newJob.id,
          companyId: input.companyId,
          sourceId: input.sourceId,
        },
        payload: {
          title: normalized.title,
          roleFamily: normalized.roleFamily,
          seniority: normalized.seniority,
          signatureHash: normalized.signatureHash,
          applyUrl: normalized.applyUrl,
        },
      });

      return {
        canonicalJobId: newJob.id,
        matchedLayer: 0,
        isNew: true,
      };
    });
  }
}

export const deduplicationEngine = new DeduplicationEngine();
