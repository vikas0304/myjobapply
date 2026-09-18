# [DEPRECATED] Final HLD — System Architecture

> **DEPRECATED — do not use.** Superseded by `claude_system_design_part-1.md` through `claude_system_design_part-4.md`. Kept for history only. Contains stale Keka fast-path — correct targets are generic career pages, e.g. `vidushiinfotech.com/careers` (talent-pool) and `techmahindra.com/careers` (hub-to-spoke).

# Enterprise System Design --- Personal Job Hunting Automation## Document Part 1: Architecture Blueprint, Boundary Specifications & Core Ingestion Pipeline## 1. Architectural Principles & Design DecisionsCloud-to-Local Network Inversion: The hosted frontend (Vercel) never initiates an inbound HTTP connection to the local environment. Managed cloud PostgreSQL serves as the persistent state broker. Local background workers initiate only outbound connections (long-polling message queues and querying PostgreSQL directly).Decoupled Event Choreography: Workers do not directly call downstream processing steps. Every lifecycle transition emits an immutable domain event to the message broker.Cost-Resilient Persistence Allocation: High-frequency polling state, volatile queues, and rate-limit locks live in Redis. High-volume prompt hashes, LLM completions, candidate data, and canonical job models reside in PostgreSQL. Binary artifacts (compiled PDFs, form screenshots) are stored in S3-compatible storage.Untrusted Content Sanitization Boundary: Job posting descriptions, ATS DOM markup, and arbitrary career page HTML are treated as potentially malicious untrusted text. They are scrubbed, stripped of instructions, and placed inside strict data delimiters to prevent prompt injection before reaching the AI Gateway.Multi-Tier Company & Career Page \### 8.1 Discovery Dedicated detection handles Indian and global ATS subdomains (such as Keka, Greenhouse, Lever, Ashby, and Workable). When given an endpoint like [vidushi.keka.com/careers/jobdetails/134085](https://vidushi.keka.com/careers/jobdetails/134085), the platform extracts the tenant identifier (vidushi), queries the native underlying JSON APIs directly, and avoids spinning up a headless browser whenever possible.## 2. Improved Logical Architecture Diagram\`\`\`mermaid

