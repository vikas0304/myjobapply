import { describe, it, expect, afterAll } from 'vitest';
import { classifyCareerPage } from './fingerprint.js';
import { DiscoveryService } from './service.js';
import { sql } from '../db/index.js';

describe('Phase 1 Discovery Spike: Reference Fixtures', () => {

  it('classifies Vidushi Infotech career page fixture as talent-pool', () => {
    const vidushiHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Careers at Vidushi Infotech</title></head>
        <body>
          <h1>Join Our Talent Pool</h1>
          <p>We are always looking for great minds. Submit your profile below:</p>
          <form action="/submit-cv" method="POST" enctype="multipart/form-data">
            <input type="text" name="candidate_name" placeholder="Full Name" required />
            <input type="email" name="candidate_email" placeholder="Email Address" required />
            <input type="tel" name="mobile_number" placeholder="Mobile Number" />
            <select name="preferred_role">
              <option value="dev">Software Engineer</option>
              <option value="qa">QA Engineer</option>
            </select>
            <input type="number" name="years_of_experience" placeholder="Years of Experience" />
            <input type="file" name="resume_file" accept=".pdf,.doc" required />
            <label>
              <input type="checkbox" name="terms_consent" required />
              I consent to Vidushi processing my data.
            </label>
            <button type="submit">Submit Application</button>
          </form>
        </body>
      </html>
    `;

    const result = classifyCareerPage({
      url: 'https://vidushiinfotech.com/careers/',
      html: vidushiHtml,
    });

    expect(result.pageClass).toBe('talent-pool');
    expect(result.confidence).toBe('high');
    expect(result.formSpec).toBeDefined();
    expect(result.formSpec?.hasResumeUpload).toBe(true);

    const expectedFields = ['name', 'email', 'mobile', 'role', 'experience', 'resume', 'consent'];
    for (const field of expectedFields) {
      expect(result.formSpec?.formFields).toContain(field);
    }
  });

  it('classifies Tech Mahindra career page fixture as hub-to-spoke', () => {
    const techMahindraHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Tech Mahindra Careers</title></head>
        <body>
          <h1>Explore Opportunities at Tech Mahindra</h1>
          <p>Discover roles shaping the digital future.</p>
          <div class="cta-section">
            <a href="https://careers.techmahindra.com/" class="btn-primary">View Open Jobs on Careers Portal</a>
          </div>
        </body>
      </html>
    `;

    const result = classifyCareerPage({
      url: 'https://www.techmahindra.com/careers/',
      html: techMahindraHtml,
    });

    expect(result.pageClass).toBe('hub-to-spoke');
    expect(result.confidence).toBe('high');
    expect(result.spokeUrl).toBe('https://careers.techmahindra.com/');
  });

  it('classifies Greenhouse ATS board correctly', () => {
    const greenhouseHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Jobs at Acme Corp</title></head>
        <body>
          <div id="grnh_iframe_container">
            <iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe>
          </div>
        </body>
      </html>
    `;

    const result = classifyCareerPage({
      url: 'https://boards.greenhouse.io/acme',
      html: greenhouseHtml,
    });

    expect(result.ats).toBe('greenhouse');
    expect(result.pageClass).toBe('job-list');
    expect(result.tenant).toBe('acme');
  });

  it('persists Tech Mahindra hub-to-spoke to Supabase and emits outbox event', async () => {
    if (!sql) {
      console.warn('Skipping live DB test: No database URL');
      return;
    }

    const service = new DiscoveryService();

    // 1. Register Company
    const company = await service.registerCompany({
      name: `Tech Mahindra Test ${Date.now()}`,
      domain: `techmahindra-${Date.now()}.com`,
    });
    expect(company.id).toBeDefined();

    // 2. Process Hub Page
    const sampleHtml = `
      <html>
        <body>
          <a href="https://careers.techmahindra.com/">Careers Portal</a>
        </body>
      </html>
    `;

    const outcome = await service.processCareerPage({
      companyId: company.id,
      url: `https://www.techmahindra-${Date.now()}.com/careers/`,
      html: sampleHtml,
    });

    expect(outcome.classification.pageClass).toBe('hub-to-spoke');
    expect(outcome.classification.spokeUrl).toBe('https://careers.techmahindra.com/');
    expect(outcome.childSpokeId).toBeDefined();

    // 3. Verify transactional outbox event in Supabase
    const outboxRows = await sql`
      SELECT id, type, producer, payload
      FROM platform.outbox_events
      WHERE entity_refs->>'pageId' = ${outcome.pageId}
    `;

    expect(outboxRows.length).toBeGreaterThan(0);
    expect(outboxRows[0].type).toBe('CareerPageFingerprinted');
    expect(outboxRows[0].payload.spokeUrl).toBe('https://careers.techmahindra.com/');
  });
});
