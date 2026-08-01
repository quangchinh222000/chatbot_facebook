import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { pool, query, withTransaction } from "./db.js";
import { detectLanguage } from "./language.js";
import { emitEvent, enqueueJob, publishOutbox } from "./platform.js";
import { splitMessengerText } from "./renderer.js";
import {
  executeTurn,
  recordAiRun,
  resolveRuntimeConfig,
  type Environment,
  type RunMode,
  type TurnOutcome
} from "./runtime.js";
import { ORGANIZATION_ID, SALES_TEAM_ID, type PolicyDecision } from "./types.js";

export { validateGroundedResponse } from "./guardrail.js";

async function createHandover(
  client: PoolClient,
  conversation: { id: string; organization_id: string; current_state: string; contact_id: string },
  decision: PolicyDecision,
  text: string,
  correlationId: string,
  environment: Environment
) {
  const summary = decision.reasonCode === "PAYMENT_NOTIFICATION"
    ? `Khách báo thông tin thanh toán: ${text.slice(0, 300)}`
    : `Cần tư vấn viên tiếp nhận: ${text.slice(0, 300)}`;
  const priority = decision.reasonCode === "PAYMENT_NOTIFICATION" ? "high" : "normal";
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM case_mgmt.cases WHERE conversation_id = $1 AND status <> 'resolved' FOR UPDATE`,
    [conversation.id]
  );
  let caseId = existing.rows[0]?.id;
  if (!caseId) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO case_mgmt.cases(
         organization_id, conversation_id, reason_code, summary, priority, assigned_team_id, sla_due_at
       ) VALUES ($1,$2,$3,$4,$5,$6,now() + interval '30 minutes')
       RETURNING id`,
      [conversation.organization_id, conversation.id, decision.reasonCode ?? "POLICY_HANDOVER", summary, priority, SALES_TEAM_ID]
    );
    caseId = inserted.rows[0]!.id;
  }
  await client.query(
    `UPDATE conversation.conversations
     SET bot_mode = 'human', current_state = 'HUMAN', priority = $2, version = version + 1
     WHERE id = $1`,
    [conversation.id, priority]
  );
  if (conversation.current_state !== "HUMAN") {
    await client.query(
      `INSERT INTO conversation.state_transitions(organization_id, conversation_id, from_state, to_state, trigger, reason)
       VALUES ($1,$2,$3,'HUMAN','hard_rule',$4)`,
      [conversation.organization_id, conversation.id, conversation.current_state, decision.reasonCode]
    );
  }
  // Hội thoại test không được tạo thông báo cho đội sale thật.
  if (environment === "live") {
    await client.query(
      `INSERT INTO platform.notifications(
         organization_id, team_id, type, title, body, severity, entity_type, entity_id
       ) VALUES ($1,$2,'new_case','Cần chuyển tư vấn viên',$3,$4,'case',$5)`,
      [conversation.organization_id, SALES_TEAM_ID, summary, priority === "high" ? "warning" : "info", caseId]
    );
  }
  await emitEvent(client, {
    eventType: "case.created",
    organizationId: conversation.organization_id,
    correlationId,
    aggregate: { type: "case", id: caseId },
    payload: { conversationId: conversation.id, reasonCode: decision.reasonCode, priority, environment }
  });
  return { caseId, summary };
}

