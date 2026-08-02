import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { runEvaluation } from "./evaluation.js";
import { reviewConversations } from "./improvement.js";
import { indexDocumentRevision, parseDocument } from "./knowledge.js";
import { emitEvent, enqueueJob } from "./platform.js";
import { normalizeWebhookEvent, processConversation } from "./orchestrator.js";

interface ClaimedJob {
  id: string;
  organization_id: string;
  job_type: string;
  payload: Record<string, any>;
  attempts: number;
  max_attempts: number;
}

interface ClaimedOutbox {
  id: string;
  organization_id: string;
  aggregate_id: string;
  event_type: string;
  payload: { messageId?: string; conversationId?: string; text?: string };
  environment: string;
  attempts: number;
  max_attempts: number;
}

export const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
let jobsProcessed = 0;

async function claimJob() {
  return withTransaction(async (client) => {
    const result = await client.query<ClaimedJob>(
      `WITH candidate AS (
         SELECT id FROM platform.jobs
         WHERE status = 'queued' AND available_at <= now()
         ORDER BY priority ASC, available_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE platform.jobs j
       SET status = 'running', locked_at = now(), locked_by = $1,
           attempts = attempts + 1, current_step = 'claimed', progress = 5
       FROM candidate WHERE j.id = candidate.id
       RETURNING j.id, j.organization_id, j.job_type, j.payload, j.attempts, j.max_attempts`,
      [workerId]
    );
    return result.rows[0] ?? null;
  });
}

async function completeJob(job: ClaimedJob, result: unknown) {
  await query(
    "UPDATE platform.jobs SET status = 'succeeded', progress = 100, current_step = 'completed', result = $2, updated_at = now() WHERE id = $1",
    [job.id, JSON.stringify(result ?? {})]
  );
}

