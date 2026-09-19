import { randomUUID } from 'crypto';
import { sql, emitOutboxEvent } from '../db/index.js';
import { classifyCareerPage } from './fingerprint.js';
import { FingerprintResult } from '../connectors/types.js';

export interface RegisterCompanyInput {
  name: string;
  domain: string;
}

export interface ProcessCareerPageInput {
  companyId: string;
  url: string;
  html: string;
  parentPageId?: string;
}

export class DiscoveryService {
  /**
   * Registers a company and its normalized domain.
   */
  async registerCompany(input: RegisterCompanyInput) {
    if (!sql) throw new Error('Database client not initialized');
    const normalizedDomain = input.domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    return await sql.begin(async (tx) => {
      const [company] = await tx`
        INSERT INTO discovery.companies (name)
        VALUES (${input.name})
        RETURNING id, name, created_at
      `;

      await tx`
        INSERT INTO discovery.company_domains (company_id, domain, verified)
        VALUES (${company.id}, ${normalizedDomain}, true)
        ON CONFLICT (domain) DO UPDATE SET company_id = EXCLUDED.company_id
      `;

      await emitOutboxEvent(tx, {
        type: 'CompanyDiscovered',
        producer: 'discovery-service',
        correlationId: randomUUID(),
        idempotencyKey: `company:${company.id}`,
        entityRefs: { companyId: company.id },
        payload: { name: company.name, domain: normalizedDomain },
      });

      return company;
    });
  }

  /**
   * Classifies a career page, records the fingerprint, and emits an outbox event.
   */
  async processCareerPage(input: ProcessCareerPageInput): Promise<{
    pageId: string;
    classification: FingerprintResult;
    childSpokeId?: string;
  }> {
    if (!sql) throw new Error('Database client not initialized');
    const classification = classifyCareerPage({ url: input.url, html: input.html });
    const correlationId = randomUUID();

    return await sql.begin(async (tx) => {
      // 1. Insert or update career_pages
      const [page] = await tx`
        INSERT INTO discovery.career_pages (
          company_id,
          parent_page_id,
          url,
          page_class,
          spoke_url,
          form_spec,
          last_crawled_at
        ) VALUES (
          ${input.companyId},
          ${input.parentPageId ?? null},
          ${input.url},
          ${classification.pageClass},
          ${classification.spokeUrl ?? null},
          ${classification.formSpec ? tx.json(classification.formSpec) : null},
          now()
        )
        ON CONFLICT (url) DO UPDATE SET
          page_class = EXCLUDED.page_class,
          spoke_url = EXCLUDED.spoke_url,
          form_spec = EXCLUDED.form_spec,
          last_crawled_at = now(),
          updated_at = now()
        RETURNING id, company_id, url, page_class
      `;

      // 2. Insert ats_fingerprints
      await tx`
        INSERT INTO discovery.ats_fingerprints (
          career_page_id,
          ats,
          tenant,
          evidence,
          confidence
        ) VALUES (
          ${page.id},
          ${classification.ats},
          ${classification.tenant ?? null},
          ${tx.json(classification.evidence as any)},
          ${classification.confidence}
        )
      `;

      let childSpokeId: string | undefined;

      // 3. If hub-to-spoke, register the child spoke page
      if (classification.pageClass === 'hub-to-spoke' && classification.spokeUrl) {
        const [spokePage] = await tx`
          INSERT INTO discovery.career_pages (
            company_id,
            parent_page_id,
            url,
            page_class,
            discovered_via
          ) VALUES (
            ${input.companyId},
            ${page.id},
            ${classification.spokeUrl},
            'unknown',
            'hub-to-spoke-discovery'
          )
          ON CONFLICT (url) DO UPDATE SET parent_page_id = EXCLUDED.parent_page_id
          RETURNING id
        `;
        childSpokeId = spokePage?.id;
      }

      // 4. Emit outbox event
      await emitOutboxEvent(tx, {
        type: 'CareerPageFingerprinted',
        producer: 'discovery-service',
        correlationId,
        idempotencyKey: `fingerprint:${page.id}:${Date.now()}`,
        entityRefs: { companyId: input.companyId, pageId: page.id },
        payload: {
          url: page.url,
          pageClass: classification.pageClass,
          ats: classification.ats,
          tenant: classification.tenant,
          spokeUrl: classification.spokeUrl,
          formSpec: classification.formSpec,
        },
      });

      return {
        pageId: page.id,
        classification,
        childSpokeId,
      };
    });
  }
}