flowchart TB

    %% ==========================================

    %% 1. CLIENT & INTERACTION LAYER

    %% ==========================================

    subgraph CLIENT_LAYER \[Client & Interaction Layer\]

        USER\[User\]

        WEB\[Next.js Web Dashboard`\nHosted `{=tex}on Vercel\]

        EXT\[Browser Extension Sidecar`\nManifest `{=tex}V3 Local Tab
Engine\]

        USER --\> WEB

        USER --\> EXT

    end

    %% ==========================================

    %% 2. API & SCHEDULING COORDINATION

    %% ==========================================

    subgraph API_LAYER \[API & Coordination Layer\]

        BFF\[API Gateway / BFF`\nFastify `{=tex}/ Node.js\]

        SCHED\[Durable Ingestion Scheduler`\nPostgres `{=tex}Cron
State + Catch-up on Wake\]

        AUTH\[Auth & PII Tokenizer`\nData `{=tex}Masking & Redaction
Engine\]

        WEB \<--\> BFF

        BFF --\> AUTH

        SCHED --\> BUS

    end

    %% ==========================================

    %% 3. ASYNCHRONOUS EVENT BUS & QUEUES

    %% ==========================================

    subgraph EVENT_BROKER \[Event Broker & Distributed Queues\]

        BUS\[(Distributed Queue & Stream Engine`\nBullMQ `{=tex}/
Redis)\]

        DLQ\[(Dead Letter Queues`\nPoison `{=tex}Message & Failure
Triage)\]

        BUS --\> DLQ

    end

    BFF --\> BUS

    %% ==========================================

    %% 4. DISCOVERY & INGESTION ENGINE

    %% ==========================================

    subgraph INGESTION_ENGINE \[Company Discovery & Ingestion Workers\]

        direction TB

        DISCO_WORKER\[Company & Career Discovery
Worker`\nSubdomain`{=tex}, Sitemaps & ATS Fingerprinting\]

        subgraph ATS_CONNECTORS \[Direct API Connectors\]

            KEKA_CONN\[Keka Public API Connector`\nTenant`{=tex}-based
JSON endpoints\]

            GLOBAL_ATS\[Enterprise ATS Connectors`\nGreenhouse`{=tex},
Lever, Ashby, Workable\]

            PORTAL_CONN\[Job Portal Connectors`\nAdzuna`{=tex}, Jooble,
Open APIs\]

        end

        HEADLESS_CRAWLER\[Fallback Playwright Crawler`\nCustom `{=tex}JS
SPAs & Infinite Scrolls\]

        BUS --\> DISCO_WORKER

        DISCO_WORKER --\> BUS

        BUS --\> ATS_CONNECTORS

        BUS --\> HEADLESS_CRAWLER

    end

    %% ==========================================

    %% 5. PROCESSING, DEDUP & MATCHING

    %% ==========================================

    subgraph PROCESSING_ENGINE \[Normalization, Deduplication &
Matching\]

        direction TB

        NORM\[Canonical Normalizer`\nSchema `{=tex}Standardization\]

        subgraph DEDUP_PIPELINE \[Hierarchical Deduplication\]

            TIER1_DEDUP\[Tier 1: Native Apply URL / Platform Job ID\]

            TIER2_DEDUP\[Tier 2: Slug Hash`\nCompany `{=tex}+ Title +
Location\]

            TIER3_DEDUP\[Tier 3: Vector Cosine
Similarity`\nIn`{=tex}-Memory Transformers.js Embeddings\]

            TIER1_DEDUP --\> TIER2_DEDUP --\> TIER3_DEDUP

        end

        subgraph MATCH_PIPELINE \[Two-Pass Match Engine\]

            PASS1_RULES\[Pass 1: Deterministic Rules`\nYoE`{=tex},
Location/Remote, Tech Stack Floor\]

            PASS2_AI\[Pass 2: AI Match Reasoner`\nGap `{=tex}Extraction
& Semantic Fit Score\]

            PASS1_RULES --\> PASS2_AI

        end

        NORM --\> DEDUP_PIPELINE

        DEDUP_PIPELINE --\> MATCH_PIPELINE

    end

    ATS_CONNECTORS --\>\|JobRawDiscovered\| BUS

    HEADLESS_CRAWLER --\>\|JobRawDiscovered\| BUS

    BUS --\> NORM

    MATCH_PIPELINE --\>\|JobMatched / Shortlisted\| BUS

    %% ==========================================

    %% 6. RESUME & TAILORING ENGINE

    %% ==========================================

    subgraph RESUME_ENGINE \[Resume Tailoring & Compilation Engine\]

        direction TB

        RES_WORKER\[Resume Tailoring Worker`\nTruthful `{=tex}Skill &
Project Reordering\]

        LATEX_WORKER\[Sandboxed pdflatex
Worker`\nIsolated `{=tex}Container Execution\]

        BUS --\> RES_WORKER

        RES_WORKER --\> LATEX_WORKER

        LATEX_WORKER --\>\|ResumeCompiled\| BUS

    end

    %% ==========================================

    %% 7. APPLICATION AUTOMATION & HUMAN-IN-THE-LOOP

    %% ==========================================

    subgraph APPLICATION_ENGINE \[Application Dispatch & Execution
Engine\]

        direction TB

        APP_WORKER\[Application Prep Worker`\nDOM `{=tex}Inspection &
Field Classifier\]

        APPROVAL_GATE\[Human-in-the-Loop Review
Gate`\nDiff `{=tex}Inspection & Manual Edits\]

        HEADLESS_SUBMIT\[Local Headless Playwright
Worker`\nSimple `{=tex}/ Permitted Auto-Submissions\]

        BUS --\> APP_WORKER

        APP_WORKER --\> APPROVAL_GATE

        APPROVAL_GATE --\>\|ApplicationApproved\| BUS

        BUS -.-\>\|Path 1: Automated Dispatch\| HEADLESS_SUBMIT

        BUS -.-\>\|Path 2: Assisted Draft Sync\| EXT

    end

    %% ==========================================

    %% 8. AI GATEWAY WITH RESILIENCE & SANITIZATION

    %% ==========================================

    subgraph AI_GATEWAY \[Secure AI Gateway & Provider Fallback\]

        direction TB

        SANITIZER\[Input Sanitizer & Delimiter
Frame`\nPrompt `{=tex}Injection Mitigation\]

        RATE_LIMIT\[Token Bucket Rate Limiter`\nRPM `{=tex}& Concurrency
Guard\]

        subgraph PROVIDER_CASCADE \[Multi-Provider Failover Matrix\]

            OPENROUTER\[Primary: OpenRouter Free Pool`\nLlama 3.3`{=tex}
70B / Qwen 2.5 72B\]

            GROQ_FALLBACK\[Secondary: Groq API Free
Tier`\nLlama 3.1`{=tex} 70B Versatile\]

            GEMINI_FALLBACK\[Tertiary: Google AI
Studio`\nGemini 2.0`{=tex} Flash\]

            OPENROUTER --\>\|429 / Down\| GROQ_FALLBACK --\>\|429 /
