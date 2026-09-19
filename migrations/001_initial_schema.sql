-- Migration: 001_initial_schema.sql
-- Description: Phase 0-2 Database Foundation (Extensions, Schemas, Platform, Discovery, Ingestion, Scheduler, Profile, Jobs, AI Gateway)
-- Compatible with: Local PostgreSQL (pgvector/pgvector:pg16) and Supabase Cloud PostgreSQL

-- ============================================================================
-- 1. EXTENSIONS & SCHEMAS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS discovery;
CREATE SCHEMA IF NOT EXISTS ingest;
CREATE SCHEMA IF NOT EXISTS sched;
CREATE SCHEMA IF NOT EXISTS profile;
CREATE SCHEMA IF NOT EXISTS jobs;
CREATE SCHEMA IF NOT EXISTS docs;
CREATE SCHEMA IF NOT EXISTS apply;
CREATE SCHEMA IF NOT EXISTS outreach;
CREATE SCHEMA IF NOT EXISTS ai;

-- ============================================================================
-- 2. PLATFORM, AUDIT & OUTBOX
-- ============================================================================

CREATE TABLE platform.outbox_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,
  version         int  NOT NULL DEFAULT 1,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  producer        text NOT NULL,
  correlation_id  uuid NOT NULL,
  causation_id    uuid,
  idempotency_key text NOT NULL,
  entity_refs     jsonb NOT NULL DEFAULT '{}',
  payload         jsonb NOT NULL DEFAULT '{}',
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_idempotency ON platform.outbox_events (idempotency_key);
CREATE INDEX IF NOT EXISTS ix_outbox_unpublished ON platform.outbox_events (occurred_at)
  WHERE published_at IS NULL;

CREATE TABLE platform.processed_events (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE platform.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.dead_letters (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue      text NOT NULL,
  event_id   uuid,
  reason     text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_dlq_queue_time ON platform.dead_letters (queue, created_at);

CREATE TABLE audit.audit_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action         text NOT NULL,
  actor_type     text NOT NULL CHECK (actor_type IN ('user','system','service')),
  entity_refs    jsonb NOT NULL DEFAULT '{}',
  correlation_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_time ON audit.audit_logs (created_at);

-- ============================================================================
-- 3. DISCOVERY PIPELINE
-- ============================================================================

CREATE TABLE discovery.companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS ix_companies_trgm ON discovery.companies USING gin (name gin_trgm_ops);

CREATE TABLE discovery.company_domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  domain      text NOT NULL, -- normalized lowercase, no scheme or trailing dot
  verified    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_domain UNIQUE (domain)
);

CREATE TABLE discovery.career_pages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  parent_page_id uuid REFERENCES discovery.career_pages(id) ON DELETE RESTRICT, -- Supports hub -> spoke lineage
  url            text NOT NULL,
  page_class     text NOT NULL CHECK (page_class IN ('job-list','talent-pool','hub-to-spoke','unknown')),
  spoke_url      text,  -- Recorded for hub-to-spoke pages
  form_spec      jsonb, -- Recorded for talent-pool form-only pages
  discovered_via text,
  last_crawled_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_career_page_url UNIQUE (url)
);

