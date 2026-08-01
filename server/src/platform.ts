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

export interface EnqueueOptions {
  /**
   * Sliding debounce (5.3): khi job đã tồn tại, ĐẨY LÙI thời điểm chạy thay vì
   * kéo sớm lên. Dùng cho PROCESS_CONVERSATION để khách gõ liên tiếp nhiều tin
   * chỉ sinh ra một lượt AI.
   *
   * Mặc định false — giữ hành vi cũ (chạy sớm nhất có thể) cho các job khác.
   */
  pushBack?: boolean;
}

export async function enqueueJob(
  executor: DatabaseExecutor,
  organizationId: string,
  jobType: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  availableAt = new Date(),
  priority = 100,
  options: EnqueueOptions = {}
) {
  const result = await executor.query<{ id: string }>(
    `INSERT INTO platform.jobs(organization_id, job_type, payload, idempotency_key, available_at, priority)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (organization_id, idempotency_key) DO UPDATE
       SET available_at = CASE
             WHEN $7::boolean THEN GREATEST(platform.jobs.available_at, EXCLUDED.available_at)
             ELSE LEAST(platform.jobs.available_at, EXCLUDED.available_at)
           END,
           payload = EXCLUDED.payload,
           -- Key theo hội thoại nên hàng job được tái sử dụng mãi. Job đã kết
           -- thúc phải được đưa lại về hàng đợi, nếu không tin nhắn kế tiếp sẽ
           -- không bao giờ được xử lý.
           status = CASE WHEN platform.jobs.status IN ('failed','succeeded','cancelled') THEN 'queued' ELSE platform.jobs.status END,
           attempts = CASE WHEN platform.jobs.status IN ('failed','succeeded','cancelled') THEN 0 ELSE platform.jobs.attempts END,
           last_error = CASE WHEN platform.jobs.status IN ('failed','succeeded','cancelled') THEN NULL ELSE platform.jobs.last_error END,
           locked_at = CASE WHEN platform.jobs.status IN ('failed','succeeded','cancelled') THEN NULL ELSE platform.jobs.locked_at END,
           locked_by = CASE WHEN platform.jobs.status IN ('failed','succeeded','cancelled') THEN NULL ELSE platform.jobs.locked_by END,
           updated_at = now()
     RETURNING id`,
    [organizationId, jobType, JSON.stringify(payload), idempotencyKey, availableAt, priority, Boolean(options.pushBack)]
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
  idempotencyKey: string,
  /** Môi trường của hội thoại. Worker dùng để quyết định gửi thật hay mô phỏng. */
  environment: "live" | "test" = "live"
) {
  await client.query(
    `INSERT INTO platform.outbox_events(
       organization_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, environment
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [organizationId, aggregateType, aggregateId, eventType, JSON.stringify(payload), idempotencyKey, environment]
  );
}