async function failJob(job: ClaimedJob, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const terminal = job.attempts >= job.max_attempts;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE platform.jobs
       SET status = $2, last_error = $3, current_step = $4,
           available_at = CASE WHEN $2 = 'queued' THEN now() + (($5 * $5)::text || ' seconds')::interval ELSE available_at END,
           locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1`,
      [job.id, terminal ? "failed" : "queued", message.slice(0, 4000), terminal ? "dead_letter" : "retry_scheduled", job.attempts]
    );
    if (terminal) {
      await client.query(
        "INSERT INTO platform.dead_letter_events(source_type, source_id, payload, error) VALUES ('job',$1,$2,$3)",
        [job.id, JSON.stringify(job.payload), message.slice(0, 4000)]
      );
      await emitEvent(client, {
        eventType: "job.failed",
        organizationId: job.organization_id,
        correlationId: String(job.payload.correlationId ?? randomUUID()),
        aggregate: { type: "job", id: job.id },
        payload: { jobType: job.job_type, error: message }
      });
    }
  });
}

async function executeJob(job: ClaimedJob) {
  const correlationId = String(job.payload.correlationId ?? randomUUID());
  switch (job.job_type) {
    case "PROCESS_CONVERSATION":
      return processConversation(String(job.payload.conversationId), correlationId);
    case "PROCESS_WEBHOOK":
      return normalizeWebhookEvent(String(job.payload.webhookEventId));
    case "INDEX_DOCUMENT":
      return indexDocumentRevision(String(job.payload.revisionId), correlationId);
    case "PARSE_DOCUMENT":
      return parseDocument(String(job.payload.documentId), correlationId);
    case "RUN_EVALUATION":
      return runEvaluation(String(job.payload.runId), correlationId);
    case "REVIEW_CONVERSATIONS":
      return reviewConversations(job.organization_id, {
        lookbackDays: Number(job.payload.lookbackDays ?? 7),
        minSignals: Number(job.payload.minSignals ?? 3),
        correlationId
      });
    default:
      throw new Error(`Unknown job type ${job.job_type}`);
  }
}

async function claimOutbox() {
  return withTransaction(async (client) => {
    const result = await client.query<ClaimedOutbox>(
      `WITH candidate AS (
         SELECT id FROM platform.outbox_events
         WHERE status = 'pending' AND available_at <= now()
         ORDER BY available_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE platform.outbox_events o
       SET status = 'processing', attempts = attempts + 1
       FROM candidate WHERE o.id = candidate.id
       RETURNING o.id, o.organization_id, o.aggregate_id, o.event_type, o.payload, o.environment, o.attempts, o.max_attempts`
    );
    return result.rows[0] ?? null;
  });
}

export type DeliveryMode = "real" | "simulated" | "blocked";

export interface DeliveryDecision {
  mode: DeliveryMode;
  reason: string;
}

/**
 * Cổng chặn outbound cấp một (yêu cầu 5.16, audit mục 1.2).
 *
 * Bản trước chỉ kiểm tra `provider !== 'demo' && !DEMO_MODE` và KHÔNG hề đọc
 * environment của hội thoại — nghĩa là một hội thoại test vẫn có thể gửi tin
 * thật ra Facebook nếu cấu hình channel thay đổi.
 *
 * Thứ tự kiểm tra ở đây là cố ý: environment được xét TRƯỚC mọi thứ khác, nên
 * không cấu hình nào có thể khiến Test Workspace gửi tin ra ngoài.
 */
export function decideDelivery(input: {
  environment: string;
  provider: string;
  appEnv: string;
  demoMode: boolean;
  hasPageToken: boolean;
}): DeliveryDecision {
  if (input.environment !== "live") return { mode: "simulated", reason: "test_environment" };
  if (input.demoMode) return { mode: "simulated", reason: "demo_mode" };
  if (input.provider === "demo") return { mode: "simulated", reason: "demo_channel" };
  if (input.appEnv !== "production" && input.appEnv !== "staging") {
    return { mode: "blocked", reason: `app_env_${input.appEnv}_cannot_send` };
  }
  if (!input.hasPageToken) return { mode: "blocked", reason: "missing_page_access_token" };
  return { mode: "real", reason: "ok" };
}

async function deliverOutboundMessage(event: ClaimedOutbox) {
  const messageId = event.payload.messageId ?? event.aggregate_id;
  const details = await query<{
    message_id: string;
    text: string;
    conversation_id: string;
    environment: string;
    provider: string;
    external_page_id: string;
    graph_version: string;
    external_user_id: string;
    correlation_id: string;
  }>(
    `SELECT m.id AS message_id, COALESCE(m.normalized_text, m.raw_text, '') AS text,
            m.conversation_id, c.environment, a.provider, a.external_page_id, a.graph_version,
            ci.external_user_id, m.correlation_id::text
     FROM conversation.messages m
     JOIN conversation.conversations c ON c.id = m.conversation_id
     JOIN channel.accounts a ON a.id = c.channel_account_id
     JOIN conversation.contact_identities ci ON ci.contact_id = c.contact_id AND ci.channel_account_id = c.channel_account_id
     WHERE m.id = $1`,
    [messageId]
  );
  const row = details.rows[0];
  if (!row) throw new Error("Outbox message not found");

  // Lấy environment từ chính hội thoại, không tin vào cột trên outbox.
  const decision = decideDelivery({
    environment: row.environment,
    provider: row.provider,
    appEnv: config.APP_ENV,
    demoMode: config.DEMO_MODE,
    hasPageToken: Boolean(config.META_PAGE_ACCESS_TOKEN)
  });

  let providerMessageId = `simulated:${messageId}`;
  if (decision.mode === "real") {
    const response = await fetch(`https://graph.facebook.com/${row.graph_version}/${row.external_page_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.META_PAGE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: row.external_user_id }, message: { text: row.text } })
    });
    const payload = (await response.json()) as { message_id?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? `Meta returned ${response.status}`);
    providerMessageId = payload.message_id ?? `meta:${messageId}`;
  }

  await withTransaction(async (client) => {
    const messageStatus = decision.mode === "blocked" ? "cancelled" : "sent";
    await client.query(
      `UPDATE conversation.messages
       SET status = $3, external_message_id = $2, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE NULL END,
           metadata = metadata || jsonb_build_object('delivery_mode', $4::text, 'delivery_reason', $5::text)
       WHERE id = $1`,
      [messageId, decision.mode === "blocked" ? null : providerMessageId, messageStatus, decision.mode, decision.reason]
    );
    await client.query(
      "UPDATE platform.outbox_events SET status = 'sent', sent_at = now(), delivery_mode = $2, environment = $3 WHERE id = $1",
      [event.id, decision.mode, row.environment]
    );
    await client.query(
      `INSERT INTO platform.integration_logs(organization_id, provider, operation, status, request_meta, response_meta, correlation_id)
       VALUES ($1,$2,'send_message',$3,$4,$5,$6)`,
      [
        event.organization_id,
        row.provider,
        decision.mode === "real" ? "succeeded" : decision.mode === "simulated" ? "simulated" : "skipped",
        JSON.stringify({ messageId, conversationId: row.conversation_id, environment: row.environment }),
        JSON.stringify({ providerMessageId: decision.mode === "blocked" ? null : providerMessageId, deliveryMode: decision.mode, reason: decision.reason }),
        row.correlation_id
      ]
    );
    await emitEvent(client, {
      eventType: "conversation.message.updated",
      organizationId: event.organization_id,
      correlationId: row.correlation_id,
      aggregate: { type: "conversation", id: row.conversation_id },
      payload: { messageId, status: messageStatus, providerMessageId, deliveryMode: decision.mode, reason: decision.reason }
    });
  });
}