CREATE TABLE discovery.ats_fingerprints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  career_page_id uuid NOT NULL REFERENCES discovery.career_pages(id) ON DELETE RESTRICT,
  ats            text NOT NULL, -- greenhouse | lever | ashby | workable | keka | generic
  tenant         text,
  evidence       jsonb NOT NULL DEFAULT '{}',
  confidence     text NOT NULL CHECK (confidence IN ('high','medium','low')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery.site_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  career_page_id uuid NOT NULL REFERENCES discovery.career_pages(id) ON DELETE RESTRICT,
  tier           text NOT NULL CHECK (tier IN ('jsonld','sitemap','static','render')),
  config         jsonb NOT NULL, -- Schema-validated JSON config from AI
  success_rate   numeric,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 4. INGESTION PIPELINE
-- ============================================================================

CREATE TABLE ingest.source_connectors (
  name         text PRIMARY KEY, -- greenhouse | lever | ashby | workable | keka | generic
  capabilities jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE ingest.job_sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  connector         text NOT NULL REFERENCES ingest.source_connectors(name) ON DELETE RESTRICT,
  tenant            text,
  base_url          text NOT NULL,
  schedule          interval NOT NULL DEFAULT interval '12 hours',
  compliance_status jsonb NOT NULL DEFAULT '{"robots_checked": false, "allowed": true}',
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingest.crawl_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_source_id uuid NOT NULL REFERENCES ingest.job_sources(id) ON DELETE RESTRICT,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  stats         jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_crawl_runs_source_time ON ingest.crawl_runs (job_source_id, started_at);

CREATE TABLE ingest.raw_postings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    uuid NOT NULL REFERENCES ingest.job_sources(id) ON DELETE RESTRICT,
  crawl_run_id uuid REFERENCES ingest.crawl_runs(id) ON DELETE RESTRICT,
  external_id  text NOT NULL,
  content_hash text NOT NULL,
  payload      jsonb, -- Nullable when offloaded to object storage (claim-check pattern)
  storage_uri  text,  -- URI pointer to object storage (S3/GCS/Supabase Storage)
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_raw_posting UNIQUE (source_id, external_id, content_hash),
  CONSTRAINT chk_raw_payload_or_uri CHECK (payload IS NOT NULL OR storage_uri IS NOT NULL)
);

-- ============================================================================
-- 5. SCHEDULER
-- ============================================================================

CREATE TABLE sched.schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_source_id    uuid REFERENCES ingest.job_sources(id) ON DELETE RESTRICT,
  company_id       uuid REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  followup_id      uuid,
  priority         int NOT NULL DEFAULT 100,
  base_cadence     interval NOT NULL,
  next_due_at      timestamptz NOT NULL,
  jitter           interval NOT NULL DEFAULT interval '5 minutes',
  backoff_until    timestamptz,
  in_flight_since  timestamptz,
  lease_expires_at timestamptz, -- Worker crash recovery timeout
  locked_by        text,        -- Worker instance ID holding lease
  enabled          boolean NOT NULL DEFAULT true,
  last_outcome     text,
  row_version      int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_schedule_one_target CHECK (
    (job_source_id IS NOT NULL)::int +
    (company_id IS NOT NULL)::int +
    (followup_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX IF NOT EXISTS ix_sched_due ON sched.schedules (next_due_at) WHERE enabled;

-- ============================================================================
-- 6. PROFILE & CANDIDATE FACT STORE
-- ============================================================================

CREATE TABLE profile.candidate_profiles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name  text NOT NULL,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profile.candidate_facts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES profile.candidate_profiles(id) ON DELETE RESTRICT,
  category     text NOT NULL CHECK (category IN ('skill','experience','education','project','certification')),
  statement    text NOT NULL,
  verified     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_candidate_facts_lookup ON profile.candidate_facts (candidate_id, category);

CREATE TABLE profile.fact_embeddings (
  fact_id    uuid NOT NULL REFERENCES profile.candidate_facts(id) ON DELETE RESTRICT,
  model      text NOT NULL,
  embedding  vector(384) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fact_id, model)
);

-- ============================================================================
-- 7. CANONICAL JOBS, DEDUPLICATION & MATCHING
-- ============================================================================

CREATE TABLE jobs.jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES discovery.companies(id) ON DELETE RESTRICT,
  title              text NOT NULL,
  signature_hash     text NOT NULL, -- Layer 3 dedup: sha256(company_id + normalized_title + location)
  role_family        text,
  seniority          text,
  location           jsonb NOT NULL DEFAULT '{}',
  employment_type    text,
  salary             jsonb,
  experience         jsonb,
  description        text NOT NULL,
  apply_url          text NOT NULL,
  posted_at          timestamptz,
  updated_at_src     timestamptz,
  status             text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','EXPIRED','REMOVED','UNKNOWN')),
  source_attribution jsonb NOT NULL DEFAULT '{}',
  search_tsv         tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(description,'')), 'C')
  ) STORED,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_jobs_signature ON jobs.jobs (signature_hash) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_jobs_company_status ON jobs.jobs (company_id, status);
CREATE INDEX IF NOT EXISTS ix_jobs_active ON jobs.jobs (last_seen_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_jobs_search ON jobs.jobs USING gin (search_tsv);

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
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES jobs.jobs(id) ON DELETE RESTRICT,
  required_skills  jsonb NOT NULL DEFAULT '[]',
  preferred_skills jsonb NOT NULL DEFAULT '[]',
  missing_skills   jsonb NOT NULL DEFAULT '[]',
  evidence         jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs.job_embeddings (
  job_id     uuid NOT NULL REFERENCES jobs.jobs(id) ON DELETE RESTRICT,
  model      text NOT NULL,
  embedding  vector(384) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, model)
);

CREATE TABLE jobs.job_matches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES jobs.jobs(id) ON DELETE RESTRICT,
  candidate_id uuid NOT NULL REFERENCES profile.candidate_profiles(id) ON DELETE RESTRICT,
  score        numeric,
  verdict      text NOT NULL CHECK (verdict IN ('PASS','FAIL','UNKNOWN')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs.job_match_criteria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id    uuid NOT NULL REFERENCES jobs.job_matches(id) ON DELETE RESTRICT,
  criterion   text NOT NULL,
  result      text NOT NULL CHECK (result IN ('met','partial','missing','unknown')),
  fact_ids    jsonb NOT NULL DEFAULT '[]', -- strictly cited candidate_facts IDs
  evidence    jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 8. AI GATEWAY CACHE
-- ============================================================================

CREATE TABLE ai.ai_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task           text NOT NULL,
  prompt_id      text NOT NULL,
  prompt_version text NOT NULL,
  input_hash     text NOT NULL,
  sensitivity    text NOT NULL CHECK (sensitivity IN ('public','restricted')),
  provider       text,
  model          text,
  tokens         int,
  latency_ms     int,
  cache_key      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ai_requests_time ON ai.ai_requests (created_at);

CREATE TABLE ai.ai_outputs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES ai.ai_requests(id) ON DELETE RESTRICT,
  cache_key  text NOT NULL,
  output     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_output_cache UNIQUE (cache_key)
);
