# Job Hunt Platform: LLD Starter v0.1

**Scope:** Phase 0–2 executable foundation. Core DDL (discovery → ingestion → processing → matching) plus the connector contract, validated against `vidushiinfotech.com/careers` (talent-pool) and `techmahindra.com/careers` (hub-to-spoke). Docs/apply/outreach tables are stubs here — full definitions live in `claude_system_design_part-4.md` §27–28.

**Conventions (from consolidated HLD):** one Postgres, schema per service; per-service least-privilege roles; UUIDv7-style time-ordered PKs (`gen_random_uuid()` below stands in until pg_uuidv7 is available `[LLD]`); `created_at/updated_at`; `row_version` on state rows; statuses via `CHECK`, never free text; FKs `ON DELETE RESTRICT`; no polymorphic refs (typed nullable FKs + one-of `CHECK`); append-only events/audit/versions/suppressions.

---

## 1. Extensions, schemas, roles

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS sched;
CREATE SCHEMA IF NOT EXISTS discovery;
CREATE SCHEMA IF NOT EXISTS ingest;
CREATE SCHEMA IF NOT EXISTS jobs;
CREATE SCHEMA IF NOT EXISTS docs;
CREATE SCHEMA IF NOT EXISTS apply;
CREATE SCHEMA IF NOT EXISTS outreach;
CREATE SCHEMA IF NOT EXISTS ai;
CREATE SCHEMA IF NOT EXISTS audit;

-- Per-service roles (passwords/secrets outside repo; GRANTs least-privilege)
-- Example pattern (repeat per service):
-- CREATE ROLE svc_control WITH LOGIN;
-- GRANT USAGE ON SCHEMA platform, sched TO svc_control;
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA platform, sched TO svc_control;
```

## 2. Platform + outbox (control-plane writes, relay publishes)

```sql
CREATE TABLE platform.outbox_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  version       int  NOT NULL DEFAULT 1,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  producer      text NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id  uuid,
  idempotency_key text NOT NULL,
  entity_refs   jsonb NOT NULL DEFAULT '{}',
  payload       jsonb NOT NULL DEFAULT '{}',
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_outbox_idempotency ON platform.outbox_events (idempotency_key);
CREATE INDEX ix_outbox_unpublished ON platform.outbox_events (occurred_at)
  WHERE published_at IS NULL;