async function createOutboundMessages(
  client: PoolClient,
  input: {
    organizationId: string;
    conversationId: string;
    environment: Environment;
    text: string;
    correlationId: string;
    aiRunId: string;
  }
) {
  const pieces = splitMessengerText(input.text);
  const messageIds: string[] = [];
  for (const [index, piece] of pieces.entries()) {
    const message = await client.query<{ id: string }>(
      `INSERT INTO conversation.messages(
         organization_id, conversation_id, direction, sender_type, raw_text, normalized_text,
         status, correlation_id, metadata
       ) VALUES ($1,$2,'outbound','bot',$3,$3,'queued',$4,$5)
       RETURNING id`,
      [
        input.organizationId,
        input.conversationId,
        piece,
        input.correlationId,
        JSON.stringify({ ai_run_id: input.aiRunId, segment: index + 1, segment_count: pieces.length })
      ]
    );
    const messageId = message.rows[0]!.id;
    messageIds.push(messageId);
    // environment đi cùng outbox để worker chặn gửi mà không phải join ngược.
    await publishOutbox(
      client,
      input.organizationId,
      "message",
      messageId,
      "channel.message.send",
      { messageId, conversationId: input.conversationId, text: piece, segment: index + 1 },
      `send:${messageId}`,
      input.environment
    );
  }
  return messageIds;
}

/**
 * Xử lý một lượt hội thoại theo BA PHA.
 *
 * Bản trước bọc toàn bộ trong một transaction duy nhất — nghĩa là lời gọi model
 * (tới 25 giây) giữ luôn một connection của pool, một `pg_advisory_xact_lock`
 * và các row lock `FOR UPDATE`. Pool chỉ có 20 connection, nên khoảng 20 hội
 * thoại đồng thời là cạn pool và toàn bộ API đứng.
 *
 * Nay:
 *   Pha 1 (tx ngắn)  — chốt batch tin nhắn, đánh dấu 'processing', đọc ngữ cảnh
 *   Pha 2 (KHÔNG tx) — gọi model
 *   Pha 3 (tx ngắn)  — ghi trace, đổi trạng thái, tạo outbound
 *
 * Chống chạy trùng không còn dựa vào advisory lock xuyên suốt mà dựa vào việc
 * Pha 1 đã chuyển tin nhắn sang 'processing': lượt chạy song song sẽ không thấy
 * tin 'pending' nào và thoát ngay.
 */