Down\| GEMINI_FALLBACK

        end

        VALIDATOR\[Strict Schema Validator`\nJSON `{=tex}Repair & Format
Enforcement\]

        SANITIZER --\> RATE_LIMIT --\>\`\`\`

Here is **Part 1** of the High-Level Design (HLD), incorporating
career-page crawling (such as Keka, Greenhouse, and Lever portals) and
an improved logical architecture.

------------------------------------------------------------------------

**\## 3. Core Architecture Principles**

-   \*\*\*\*Outbound-Only Local Hybrid:\*\*\*\* Local execution workers
    poll managed cloud infrastructure (Postgres/Supabase and Queue). No
    inbound tunnels, public ports, or brittle webhooks expose your local
    machine.

-   \*\*\*\*Separation of Concerns:\*\*\*\* Distinct failure and scaling
    boundaries for cheap API connectors, dynamic HTML/JS scrapers, heavy
    browser automation, and AI transforms.

-   \*\*\*\*Event-Driven Pub/Sub:\*\*\*\* All state progressions emit
    explicit domain events. No hidden in-memory couplings.

-   \*\*\*\*Resilience First:\*\*\*\* Dedicated Dead Letter Queues
    (DLQ), retry backoffs, circuit breakers at boundary points, and
    idempotency guarantees.

-   \*\*\*\*Deterministic Pre-Filters:\*\*\*\* Regex, canonical URLs,
    and schema lookups run before dispatching to LLM gateways,
    conserving token quotas and avoiding prompt-injection attacks.

------------------------------------------------------------------------

**\## 4. Service Boundaries & Responsibilities**

-   \*\*\*\*Cloud Orchestration & State Layer (Managed Cloud / \$0
    Tier)\*\*\*\*

  \* \*\*\*\*Next.js Web UI:\*\*\*\* Dashboard, review gates, manual
overrides, and metrics visualization.

  \* \*\*\*\*Central State Store (Postgres / Supabase):\*\*\*\*
Canonical entities, state machine tables, run-logs, prompt cache, and
audit history.

  \* \*\*\*\*Event / Job Broker (Upstash / Redis Queue):\*\*\*\* Durable
dispatch queues and event topics.

-   \*\*\*\*Ingestion Subsystem\*\*\*\*

  \* \*\*\*\*API Pull Worker:\*\*\*\* Polls structured API feeds
(standard job boards, Aggregators).

  \* \*\*\*\*ATS & Portal Scraper:\*\*\*\* Lightweight, headless HTTP
parser targeting structured JSON payloads and standard endpoints (Keka
internal APIs, Lever, Greenhouse, Workday endpoints).

  \* \*\*\*\*Dynamic Browser Scraper (Playwright/Browserless):\*\*\*\*
Fallback parser for heavy client-side SPAs that lack open JSON
endpoints.

-   \*\*\*\*Processing & Matching Pipeline\*\*\*\*

  \* \*\*\*\*Normalization Worker:\*\*\*\* Maps raw job structures into
unified canonical schemas; extracts ATS identifiers and tracking links.

  \* \*\*\*\*Tiered Dedup Worker:\*\*\*\* Tier 1: Canonical Apply URL /
native ATS ID hash. Tier 2: Normalized company name + stripped role
title. Tier 3: Embedding similarity vector search.

  \* \*\*\*\*Two-Pass Match Engine:\*\*\*\* Pass 1: Hard deterministic
filters (location, stack match, salary floor, visa requirements). Pass
2: Semantic AI ranking (scoring via AI Gateway).

-   \*\*\*\*Execution & Outreach Subsystem\*\*\*\*

  \* \*\*\*\*Human-in-the-Loop Review Gate:\*\*\*\* UI-based
approve/reject transition before any resume generation or job
submission.

  \* \*\*\*\*AI Gateway:\*\*\*\* Circuit breaker, rate limiter, retry
budget manager, schema validation, and outbound sanitization.

  \* \*\*\*\*Artifact Generator (LaTeX Worker):\*\*\*\* Sandboxed
compilation of dynamically tailored resumes and cover letters.

  \* \*\*\*\*Application Submitter:\*\*\*\* Human-assisted browser
automation or form-filler engine running through deterministic field
heuristics before falling back to an LLM.

------------------------------------------------------------------------

**\## 5. Complete Logical Architecture**

\`\`\`mermaid

flowchart TB

    %% STYLING

    classDef client
fill:#e0f2fe,stroke:#0284c7,stroke-width:2px,color:#0369a1;

    classDef cloud
fill:#f0fdf4,stroke:#16a34a,stroke-width:2px,color:#15803d;

    classDef local
fill:#fefce8,stroke:#ca8a04,stroke-width:2px,color:#a16207;

    classDef worker
fill:#f3e8ff,stroke:#9333ea,stroke-width:2px,color:#6b21a8;

    classDef storage
fill:#f1f5f9,stroke:#475569,stroke-width:2px,color:#334155;

    classDef deadletter
fill:#fee2e2,stroke:#dc2626,stroke-width:2px,color:#991b1b;

    subgraph CLIENT_TIER \["Client & Interface Layer"\]

        UI\["Web UI & Dashboard (Vercel)"\]:::client

        ReviewQueue\["Human Review Gate UI"\]:::client

    end

    subgraph DATA_PERSISTENCE \["Durable Cloud State (\$0 Tier)"\]

        DB\[(PostgreSQL / Supabase)\]:::storage

        MessageBus\[\["Durable Event Broker / Queues"\]\]:::storage

        DLQ\[\["System DLQ"\]\]:::deadletter

    end

    subgraph INGESTION_TIER \["Ingestion & Discovery Subsystem"\]

        DirCrawler\["Company & Career-Page Discovery"\]:::worker

        ATSScraper\["ATS & Portal Scraper`\n`{=tex}(Keka, Greenhouse,
Lever)"\]:::worker

        BrowserCrawler\["Dynamic SPA Crawler`\n`{=tex}(Playwright
Pool)"\]:::worker

        APIWorker\["Standard Job API Worker"\]:::worker

    end

    subgraph NORMALIZATION_MATCHING \["Processing & Qualification
Engine"\]

        Normalizer\["Job Normalizer & Canonicalizer"\]:::worker

        DedupEngine\["Tiered Dedup`\n`{=tex}(URL -\> Hash -\>
Embeddings)"\]:::worker

        TwoPassMatch\["Two-Pass Matching`\n`{=tex}(1. Deterministic -\>
2. AI Score)"\]:::worker

    end

    subgraph AI_ROUTING \["Governance & Transformation Layer"\]

        AIGateway\["AI Gateway`\n`{=tex}(Rate Limiter, Validator,
Circuit Breaker)"\]:::worker

        ModelProviders\["Config-Driven LLM Providers"\]:::cloud

    end

    subgraph EXECUTION_TIER \["Execution & Artifact Engine"\]

        ResumeEngine\["Resume & Cover Letter
Generator`\n`{=tex}(Sandboxed LaTeX)"\]:::worker

        ApplyWorker\["Automated Application
Submitter`\n`{=tex}(Playwright + Form Autofill)"\]:::worker

        OutreachWorker\["Email & Contact Outreach Engine"\]:::worker

    end

    %% INGESTION FLOW

    DirCrawler --\>\|"Discovered Job URL"\| MessageBus

    ATSScraper --\>\|"Raw Extracted Payload"\| MessageBus

    BrowserCrawler --\>\|"Raw HTML / Rendered DOM"\| MessageBus

    APIWorker --\>\|"API Feed Item"\| MessageBus

    %% NORMALIZATION & DEDUP

    MessageBus --\>\|"Job Ingested Event"\| Normalizer

    Normalizer --\> DedupEngine

    DedupEngine --\>\|"Duplicate Found"\| DB

    DedupEngine --\>\|"Unique Job Event"\| MessageBus

    %% MATCHING

    MessageBus --\>\|"Match Ready Event"\| TwoPassMatch

    TwoPassMatch --\>\|"Semantic Request"\| AIGateway

    TwoPassMatch --\>\|"Candidate Matched Event"\| MessageBus

    TwoPassMatch --\>\|"Failed Criteria"\| DB

    %% REVIEW GATE & PERSISTENCE

    MessageBus --\>\|"Pending Review Event"\| DB

    UI \<--\> DB

    ReviewQueue --\>\|"Approve / Reject Action"\| DB

    DB --\>\|"Job Approved Event"\| MessageBus

    %% EXECUTION

    MessageBus --\>\|"Approved Application Event"\| ResumeEngine

    ResumeEngine --\>\|"Tailor Resume Request"\| AIGateway

    ResumeEngine --\>\|"Artifacts Compiled"\| MessageBus

    MessageBus --\>\|"Submit Form Event"\| ApplyWorker

    ApplyWorker --\>\|"Form Inference (Fallback)"\| AIGateway

    ApplyWorker --\>\|"Submission Status Update"\| DB

    MessageBus --\>\|"Direct Outreach Event"\| OutreachWorker

    %% AI GATEWAY EGRESS

    AIGateway \<--\> ModelProviders

    %% FAILURE HANDLING

    Normalizer -.-\>\|"Parse Failure"\| DLQ

    DedupEngine -.-\>\|"Exception"\| DLQ

    TwoPassMatch -.-\>\|"Failure"\| DLQ

    AIGateway -.-\>\|"Exhausted Retries"\| DLQ

    ApplyWorker -.-\>\|"DOM Failure"\| DLQ

## 6. Event Catalogue

| Event Name \| Producer \| Payload Essentials \| Consumer(s) \|

\|---\|---\|---\|---\|job.discoveredIngestion Subsystemsource_url,
source_type, portal_fingerprintScraper Router /
Workersjob.raw_extractedScrapers / API Pullersraw_payload,
source_metadata, scraped_atNormalizer Workerjob.normalizedNormalizer
Workercanonical_url, title, company, location, description_rawDedup
Workerjob.dedupedDedup Workerjob_id, dedup_tier_matched,
is_uniqueTwo-Pass Match Enginejob.matchedTwo-Pass Match Enginejob_id,
deterministic_score, ai_score, match_reasonsState Store / Review
Queuejob.approvedReview Queue (UI)job_id, user_id, target_profile_id,
review_timestampResume Worker, Outreach Workerartifact.generatedLaTeX
Workerjob_id, resume_pdf_url, cover_letter_text, checksumApplication
Submitterapplication.submittedApplication Submitterjob_id,
submission_channel, status_code, screenshot_urlDB / Notification
Serviceapplication.failedAny Subsystem Nodejob_id, stage, error_stack,
retry_countSystem DLQ
## 7. Career-Page Extraction Pipeline\[Target URL
(e.g.,
[vidushi.keka.com/careers/jobdetails/134085](https://vidushi.keka.com/careers/jobdetails/134085))\]

                      │

                      ▼

            \[ATS Fingerprinting\]

   ├── Detect subdomains: *.keka.com, *.greenhouse.io, \*.lever.co

   └── Inspect DOM scripts / schema.org JSON-LD tags

                      │

        ┌─────────────┴─────────────┐

        ▼                           ▼

\[Known ATS / Structured API\]   \[Unknown Custom Career Portal\]

  - Query direct internal API     - Spin up Headless Chromium
(Playwright)

    (e.g., Keka job detail API)   - Wait for network idle / dynamic
hydration

  - Fetch raw structured JSON     - Deterministic extraction:

  - Zero browser overhead          
```{=html}
<h1>
```
, meta tags, schema.org Microdata

        │                           │

        └─────────────┬─────────────┘

                      ▼

           \[Job Normalizer Worker\]

Fingerprinting & Routing: The discovery layer checks domain patterns
(\*.keka.com, boards.greenhouse.io, jobs.lever.co). For
vidushi.keka.com, it flags the source as a Keka portal.Direct API Pull
(Fast-Path): Keka career pages dynamically hydrate using an
unauthenticated public JSON endpoint (e.g.,
/api/careers/jobdetails/{id}). The worker pulls this directly using
standard HTTP clients, bypassing Playwright entirely to save memory and
CPU cycles.Dynamic SPA Fallback: If the endpoint is blocked,
authenticated, or obfuscated, the task delegates to a pooled Chromium
instance that intercepts responses or parses the client-rendered
DOM.Canonical Sanitization: Content is stripped of tracking parameters,
company-specific CSS classes, and boilerplate disclaimer elements before
reaching the normalization pipeline.
## 8. End-to-End Processing Lifecycle
### 8.1 Discovery The scraper targets configured career
domains, discovering new job postings and emitting job.discovered.
### 8.2 Extraction Depending on the portal fingerprint, an API fetcher or
Playwright worker extracts the raw job details and publishes
job.raw_extracted.### 8.3 Sanitization & Normalization The raw payload
maps to a canonical schema (stripping tracking query params, formatting
location, normalizing salary ranges).Three-Tier Dedup:Tier 1: Match on
canonical URL or portal-native ID (e.g., Keka job ID 134085).Tier 2:
Hash check on SHA256(company_normalized + title_normalized).Tier 3:
Vector similarity via dense embeddings to intercept cross-board
reposts.Two-Pass Match Qualification:Pass 1 (Deterministic): Location
checks, minimum experience filters, hard skill requirements.Pass 2
(Semantic): For items clearing Pass 1, the AI Gateway evaluates resume
alignment against job descriptions and scores relevance.
### 8.6 Approval
& Gate Matched jobs persist to Postgres and surface in the Next.js
review dashboard. The job moves forward only when a human approves
it.
### 8.7 Artifact Tailoring Sandboxed LaTeX workers generate a
tailored resume and cover letter targeting the posting's core
competencies.### 8.8 Submission Engine Local workers read approved jobs
and use deterministic DOM field locators (falling back to the AI Gateway
for unmapped inputs) to fill and submit the application.