CREATE TABLE platform.processed_events (
  consumer   text NOT NULL,
  event_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE platform.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit.audit_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action         text NOT NULL,
  actor_type     text NOT NULL CHECK (actor_type IN ('user','system','service')),
  entity_refs    jsonb NOT NULL DEFAULT '{}',
  correlation_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_time ON audit.audit_logs (created_at);
```

## 3. Scheduler (DB-backed, single-flight, coalescing)

```sql
CREATE TABLE sched.schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- one-of target: exactly one FK set (CHECK below)
  job_source_id uuid REFERENCES ingest.job_sources(id) ON DELETE RESTRICT,
  company_id    uuid REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  followup_id   uuid, -- FK to outreach follow-ups (defined in outreach stub)
  priority      int NOT NULL DEFAULT 100,
  base_cadence  interval NOT NULL,
  next_due_at   timestamptz NOT NULL,
  jitter        interval NOT NULL DEFAULT interval '5 minutes',
  backoff_until timestamptz,
  in_flight_since timestamptz,
  enabled       boolean NOT NULL DEFAULT true,
  last_outcome  text,
  row_version   int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_schedule_one_target CHECK (
    (job_source_id IS NOT NULL)::int +
    (company_id IS NOT NULL)::int +
    (followup_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX ix_sched_due ON sched.schedules (next_due_at) WHERE enabled;
```

## 4. Discovery (companies, career pages, fingerprints, site profiles)

```sql
CREATE TABLE discovery.companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_companies_trgm ON discovery.companies USING gin (name gin_trgm_ops);

CREATE TABLE discovery.company_domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  domain      text NOT NULL, -- stored normalised lowercase, no scheme/trailing dot
  verified    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_domain UNIQUE (domain)
);

CREATE TABLE discovery.career_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  url         text NOT NULL,
  page_class  text NOT NULL CHECK (page_class IN
    ('job-list','talent-pool','hub-to-spoke','unknown')),
  discovered_via text,
  last_crawled_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_career_page_url UNIQUE (url)
);

CREATE TABLE discovery.ats_fingerprints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  career_page_id uuid NOT NULL REFERENCES discovery.career_pages(id) ON DELETE RESTRICT,
  ats         text NOT NULL,   -- e.g. greenhouse, lever, ashby, workable, keka (one of many)
  tenant      text,
  evidence    jsonb NOT NULL DEFAULT '{}',
  confidence  text NOT NULL CHECK (confidence IN ('high','medium','low')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery.site_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  career_page_id uuid NOT NULL REFERENCES discovery.career_pages(id) ON DELETE RESTRICT,
  tier           text NOT NULL CHECK (tier IN ('jsonld','sitemap','static','render')),
  config         jsonb NOT NULL,  -- LLM-proposed, schema-validated, validator-tested
  success_rate   numeric,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Registry seed for the two reference targets
-- INSERT INTO discovery.companies (name) VALUES ('Vidushi Infotech'), ('Tech Mahindra');
-- INSERT INTO discovery.company_domains (company_id, domain, verified)
-- VALUES ((SELECT id FROM discovery.companies WHERE name='Vidushi Infotech'),'vidushiinfotech.com', true),
--        ((SELECT id FROM discovery.companies WHERE name='Tech Mahindra'),'techmahindra.com', true);
-- INSERT INTO discovery.career_pages (company_id, url, page_class) VALUES
--  ((SELECT id FROM discovery.companies WHERE name='Vidushi Infotech'),
--   'https://vidushiinfotech.com/careers/', 'talent-pool'),
--  ((SELECT id FROM discovery.companies WHERE name='Tech Mahindra'),
--   'https://www.techmahindra.com/careers/', 'hub-to-spoke');
```

## 5. Ingest (sources, runs, raw postings)

```sql
CREATE TABLE ingest.source_connectors (
  name        text PRIMARY KEY, -- greenhouse | lever | ashby | workable | keka | generic
  capabilities jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE ingest.job_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  connector    text NOT NULL REFERENCES ingest.source_connectors(name) ON DELETE RESTRICT,
  tenant       text,
  base_url     text NOT NULL,
  schedule     interval NOT NULL DEFAULT interval '12 hours',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingest.crawl_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_source_id uuid NOT NULL REFERENCES ingest.job_sources(id) ON DELETE RESTRICT,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  stats        jsonb NOT NULL DEFAULT '{}', -- new/updated/expired counts, failure class
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_crawl_runs_source_time ON ingest.crawl_runs (job_source_id, started_at);

CREATE TABLE ingest.raw_postings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    uuid NOT NULL REFERENCES ingest.job_sources(id) ON DELETE RESTRICT,
  crawl_run_id uuid REFERENCES ingest.crawl_runs(id) ON DELETE RESTRICT,
  external_id  text NOT NULL,
  content_hash text NOT NULL,
  payload      jsonb NOT NULL, -- raw connector payload; large bodies may live in object storage with pointer here
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_raw_posting UNIQUE (source_id, external_id, content_hash)
);
```

## 6. Jobs (canonical, links, requirements, embeddings, matches)

```sql
CREATE TABLE jobs.jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  title           text NOT NULL,
  role_family     text,
  seniority       text,
  location        jsonb NOT NULL DEFAULT '{}', -- {city, state, country, remote, workplaceType}
  employment_type text,
  salary          jsonb,   -- {min, max, currency}, nullable = unknown
  experience      jsonb,   -- {min, max}, nullable = unknown
  description     text NOT NULL, -- cleaned text
  apply_url       text NOT NULL, -- canonical per authority order
  posted_at       timestamptz,
  updated_at_src  timestamptz,
  status          text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','EXPIRED','REMOVED','UNKNOWN')),
  source_attribution jsonb NOT NULL DEFAULT '{}',
  search_tsv      tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(description,'')), 'C')
  ) STORED,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_jobs_company_status ON jobs.jobs (company_id, status);
CREATE INDEX ix_jobs_active ON jobs.jobs (last_seen_at) WHERE status = 'ACTIVE';
CREATE INDEX ix_jobs_search ON jobs.jobs USING gin (search_tsv);

CREATE TABLE jobs.job_source_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs.jobs(id) ON DELETE RESTRICT,
  source_id   uuid NOT NULL REFERENCES ingest.job_sources(id) ON DELETE RESTRICT,
  external_id text NOT NULL,
  source_url  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_job_source_link UNIQUE (source_id, external_id)
);

CREATE TABLE jobs.job_requirements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs.jobs(id) ON DELETE RESTRICT,
  required_skills  jsonb NOT NULL DEFAULT '[]',
  preferred_skills jsonb NOT NULL DEFAULT '[]',
  missing_skills   jsonb NOT NULL DEFAULT '[]',
  evidence    jsonb NOT NULL DEFAULT '[]', -- spans into description
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs.job_embeddings (
  job_id      uuid NOT NULL REFERENCES jobs.jobs(id) ON DELETE RESTRICT,
  model       text NOT NULL, -- model name + version, e.g. bge-small-en-v1.5
  embedding   vector(384) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, model)
);
-- CREATE INDEX ix_job_embeddings_hnsw ON jobs.job_embeddings
--   USING hnsw (embedding vector_cosine_ops); -- enable once pgvector version supports it [VERIFY]

