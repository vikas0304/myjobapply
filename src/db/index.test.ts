import { describe, it, expect } from 'vitest';
import { config } from '../config.js';
import { supabase, sql } from './index.js';

describe('Phase 0 Foundation Setup', () => {
  it('loads configuration from environment', () => {
    expect(config.supabase.url).toBe('https://ecjmlvooqryqnqxvmwno.supabase.co');
    expect(config.supabase.publishableKey).toContain('sb_publishable_');
  });

  it('connects to database and verifies created schemas', async () => {
    if (!sql) {
      console.warn('Skipping live DB test: No database URL provided');
      return;
    }

    const schemas = await sql<{ schema_name: string }[]>`
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name IN ('platform', 'discovery', 'ingest', 'sched', 'profile', 'jobs', 'ai', 'audit')
      ORDER BY schema_name;
    `;

    const schemaNames = schemas.map((s) => s.schema_name);
    expect(schemaNames).toEqual(
      expect.arrayContaining(['platform', 'discovery', 'ingest', 'sched', 'profile', 'jobs', 'ai', 'audit'])
    );
  });
});

