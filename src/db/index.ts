import postgres from 'postgres';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Direct SQL Client (Postgres.js) for background workers, transactions, and multi-schema operations
export const sql = config.database.url
  ? postgres(config.database.url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    })
  : null;

// Supabase Client for PostgREST, Auth, and Storage
export const supabase: SupabaseClient = createClient(
  config.supabase.url || 'https://placeholder.supabase.co',
  config.supabase.secretKey || config.supabase.publishableKey || 'placeholder-key'
);

export interface OutboxEventInput {
  type: string;
  version?: number;
  producer: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;
  entityRefs?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

/**
 * Inserts an event into platform.outbox_events.
 * When called inside a transaction (sql.begin), guarantees state mutation + event atomicity.
 */
export async function emitOutboxEvent(
  db: postgres.Sql | postgres.TransactionSql,
  event: OutboxEventInput
) {
  const [row] = await db`
    INSERT INTO platform.outbox_events (
      type,
      version,
      producer,
      correlation_id,
      causation_id,
      idempotency_key,
      entity_refs,
      payload
    ) VALUES (
      ${event.type},
      ${event.version ?? 1},
      ${event.producer},
      ${event.correlationId},
      ${event.causationId ?? null},
      ${event.idempotencyKey},
      ${db.json(event.entityRefs as any ?? {})},
      ${db.json(event.payload as any ?? {})}
    )
    RETURNING id, type, occurred_at, idempotency_key
  `;
  return row;
}
