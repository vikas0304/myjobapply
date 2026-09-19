export type Confidence = 'high' | 'medium' | 'low';
export type PageClass = 'job-list' | 'talent-pool' | 'hub-to-spoke' | 'unknown';

export interface FingerprintResult {
  ats: string;                     // greenhouse | lever | ashby | workable | keka | generic
  tenant?: string;                 // Subdomain or path tenant
  confidence: Confidence;
  pageClass: PageClass;
  spokeUrl?: string;               // Emitted for hub-to-spoke (e.g. techmahindra.com -> careers.techmahindra.com)
  formSpec?: {
    formFields: string[];
    actionUrl?: string;
    hasResumeUpload: boolean;
  };                               // Emitted for talent-pool form-only pages (e.g. vidushiinfotech.com)
  evidence: Record<string, unknown>;
}

export interface Source {
  id: string;                      // ingest.job_sources.id
  companyId: string;
  connector: string;               // ingest.source_connectors.name
  tenant?: string;
  baseUrl: string;
}

export interface RawJob {
  externalId: string;
  sourceUrl: string;               // Canonicalised, tracking params stripped
  applyUrl: string;
  title: string;
  description?: string;
  location?: Record<string, unknown>;
  payload: Record<string, unknown>;
  contentHash: string;             // sha256 of normalised payload
}

export interface CrawlStats {
  fetched: number; 
  updated: number; 
  unchanged: number;
  expired: number; 
  failed: number; 
  failureClass?: string;
}

export interface DiscoveredSource {
  url: string;
  pageClass: PageClass;
  spokeUrl?: string;
}

export interface JobConnector {
  readonly name: string;           // Must match ingest.source_connectors.name
  fingerprint(url: string, html?: string, headers?: Headers): Promise<FingerprintResult | null>;
  listJobs(source: Source, cursor?: string): Promise<{ 
    jobs: RawJob[]; 
    nextCursor?: string; 
    stats: CrawlStats;
    discoveredSources?: DiscoveredSource[];
  }>;
  getJob(source: Source, externalId: string): Promise<RawJob>;
  capabilities(): { incremental: boolean; expirySignal: boolean; };
}
