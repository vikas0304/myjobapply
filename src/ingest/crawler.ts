import { randomUUID } from 'crypto';
import { sql, emitOutboxEvent } from '../db/index.js';
import { JobConnector, Source, RawJob, CrawlStats } from '../connectors/types.js';
import { genericCareerConnector } from '../connectors/generic.js';

export interface ExecuteCrawlOptions {
  jobSourceId: string;
  connector?: JobConnector;
  htmlOverride?: string; // Used for deterministic fixture testing
}

export interface CrawlExecutionResult {
  crawlRunId: string;
  jobSourceId: string;
  stats: CrawlStats;
  insertedPostingIds: string[];
}

export class IngestionCrawler {
  private connectors: Map<string, JobConnector> = new Map();

  constructor() {
    this.registerConnector(genericCareerConnector);
  }

  registerConnector(connector: JobConnector) {
    this.connectors.set(connector.name, connector);
  }

  /**
   * Idempotently crawls a job source and saves raw postings.
   * Enforces uq_raw_posting (source_id, external_id, content_hash):
   * unchanged content produces 0 writes and 0 outbox events.
   */
  async crawlSource(options: ExecuteCrawlOptions): Promise<CrawlExecutionResult> {
    if (!sql) throw new Error('Database client not initialized');

    // 1. Fetch source details from DB
    const [sourceRow] = await sql<{
      id: string;
      company_id: string;
      connector: string;
      tenant: string | null;
      base_url: string;
    }[]>`
      SELECT id, company_id, connector, tenant, base_url
      FROM ingest.job_sources
      WHERE id = ${options.jobSourceId}
    `;

    if (!sourceRow) {
      throw new Error(`Job source ${options.jobSourceId} not found`);
    }

    const source: Source = {
      id: sourceRow.id,
      companyId: sourceRow.company_id,
      connector: sourceRow.connector,
      tenant: sourceRow.tenant ?? undefined,
      baseUrl: sourceRow.base_url,
    };

    const connector =
      options.connector ?? this.connectors.get(source.connector) ?? genericCareerConnector;

    // 2. Initialize crawl_runs record
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO ingest.crawl_runs (job_source_id, started_at)
      VALUES (${source.id}, now())
      RETURNING id
    `;
    const crawlRunId = run.id;

    const stats: CrawlStats = {
      fetched: 0,
      updated: 0,
      unchanged: 0,
      expired: 0,
      failed: 0,
    };
    const insertedPostingIds: string[] = [];

    try {
      // 3. Fetch jobs from connector
      const { jobs, stats: fetchStats } = await (connector as any).listJobs(
        source,
        undefined,
        options.htmlOverride
      );

      stats.fetched = jobs.length;
      if (fetchStats.failed > 0) {
        stats.failed = fetchStats.failed;
        stats.failureClass = fetchStats.failureClass;
      }

      // 4. Process each raw job in a single atomic transaction
      await sql.begin(async (tx) => {
        for (const job of jobs) {
          // Idempotent insert: only inserts if content_hash is new for this external_id
          const [inserted] = await tx<{ id: string }[]>`
            INSERT INTO ingest.raw_postings (
              source_id,
              crawl_run_id,
              external_id,
              content_hash,
              payload
            ) VALUES (
              ${source.id},
              ${crawlRunId},
              ${job.externalId},
              ${job.contentHash},
              ${tx.json(job.payload as any)}
            )
            ON CONFLICT (source_id, external_id, content_hash) DO NOTHING
            RETURNING id
          `;

          if (inserted) {
            stats.updated++;
            insertedPostingIds.push(inserted.id);

            // Emit JobDiscovered outbox event
            await emitOutboxEvent(tx, {
              type: 'JobDiscovered',
              producer: 'ingestion-crawler',
              correlationId: randomUUID(),
              idempotencyKey: `raw_posting:${source.id}:${job.externalId}:${job.contentHash}`,
              entityRefs: {
                sourceId: source.id,
                companyId: source.companyId,
                rawPostingId: inserted.id,
              },
              payload: {
                externalId: job.externalId,
                contentHash: job.contentHash,
                title: job.title,
                applyUrl: job.applyUrl,
              },
            });
          } else {
            // Unchanged raw posting
            stats.unchanged++;
          }
        }

        // 5. Finalize crawl_runs record
        await tx`
          UPDATE ingest.crawl_runs
          SET 
            finished_at = now(),
            stats = ${tx.json(stats as any)}
          WHERE id = ${crawlRunId}
        `;
      });
    } catch (error) {
      stats.failed++;
      stats.failureClass = error instanceof Error ? error.message : 'UnknownCrawlError';

      await sql`
        UPDATE ingest.crawl_runs
        SET 
          finished_at = now(),
          stats = ${sql.json(stats as any)}
        WHERE id = ${crawlRunId}
      `;
      throw error;
    }

    return {
      crawlRunId,
      jobSourceId: source.id,
      stats,
      insertedPostingIds,
    };
  }
}

export const ingestionCrawler = new IngestionCrawler();