export async function processConversation(conversationId: string, correlationId: string = randomUUID()) {
  // ---- Pha 1: chốt batch (transaction ngắn) ----
  const claimed = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [conversationId]);
    const conversationResult = await client.query<{
      id: string;
      organization_id: string;
      channel_account_id: string;
      contact_id: string;
      contact_name: string;
      bot_mode: string;
      current_state: string;
      environment: Environment;
      primary_language: string | null;
      segment: string | null;
      selected_course_id: string | null;
    }>(
      `SELECT c.id, c.organization_id, c.channel_account_id, c.contact_id, ct.display_name AS contact_name,
              c.bot_mode, c.current_state, c.environment, c.primary_language, ct.segment, c.selected_course_id
       FROM conversation.conversations c
       JOIN conversation.contacts ct ON ct.id = c.contact_id
       WHERE c.id = $1 FOR UPDATE OF c`,
      [conversationId]
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) throw new Error("Conversation not found");

    const messages = await client.query<{ id: string; normalized_text: string | null; raw_text: string | null }>(
      `SELECT id, normalized_text, raw_text
       FROM conversation.messages
       WHERE conversation_id = $1 AND direction = 'inbound' AND status = 'pending'
       ORDER BY created_at ASC FOR UPDATE`,
      [conversationId]
    );
    if (!messages.rowCount) return { conversationId, status: "noop" };

    const text = messages.rows.map((message) => message.normalized_text ?? message.raw_text ?? "").join("\n").trim();
    const messageIds = messages.rows.map((message) => message.id);

    const batch = await client.query<{ id: string }>(
      `INSERT INTO conversation.message_batches(
         organization_id, conversation_id, inbound_message_ids, debounce_until, status, correlation_id
       ) VALUES ($1,$2,$3,now(),'processing',$4) RETURNING id`,
      [conversation.organization_id, conversationId, messageIds, correlationId]
    );
    const batchId = batch.rows[0]!.id;
    await client.query(
      "UPDATE conversation.messages SET status = 'processing', batch_id = $2 WHERE id = ANY($1::uuid[])",
      [messageIds, batchId]
    );

    const cfg = await resolveRuntimeConfig(client, {
      organizationId: conversation.organization_id,
      environment: conversation.environment,
      channelAccountId: conversation.channel_account_id
    });
    const history = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM conversation.messages WHERE conversation_id = $1 AND direction = 'inbound'",
      [conversationId]
    );

    for (const message of messages.rows) {
      await client.query("UPDATE conversation.messages SET detected_language = $2 WHERE id = $1", [
        message.id,
        detectLanguage(message.normalized_text ?? message.raw_text ?? "")
      ]);
    }

    return {
      conversation,
      messages: messages.rows,
      messageIds,
      text,
      batchId,
      cfg,
      inboundCount: Number(history.rows[0]?.count ?? 0)
    };
  });

  if ("status" in claimed) return claimed;

  const { conversation, messageIds, text, batchId, cfg } = claimed;

  // ---- Pha 2: gọi model NGOÀI transaction ----
  // Đây là phần chậm nhất. Không giữ connection, không giữ lock.
  let outcome: Awaited<ReturnType<typeof executeTurn>>;
  try {
    outcome = await executeTurn(
      pool,
      {
        organizationId: conversation.organization_id,
        mode: "live",
        environment: conversation.environment,
        text,
        botMode: conversation.bot_mode,
        currentState: conversation.current_state,
        contactName: conversation.contact_name,
        segment: conversation.segment,
        selectedCourseId: conversation.selected_course_id,
        conversationLanguage: conversation.primary_language,
        inboundCount: claimed.inboundCount
      },
      cfg
    );
  } catch (error) {
    // Trả tin nhắn về 'pending' để lượt sau xử lý lại, thay vì kẹt ở
    // 'processing' vĩnh viễn.
    await query(
      "UPDATE conversation.messages SET status = 'pending', batch_id = NULL WHERE id = ANY($1::uuid[]) AND status = 'processing'",
      [messageIds]
    );
    await query("UPDATE conversation.message_batches SET status = 'failed' WHERE id = $1", [batchId]);
    throw error;
  }

  // ---- Pha 3: ghi kết quả (transaction ngắn) ----
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [conversationId]);

    // Chốt ngôn ngữ chính của hội thoại sau lượt đầu tiên nhận diện được.
    if (!conversation.primary_language && outcome.language.detected !== "unknown") {
      await client.query("UPDATE conversation.conversations SET primary_language = $2 WHERE id = $1", [
        conversationId,
        outcome.language.language
      ]);
    }

    const previousState = conversation.current_state;

    if (outcome.decision.route === "stop") {
      await client.query("UPDATE conversation.messages SET status = 'read' WHERE id = ANY($1::uuid[])", [messageIds]);
      await client.query("UPDATE conversation.message_batches SET status = 'completed', completed_at = now() WHERE id = $1", [batchId]);
      const aiRunId = await recordAiRun(client, {
        organizationId: conversation.organization_id,
        conversationId,
        batchId,
        mode: "live",
        environment: conversation.environment,
        correlationId,
        inputPayload: { messages: messageIds, text },
        outcome,
        releaseId: cfg.release?.id ?? null,
        ruleVersionId: cfg.ruleVersionId
      });
      return { conversationId, batchId, aiRunId, decision: outcome.decision, status: "human_mode_locked" };
    }

    if (outcome.decision.route === "human") {
      await createHandover(client, conversation, outcome.decision, text, correlationId, conversation.environment);
    } else {
      await client.query(
        `UPDATE conversation.conversations
         SET current_state = $2, selected_course_id = COALESCE($3, selected_course_id), unread_count = 0,
             last_message_at = now(), version = version + 1
         WHERE id = $1`,
        [conversationId, outcome.decision.stage, outcome.course?.course?.id ?? null]
      );
      if (previousState !== outcome.decision.stage) {
        await client.query(
          `INSERT INTO conversation.state_transitions(
             organization_id, conversation_id, from_state, to_state, trigger, reason, rule_version_id
           ) VALUES ($1,$2,$3,$4,'classifier',$5,$6)`,
          [
            conversation.organization_id,
            conversationId,
            previousState,
            outcome.decision.stage,
            outcome.decision.signals.join(","),
            cfg.ruleVersionId
          ]
        );
      }
    }

    const aiRunId = await recordAiRun(client, {
      organizationId: conversation.organization_id,
      conversationId,
      batchId,
      mode: "live",
      environment: conversation.environment,
      correlationId,
      inputPayload: { messages: messageIds, text },
      outcome,
      releaseId: cfg.release?.id ?? null,
      ruleVersionId: cfg.ruleVersionId
    });

    const outboundMessageIds = await createOutboundMessages(client, {
      organizationId: conversation.organization_id,
      conversationId,
      environment: conversation.environment,
      text: outcome.final,
      correlationId,
      aiRunId
    });
    await client.query(
      "UPDATE platform.ai_runs SET output = jsonb_set(output, '{message_ids}', $2::jsonb) WHERE id = $1",
      [aiRunId, JSON.stringify(outboundMessageIds)]
    );
    await client.query("UPDATE conversation.messages SET status = 'read' WHERE id = ANY($1::uuid[])", [messageIds]);
    await client.query("UPDATE conversation.message_batches SET status = 'completed', completed_at = now() WHERE id = $1", [batchId]);

    await emitEvent(client, {
      eventType: "conversation.state.changed",
      organizationId: conversation.organization_id,
      correlationId,
      aggregate: { type: "conversation", id: conversationId },
      payload: { fromState: previousState, toState: outcome.decision.stage, route: outcome.decision.route, aiRunId }
    });
    for (const messageId of outboundMessageIds) {
      await emitEvent(client, {
        eventType: "conversation.message.created",
        organizationId: conversation.organization_id,
        correlationId,
        aggregate: { type: "conversation", id: conversationId },
        payload: { messageId, direction: "outbound", status: "queued" }
      });
    }
    return { conversationId, batchId, aiRunId, decision: outcome.decision, outboundMessageIds, status: outcome.status };
  });
}