CREATE TABLE jobs.job_matches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES jobs.jobs(id) ON DELETE RESTRICT,
  candidate_id uuid NOT NULL, -- FK to candidate_profiles (auth/profile schema, Phase 2)
  score        numeric,
  verdict      text NOT NULL CHECK (verdict IN ('PASS','FAIL','UNKNOWN')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs.job_match_criteria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id    uuid NOT NULL REFERENCES jobs.job_matches(id) ON DELETE RESTRICT,
  criterion   text NOT NULL,
  result      text NOT NULL CHECK (result IN ('met','partial','missing','unknown')),
  fact_ids    jsonb NOT NULL DEFAULT '[]', -- cited candidate fact IDs
  evidence    jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

## 7. AI cache + dead letters (gateway audit trail)

```sql
CREATE TABLE ai.ai_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task         text NOT NULL,
  prompt_id    text NOT NULL,
  prompt_version text NOT NULL,
  input_hash   text NOT NULL,
  sensitivity  text NOT NULL CHECK (sensitivity IN ('public','restricted')),
  provider     text,
  model        text,
  tokens       int,
  latency_ms   int,
  cache_key    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ai_requests_time ON ai.ai_requests (created_at);

CREATE TABLE ai.ai_outputs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES ai.ai_requests(id) ON DELETE RESTRICT,
  cache_key  text NOT NULL,
  output     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_output_cache UNIQUE (cache_key)
);

CREATE TABLE platform.dead_letters (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue      text NOT NULL,
  event_id   uuid,
  reason     text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_dlq_queue_time ON platform.dead_letters (queue, created_at);
```

## 8. Stubs (full DDL in Part 4)

`docs.resumes/resume_versions/artifacts`, `docs.cover_letters/cover_letter_versions`, `apply.engagements/approvals/applications/application_answers/application_runs`, `outreach.company_contacts/suppression_entries/campaigns/messages/threads/events` follow the same conventions (immutable versions, bound-approval hashes, partial unique against duplicate submits, hash-only suppressions). Implement when Phases 3–5 start.

---

## 9. Connector contract (TypeScript)

```typescript
// A connector serves MANY tenants/companies. Adding a company = registry row.
// Adding an ATS = one module + fingerprint rule + source_connectors row.

export type Confidence = 'high' | 'medium' | 'low';
export type PageClass = 'job-list' | 'talent-pool' | 'hub-to-spoke' | 'unknown';

export interface FingerprintResult {
  ats: string;            // greenhouse | lever | ashby | workable | keka | generic
  tenant?: string;        // e.g. spoke subdomain or path tenant
  confidence: Confidence;
  evidence: Record<string, unknown>;
}

export interface Source {
  id: string;             // ingest.job_sources.id
  companyId: string;
  connector: string;      // ingest.source_connectors.name
  tenant?: string;
  baseUrl: string;
}

export interface RawJob {
  externalId: string;
  sourceUrl: string;      // canonicalised, tracking params stripped
  applyUrl: string;
  payload: Record<string, unknown>;
  contentHash: string;    // sha256 of normalised payload
}

export interface CrawlStats {
  fetched: number; updated: number; unchanged: number;
  expired: number; failed: number; failureClass?: string;
}

export interface JobConnector {
  readonly name: string;  // must match ingest.source_connectors.name
  fingerprint(url: string, html?: string, headers?: Headers): Promise<FingerprintResult | null>;
  listJobs(source: Source, cursor?: string): Promise<{ jobs: RawJob[]; nextCursor?: string; stats: CrawlStats }>;
  getJob(source: Source, externalId: string): Promise<RawJob>;
  capabilities(): { incremental: boolean; expirySignal: boolean; };
}

// Registry wiring (data, not code)
export const connectors = [
  greenhouseConnector, leverConnector, ashbyConnector,
  workableConnector, kekaConnector, // Keka: one module among many, used only when fingerprinted
  genericCareerConnector,           // JSON-LD → sitemap → static+site_profile → render fallback
] satisfies JobConnector[];
```

**Fingerprint rules are data** (`discovery.ats_fingerprints` + config). Example rule shape:

```json
{
  "ats": "greenhouse",
  "match": { "hostSuffix": "greenhouse.io", "pathPrefix": "/v1/boards/" },
  "tenantFrom": "host_subdomain",
  "confidence": "high"
}
```

**Reference fixtures (Phase 1 spike must pass):**

```typescript
export const referenceFixtures = [
  {
    url: 'https://vidushiinfotech.com/careers/',
    expect: { pageClass: 'talent-pool', jobs: 0, formFields: ['name','email','mobile','role','experience','resume','consent'] },
  },
  {
    url: 'https://www.techmahindra.com/careers/',
    expect: { pageClass: 'hub-to-spoke', spoke: 'https://careers.techmahindra.com/', jobsOnHub: 0 },
  },
];
```

**Generic extractor order (no per-company code):** JSON-LD `JobPosting` → sitemap/feeds → static HTML + `site_profiles` config → Playwright render fallback → manual/paste. LLM output is a schema-validated `site_profiles.config`, never executed code; drift detection triggers re-learning. Form-only pages yield a form spec and zero jobs. Hub pages yield a spoke `job_source`, never jobs directly.

**Spike exit criteria (Phase 1):** both fixtures classify correctly; spoke jobs (or explicit zero-jobs with reason) appear in UI via outbox → queue → worker with trace; re-crawl unchanged content is a no-op per `uq_raw_posting`; `robots.txt`/terms checked and recorded per source.
