import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query } from "./db.js";
import type { DatabaseExecutor, DomainEvent, SessionUser } from "./types.js";

export async function emitEvent(executor: DatabaseExecutor, event: Omit<DomainEvent, "eventId" | "occurredAt" | "schemaVersion">) {
  const envelope: DomainEvent = {
    ...event,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    schemaVersion: 1
  };
  await executor.query("SELECT pg_notify('tm_events', $1)", [JSON.stringify(envelope)]);
  return envelope;
}

export async function enqueueJob(
  executor: DatabaseExecutor,
  organizationId: string,
  jobType: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  availableAt = new Date(),
  priority = 100
) {
  const result = await executor.query<{ id: string }>(
    `INSERT INTO platform.jobs(organization_id, job_type, payload, idempotency_key, available_at, priority)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (organization_id, idempotency_key) DO UPDATE
       SET available_at = LEAST(platform.jobs.available_at, EXCLUDED.available_at),
           status = CASE WHEN platform.jobs.status = 'failed' THEN 'queued' ELSE platform.jobs.status END,
           updated_at = now()
     RETURNING id`,
    [organizationId, jobType, JSON.stringify(payload), idempotencyKey, availableAt, priority]
  );
  return result.rows[0]?.id;
}

export async function writeAudit(
  executor: DatabaseExecutor,
  user: SessionUser | null,
  action: string,
  entityType: string,
  entityId: string,
  beforeData: unknown,
  afterData: unknown,
  correlationId: string,
  sourceIp?: string
) {
  await executor.query(
    `INSERT INTO platform.audit_logs(
       organization_id, actor_id, actor_type, action, entity_type, entity_id,
       before_data, after_data, source_ip, correlation_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      user?.organizationId ?? "00000000-0000-4000-8000-000000000001",
      user?.id ?? null,
      user ? "user" : "system",
      action,
      entityType,
      entityId,
      beforeData == null ? null : JSON.stringify(beforeData),
      afterData == null ? null : JSON.stringify(afterData),
      sourceIp ?? null,
      correlationId
    ]
  );
}

export async function getActiveRelease(organizationId: string, environment = "development") {
  const result = await query(
    `SELECT * FROM studio.releases
     WHERE organization_id = $1 AND environment = $2 AND status IN ('active','canary')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, activated_at DESC NULLS LAST
     LIMIT 1`,
    [organizationId, environment]
  );
  return result.rows[0] ?? null;
}

export async function publishOutbox(
  client: PoolClient,
  organizationId: string,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
  idempotencyKey: string
) {
  await client.query(
    `INSERT INTO platform.outbox_events(
       organization_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [organizationId, aggregateType, aggregateId, eventType, JSON.stringify(payload), idempotencyKey]
  );
}