/**
 * Chạy một lượt AI không gắn hội thoại — dùng cho preview prompt và
 * Evaluation. Dùng CHUNG executeTurn với đường live, chỉ khác là không tạo
 * outbound message và không đổi trạng thái hội thoại.
 */
export async function previewConversationResponse(input: {
  organizationId: string;
  message: string;
  state?: string;
  botMode?: string;
  releaseId?: string | null;
  mode?: RunMode;
  language?: string | null;
  segment?: string | null;
  contactName?: string;
  persistTrace?: boolean;
  correlationId?: string;
}) {
  return withTransaction(async (client) => {
    const cfg = await resolveRuntimeConfig(client, {
      organizationId: input.organizationId,
      environment: "test",
      releaseId: input.releaseId ?? null
    });
    const outcome = await executeTurn(
      client,
      {
        organizationId: input.organizationId,
        mode: input.mode ?? "eval",
        environment: "test",
        text: input.message,
        botMode: input.botMode ?? "bot",
        currentState: input.state ?? "NEW",
        contactName: input.contactName,
        segment: input.segment ?? null,
        conversationLanguage: input.language ?? null,
        inboundCount: 1
      },
      cfg
    );
    if (input.persistTrace) {
      await recordAiRun(client, {
        organizationId: input.organizationId,
        mode: input.mode ?? "eval",
        environment: "test",
        correlationId: input.correlationId ?? randomUUID(),
        inputPayload: { text: input.message, state: input.state ?? "NEW" },
        outcome,
        releaseId: cfg.release?.id ?? null,
        ruleVersionId: cfg.ruleVersionId
      });
    }
    return toPreviewResult(outcome, cfg.release);
  });
}