async function failOutbox(event: ClaimedOutbox, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const terminal = event.attempts >= event.max_attempts;
  await withTransaction(async (client: PoolClient) => {
    await client.query(
      `UPDATE platform.outbox_events
       SET status = $2, last_error = $3,
           available_at = CASE WHEN $2 = 'pending' THEN now() + (($4 * $4)::text || ' seconds')::interval ELSE available_at END
       WHERE id = $1`,
      [event.id, terminal ? "dead_letter" : "pending", message.slice(0, 4000), event.attempts]
    );
    if (terminal) {
      await client.query(
        "INSERT INTO platform.dead_letter_events(source_type, source_id, payload, error) VALUES ('outbox',$1,$2,$3)",
        [event.id, JSON.stringify(event.payload), message.slice(0, 4000)]
      );
    }
  });
}

/**
 * Sliding debounce dùng idempotency key theo hội thoại, nên hàng job được tái
 * sử dụng. Nếu tin nhắn mới tới trong lúc job đang chạy, chúng vẫn ở trạng thái
 * 'pending' còn job thì vừa chuyển sang 'succeeded' — sẽ không ai xử lý chúng.
 *
 * Chạy kiểm tra này SAU completeJob để đưa job về hàng đợi khi còn tin chờ.
 */
async function requeueConversationIfPending(job: ClaimedJob) {
  const conversationId = job.payload?.conversationId;
  if (job.job_type !== "PROCESS_CONVERSATION" || !conversationId) return;
  const pending = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM conversation.messages
       WHERE conversation_id = $1 AND direction = 'inbound' AND status = 'pending'
     ) AS exists`,
    [conversationId]
  );
  if (!pending.rows[0]?.exists) return;
  await withTransaction(async (client) => {
    const debounce = await client.query<{ seconds: number }>(
      `SELECT COALESCE(
                NULLIF(a.policy->>'debounceSeconds','')::int,
                s.debounce_seconds,
                $2::int
              ) AS seconds
       FROM conversation.conversations c
       JOIN channel.accounts a ON a.id = c.channel_account_id
       LEFT JOIN platform.runtime_settings s ON s.organization_id = c.organization_id
       WHERE c.id = $1`,
      [conversationId, config.DEBOUNCE_SECONDS]
    );
    const seconds = debounce.rows[0]?.seconds ?? config.DEBOUNCE_SECONDS;
    await enqueueJob(
      client,
      job.organization_id,
      "PROCESS_CONVERSATION",
      { conversationId, correlationId: randomUUID() },
      `process-conversation:${conversationId}`,
      new Date(Date.now() + seconds * 1000),
      50,
      { pushBack: true }
    );
  });
}

/**
 * Thu hồi tin nhắn kẹt ở 'processing'.
 *
 * processConversation chia làm ba pha, nên nếu tiến trình chết giữa pha 2 (gọi
 * model) và pha 3, tin nhắn sẽ nằm mãi ở 'processing' và không ai xử lý. Đưa
 * chúng về 'pending' rồi xếp lại hàng đợi.
 */
export async function reclaimStuckMessages(olderThanSeconds = 300) {
  const stuck = await query<{ conversation_id: string; organization_id: string }>(
    `UPDATE conversation.messages m
     SET status = 'pending', batch_id = NULL
     FROM conversation.conversations c
     WHERE c.id = m.conversation_id
       AND m.direction = 'inbound' AND m.status = 'processing'
       AND m.created_at < now() - make_interval(secs => $1)
     RETURNING DISTINCT m.conversation_id, m.organization_id`,
    [olderThanSeconds]
  );
  for (const row of stuck.rows) {
    await withTransaction((client) =>
      enqueueJob(
        client,
        row.organization_id,
        "PROCESS_CONVERSATION",
        { conversationId: row.conversation_id, correlationId: randomUUID() },
        `process-conversation:${row.conversation_id}`,
        new Date(),
        50
      )
    );
  }
  if (stuck.rowCount) console.warn(`Đã thu hồi tin nhắn kẹt của ${stuck.rowCount} hội thoại`);
  return stuck.rowCount ?? 0;
}

export async function recordHeartbeat(status: "starting" | "running" | "draining" | "stopped" = "running", lastError?: string) {
  await query(
    `INSERT INTO platform.worker_heartbeats(worker_id, hostname, pid, app_env, status, jobs_processed, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (worker_id) DO UPDATE
       SET status = EXCLUDED.status, jobs_processed = EXCLUDED.jobs_processed,
           last_error = EXCLUDED.last_error, last_seen_at = now()`,
    [workerId, hostname(), process.pid, config.APP_ENV, status, jobsProcessed, lastError ?? null]
  );
}

export async function runWorkerTick() {
  const job = await claimJob();
  if (job) {
    try {
      await query("UPDATE platform.jobs SET progress = 20, current_step = 'processing' WHERE id = $1", [job.id]);
      const result = await executeJob(job);
      await completeJob(job, result);
      await requeueConversationIfPending(job);
    } catch (error) {
      await failJob(job, error);
    }
    jobsProcessed += 1;
    return true;
  }
  const outbox = await claimOutbox();
  if (outbox) {
    try {
      await deliverOutboundMessage(outbox);
    } catch (error) {
      await failOutbox(outbox, error);
    }
    return true;
  }
  return false;
}

