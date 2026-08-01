import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { runEvaluation } from "./evaluation.js";
import { indexDocumentRevision, parseDocument } from "./knowledge.js";
import { emitEvent } from "./platform.js";
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
  attempts: number;
  max_attempts: number;
}

const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

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
       RETURNING o.id, o.organization_id, o.aggregate_id, o.event_type, o.payload, o.attempts, o.max_attempts`
    );
    return result.rows[0] ?? null;
  });
}

async function sendMetaMessage(event: ClaimedOutbox) {
  const messageId = event.payload.messageId ?? event.aggregate_id;
  const details = await query<{
    message_id: string;
    text: string;
    conversation_id: string;
    provider: string;
    external_page_id: string;
    graph_version: string;
    external_user_id: string;
    correlation_id: string;
  }>(
    `SELECT m.id AS message_id, COALESCE(m.normalized_text, m.raw_text, '') AS text,
            m.conversation_id, a.provider, a.external_page_id, a.graph_version,
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
  let providerMessageId = `demo-${messageId}`;
  if (row.provider !== "demo" && !config.DEMO_MODE) {
    if (!config.META_PAGE_ACCESS_TOKEN) throw new Error("META_PAGE_ACCESS_TOKEN is not configured");
    const response = await fetch(`https://graph.facebook.com/${row.graph_version}/${row.external_page_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.META_PAGE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: row.external_user_id }, message: { text: row.text } })
    });
    const payload = (await response.json()) as { message_id?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? `Meta returned ${response.status}`);
    providerMessageId = payload.message_id ?? providerMessageId;
  }
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE conversation.messages SET status = 'sent', external_message_id = $2, sent_at = now() WHERE id = $1",
      [messageId, providerMessageId]
    );
    await client.query("UPDATE platform.outbox_events SET status = 'sent', sent_at = now() WHERE id = $1", [event.id]);
    await client.query(
      `INSERT INTO platform.integration_logs(organization_id, provider, operation, status, request_meta, response_meta, correlation_id)
       VALUES ($1,$2,'send_message','succeeded',$3,$4,$5)`,
      [event.organization_id, row.provider, JSON.stringify({ messageId, conversationId: row.conversation_id }), JSON.stringify({ providerMessageId }), row.correlation_id]
    );
    await emitEvent(client, {
      eventType: "conversation.message.updated",
      organizationId: event.organization_id,
      correlationId: row.correlation_id,
      aggregate: { type: "conversation", id: row.conversation_id },
      payload: { messageId, status: "sent", providerMessageId }
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

export async function runWorkerTick() {
  const job = await claimJob();
  if (job) {
    try {
      await query("UPDATE platform.jobs SET progress = 20, current_step = 'processing' WHERE id = $1", [job.id]);
      const result = await executeJob(job);
      await completeJob(job, result);
    } catch (error) {
      await failJob(job, error);
    }
    return true;
  }
  const outbox = await claimOutbox();
  if (outbox) {
    try {
      await sendMetaMessage(outbox);
    } catch (error) {
      await failOutbox(outbox, error);
    }
    return true;
  }
  return false;
}