export function toPreviewResult(outcome: TurnOutcome, release: { id: string; release_code: string; status: string } | null) {
  return {
    decision: outcome.decision,
    draft: outcome.draft,
    final: outcome.final,
    language: outcome.language,
    provider: outcome.provider,
    model: outcome.model,
    status: outcome.status,
    validation: outcome.validation,
    prompt: { id: outcome.prompt.id, code: outcome.prompt.code, source: outcome.prompt.source },
    flow: outcome.prompt.flow,
    toolCalls: outcome.toolCalls,
    knowledge: outcome.knowledge,
    course: outcome.course?.course ?? null,
    pricing: outcome.pricing,
    requiredTool: outcome.requiredTool,
    release: release ? { id: release.id, code: release.release_code, status: release.status } : null,
    error: outcome.error
  };
}

export async function ingestInboundMessage(input: {
  organizationId?: string;
  channelAccountId: string;
  externalUserId: string;
  externalMessageId: string;
  text: string;
  timestamp?: number;
  displayName?: string;
  environment?: Environment;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}) {
  const organizationId = input.organizationId ?? ORGANIZATION_ID;
  const correlationId = input.correlationId ?? randomUUID();
  const environment: Environment = input.environment ?? "live";
  return withTransaction(async (client) => {
    const blocked = await client.query(
      `SELECT 1 FROM channel.blocked_accounts
       WHERE organization_id = $1 AND channel_account_id = $2 AND external_account_id = $3
         AND (expires_at IS NULL OR expires_at > now())`,
      [organizationId, input.channelAccountId, input.externalUserId]
    );
    if (blocked.rowCount) return { status: "blocked", correlationId };

    const identity = await client.query<{ contact_id: string }>(
      "SELECT contact_id FROM conversation.contact_identities WHERE channel_account_id = $1 AND external_user_id = $2",
      [input.channelAccountId, input.externalUserId]
    );
    let contactId = identity.rows[0]?.contact_id;
    if (!contactId) {
      const contact = await client.query<{ id: string }>(
        `INSERT INTO conversation.contacts(organization_id, display_name)
         VALUES ($1,$2) RETURNING id`,
        [organizationId, input.displayName ?? `Messenger ${input.externalUserId.slice(-6)}`]
      );
      contactId = contact.rows[0]!.id;
      await client.query(
        `INSERT INTO conversation.contact_identities(organization_id, contact_id, channel_account_id, external_user_id)
         VALUES ($1,$2,$3,$4)`,
        [organizationId, contactId, input.channelAccountId, input.externalUserId]
      );
    }

    const conversationResult = await client.query<{ id: string }>(
      `INSERT INTO conversation.conversations(
         organization_id, channel_account_id, contact_id, external_thread_id, environment, last_message_at, unread_count
       ) VALUES ($1,$2,$3,$4,$5,now(),1)
       ON CONFLICT (organization_id, channel_account_id, environment, external_thread_id)
       DO UPDATE SET last_message_at = now(), unread_count = conversation.conversations.unread_count + 1, version = conversation.conversations.version + 1
       RETURNING id`,
      [organizationId, input.channelAccountId, contactId, input.externalUserId, environment]
    );
    const conversationId = conversationResult.rows[0]!.id;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO conversation.messages(
         organization_id, conversation_id, direction, sender_type, external_message_id,
         raw_text, normalized_text, status, correlation_id, metadata, detected_language, created_at
       ) VALUES ($1,$2,'inbound','customer',$3,$4,$4,'pending',$5,$6,$7,$8)
       ON CONFLICT (organization_id, conversation_id, external_message_id) DO NOTHING
       RETURNING id`,
      [
        organizationId,
        conversationId,
        input.externalMessageId,
        input.text,
        correlationId,
        JSON.stringify(input.metadata ?? {}),
        detectLanguage(input.text),
        input.timestamp ? new Date(input.timestamp) : new Date()
      ]
    );
    if (!inserted.rowCount) return { status: "duplicate", conversationId, correlationId };

    const debounceSeconds = await resolveDebounceSeconds(client, organizationId, input.channelAccountId);
    const runAt = new Date(Date.now() + debounceSeconds * 1000);

    /**
     * Sliding debounce (5.3): idempotency key theo HỘI THOẠI, không theo tin
     * nhắn, nên mỗi hội thoại chỉ có đúng một job đang chờ. `pushBack` đẩy
     * thời điểm chạy LÙI lại mỗi khi có tin mới, thay vì kéo sớm lên.
     */
    await enqueueJob(
      client,
      organizationId,
      "PROCESS_CONVERSATION",
      { conversationId, correlationId },
      `process-conversation:${conversationId}`,
      runAt,
      50,
      { pushBack: true }
    );
    await client.query(
      `UPDATE conversation.message_batches SET debounce_until = $2
       WHERE conversation_id = $1 AND status = 'pending'`,
      [conversationId, runAt]
    );

    await emitEvent(client, {
      eventType: "conversation.message.created",
      organizationId,
      correlationId,
      aggregate: { type: "conversation", id: conversationId },
      payload: { messageId: inserted.rows[0]!.id, direction: "inbound", status: "pending", environment, debounceUntil: runAt.toISOString() }
    });
    return { status: "accepted", conversationId, messageId: inserted.rows[0]!.id, correlationId, debounceUntil: runAt.toISOString() };
  });
}

async function resolveDebounceSeconds(client: PoolClient, organizationId: string, channelAccountId: string) {
  const result = await client.query<{ debounce_seconds: number | null; channel_debounce: number | null }>(
    `SELECT s.debounce_seconds,
            NULLIF(a.policy->>'debounceSeconds','')::int AS channel_debounce
     FROM channel.accounts a
     LEFT JOIN platform.runtime_settings s ON s.organization_id = $1
     WHERE a.id = $2`,
    [organizationId, channelAccountId]
  );
  const row = result.rows[0];
  return row?.channel_debounce ?? row?.debounce_seconds ?? config.DEBOUNCE_SECONDS;
}

export async function normalizeWebhookEvent(webhookEventId: string) {
  const eventResult = await query<{
    id: string;
    organization_id: string;
    channel_account_id: string;
    raw_payload: { entry?: Array<{ id?: string; messaging?: Array<Record<string, any>> }> };
    correlation_id: string;
  }>(
    "SELECT id, organization_id, channel_account_id, raw_payload, correlation_id FROM channel.webhook_events WHERE id = $1",
    [webhookEventId]
  );
  const event = eventResult.rows[0];
  if (!event) throw new Error("Webhook event not found");
  await query("UPDATE channel.webhook_events SET status = 'processing' WHERE id = $1", [webhookEventId]);
  let accepted = 0;
  for (const entry of event.raw_payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const senderId = messaging.sender?.id;
      const messageId = messaging.message?.mid;
      const attachments = messaging.message?.attachments ?? [];
      // Attachment chưa được xử lý nội dung — Đợt 4 (5.4). Tạm ghi nhận để
      // không mất tin, và đánh dấu rõ trong metadata thay vì giả vờ là text.
      const text = messaging.message?.text ?? "";
      if (!senderId || !messageId || (!text && !attachments.length)) continue;
      const result = await ingestInboundMessage({
        organizationId: event.organization_id,
        channelAccountId: event.channel_account_id,
        externalUserId: String(senderId),
        externalMessageId: String(messageId),
        text: String(text || "[attachment]"),
        environment: "live",
        timestamp: Number(messaging.timestamp ?? Date.now()),
        correlationId: event.correlation_id,
        metadata: {
          webhook_event_id: webhookEventId,
          page_id: entry.id,
          attachments,
          attachment_processing: attachments.length ? "unsupported_pending_phase_4" : null
        }
      });
      if (result.status === "accepted") accepted += 1;
    }
  }
  await query("UPDATE channel.webhook_events SET status = 'processed', processed_at = now() WHERE id = $1", [webhookEventId]);
  return { webhookEventId, accepted };
}

export function webhookPayloadHash(raw: Buffer) {
  return createHash("sha256").update(raw).digest("hex");
}
