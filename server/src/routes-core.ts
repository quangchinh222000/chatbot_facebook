import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clearSessionCookie, createSession, loginWithPassword, requirePermission, setSessionCookie } from "./auth.js";
import { config, runtimeMode } from "./config.js";
import { pool, query, withTransaction } from "./db.js";
import { eventBus } from "./events.js";
import { collectHealth } from "./health.js";
import { createHttpError, sendData } from "./http.js";
import { getPricingQuote } from "./knowledge.js";
import { enqueueJob, emitEvent, publishOutbox, writeAudit } from "./platform.js";
import { ingestInboundMessage, webhookPayloadHash } from "./orchestrator.js";
import { DEMO_CHANNEL_ID, ORGANIZATION_ID, SALES_TEAM_ID } from "./types.js";

const loginSchema = z.object({ email: z.email(), password: z.string().min(8) });
const messageSchema = z.object({ text: z.string().min(1).max(10_000) });
const takeoverSchema = z.object({
  reasonCode: z.string().min(2).default("MANUAL_TAKEOVER"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  note: z.string().max(2000).optional(),
  assignedUserId: z.uuid().optional()
});

function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined) {
  if (!config.META_APP_SECRET) return config.DEMO_MODE;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", config.META_APP_SECRET).update(rawBody).digest("hex");
  const provided = signatureHeader.slice(7);
  return expected.length === provided.length && timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function verifyN8nSecret(secretHeader: string | undefined) {
  if (!config.N8N_WEBHOOK_SECRET) return config.DEMO_MODE;
  if (!secretHeader) return false;
  return secretHeader.length === config.N8N_WEBHOOK_SECRET.length
    && timingSafeEqual(Buffer.from(secretHeader), Buffer.from(config.N8N_WEBHOOK_SECRET));
}

async function enqueueRawWebhook(input: {
  channelAccountId: string;
  organizationId: string;
  payload: Record<string, any>;
  rawBody: Buffer;
  correlationId: string;
}) {
  const hash = webhookPayloadHash(input.rawBody);
  const externalId = input.payload?.entry?.[0]?.messaging?.[0]?.message?.mid ?? null;
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO channel.webhook_events(
         organization_id, channel_account_id, provider_event_id, payload_hash, raw_payload,
         signature_valid, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,true,$6)
       ON CONFLICT (channel_account_id, payload_hash) DO NOTHING
       RETURNING id`,
      [input.organizationId, input.channelAccountId, externalId, hash, JSON.stringify(input.payload), input.correlationId]
    );
    if (!inserted.rowCount) return { duplicate: true as const };
    const webhookEventId = inserted.rows[0]!.id;
    await enqueueJob(client, input.organizationId, "PROCESS_WEBHOOK", { webhookEventId, correlationId: input.correlationId }, `webhook:${webhookEventId}`, new Date(), 10);
    return { webhookEventId, duplicate: false as const };
  });
}

export async function registerCoreRoutes(app: FastifyInstance) {
  /**
   * Liveness cho Docker healthcheck — phải nhẹ và không phụ thuộc dịch vụ
   * ngoài, nếu không một MinIO chậm sẽ làm container API bị restart oan.
   */
  app.get("/api/v1/health", async (request, reply) => {
    const db = await query<{ now: string }>("SELECT now()::text");
    return sendData(request, reply, {
      status: "ok",
      service: "tm-ai-operations-api",
      environment: config.APP_ENV,
      runtime_mode: runtimeMode,
      database_time: db.rows[0]?.now,
      demo_mode: config.DEMO_MODE
    });
  });

  /** Readiness chi tiết từng thành phần — nguồn dữ liệu cho màn hình System Status. */
  app.get("/api/v1/health/detailed", async (request, reply) => {
    requirePermission(request);
    return sendData(request, reply, await collectHealth());
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await loginWithPassword(body.email, body.password);
    if (!user) throw createHttpError(401, "INVALID_CREDENTIALS", "The email address or password is incorrect.");
    setSessionCookie(reply, await createSession(user));
    return sendData(request, reply, user);
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    clearSessionCookie(reply);
    return sendData(request, reply, { loggedOut: true });
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    return sendData(request, reply, request.user);
  });

  app.get("/api/v1/webhooks/meta/:channelAccountId", async (request, reply) => {
    const params = request.params as { channelAccountId: string };
    const queryValues = request.query as Record<string, string | undefined>;
    if (queryValues["hub.mode"] !== "subscribe" || !queryValues["hub.challenge"]) {
      throw createHttpError(400, "INVALID_VERIFICATION", "Meta verification parameters are invalid");
    }
    const account = await query("SELECT id FROM channel.accounts WHERE id = $1", [params.channelAccountId]);
    if (!account.rowCount) throw createHttpError(404, "CHANNEL_NOT_FOUND", "Channel account not found");
    if (config.META_VERIFY_TOKEN && queryValues["hub.verify_token"] !== config.META_VERIFY_TOKEN) {
      throw createHttpError(403, "VERIFY_TOKEN_MISMATCH", "Verify token mismatch");
    }
    return reply.type("text/plain").send(queryValues["hub.challenge"]);
  });

  app.post("/api/v1/webhooks/meta/:channelAccountId", async (request, reply) => {
    const { channelAccountId } = request.params as { channelAccountId: string };
    const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));
    const signatureValid = verifyMetaSignature(rawBody, request.headers["x-hub-signature-256"] as string | undefined);
    if (!signatureValid) throw createHttpError(401, "INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid");
    const account = await query<{ organization_id: string }>("SELECT organization_id FROM channel.accounts WHERE id = $1", [channelAccountId]);
    const channel = account.rows[0];
    if (!channel) throw createHttpError(404, "CHANNEL_NOT_FOUND", "Channel account not found");
    const payload = request.body as Record<string, any>;
    const correlationId = randomUUID();
    const result = await enqueueRawWebhook({ channelAccountId, organizationId: channel.organization_id, payload, rawBody, correlationId });
    reply.header("x-correlation-id", correlationId);
    return reply.type("text/plain").send(result.duplicate ? "EVENT_DUPLICATE" : "EVENT_RECEIVED");
  });

  app.post("/api/v1/webhooks/n8n/:channelAccountId", async (request, reply) => {
    const { channelAccountId } = request.params as { channelAccountId: string };
    if (!verifyN8nSecret(request.headers["x-tm-webhook-secret"] as string | undefined)) {
      throw createHttpError(401, "INVALID_N8N_WEBHOOK_SECRET", "The n8n webhook secret is invalid.");
    }
    const account = await query<{ organization_id: string }>("SELECT organization_id FROM channel.accounts WHERE id=$1", [channelAccountId]);
    const channel = account.rows[0];
    if (!channel) throw createHttpError(404, "CHANNEL_NOT_FOUND", "Channel account not found.");
    const rawPayload = (request.body ?? {}) as Record<string, any>;
    const candidate = rawPayload.body && typeof rawPayload.body === "object" ? rawPayload.body : rawPayload;
    if (Array.isArray(candidate.entry)) {
      const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(candidate));
      const queued = await enqueueRawWebhook({ channelAccountId, organizationId: channel.organization_id, payload: candidate, rawBody, correlationId: request.correlationId });
      return sendData(request, reply, { mode: "raw_meta", ...queued }, queued.duplicate ? 200 : 202);
    }
    const message = candidate.message && typeof candidate.message === "object" ? candidate.message : {};
    const sender = candidate.sender && typeof candidate.sender === "object" ? candidate.sender : {};
    const normalized = z.object({
      externalUserId: z.string().min(1),
      externalMessageId: z.string().min(1),
      text: z.string().min(1).max(10_000),
      timestamp: z.number().positive().optional(),
      displayName: z.string().min(1).max(200).optional(),
      attachments: z.array(z.unknown()).default([])
    }).parse({
      externalUserId: candidate.sender_id ?? candidate.senderId ?? candidate.psid ?? sender.id,
      externalMessageId: candidate.message_id ?? candidate.messageId ?? candidate.mid ?? message.mid,
      text: candidate.text ?? message.text,
      timestamp: candidate.timestamp == null ? undefined : Number(candidate.timestamp) < 1_000_000_000_000 ? Number(candidate.timestamp) * 1000 : Number(candidate.timestamp),
      displayName: candidate.display_name ?? candidate.displayName,
      attachments: candidate.attachments ?? message.attachments ?? []
    });
    const result = await ingestInboundMessage({
      organizationId: channel.organization_id,
      channelAccountId,
      externalUserId: normalized.externalUserId,
      externalMessageId: normalized.externalMessageId,
      text: normalized.text,
      timestamp: normalized.timestamp,
      displayName: normalized.displayName,
      environment: "live",
      correlationId: request.correlationId,
      metadata: { source: "n8n_bridge", attachments: normalized.attachments, raw: candidate.raw ?? null }
    });
    return sendData(request, reply, { mode: "normalized", ...result }, result.status === "accepted" ? 202 : 200);
  });

  app.get("/api/v1/integrations/status", async (request, reply) => {
    requirePermission(request);
    const channel = await query<{ id: string; name: string; provider: string; status: string }>(
      "SELECT id,name,provider,status FROM channel.accounts WHERE id=$1",
      [DEMO_CHANNEL_ID]
    );
    const base = config.PUBLIC_WEBHOOK_BASE_URL.replace(/\/$/, "");
    const dockerBase = base.replace("localhost", "host.docker.internal").replace("127.0.0.1", "host.docker.internal");
    return sendData(request, reply, {
      channel: channel.rows[0] ?? null,
      endpoints: {
        n8n: `${base}/api/v1/webhooks/n8n/${DEMO_CHANNEL_ID}`,
        n8nDocker: `${dockerBase}/api/v1/webhooks/n8n/${DEMO_CHANNEL_ID}`,
        meta: `${base}/api/v1/webhooks/meta/${DEMO_CHANNEL_ID}`
      },
      runtimeMode,
      demoMode: config.DEMO_MODE,
      // Readiness phản ánh credential thật. Trước đây DEMO_MODE làm n8n hiện
      // "sẵn sàng" kể cả khi chưa có secret nào — vi phạm yêu cầu 5.16.
      readiness: {
        n8n: Boolean(config.N8N_WEBHOOK_SECRET),
        n8nSecretConfigured: Boolean(config.N8N_WEBHOOK_SECRET),
        meta: Boolean(config.META_APP_SECRET && config.META_VERIFY_TOKEN && config.META_PAGE_ACCESS_TOKEN && config.META_PAGE_ID),
        modelGateway: Boolean(config.OPENAI_API_KEY),
        /** Demo Mode chặn mọi lời gọi ra ngoài, kể cả khi credential đã đủ. */
        outboundEnabled: !config.DEMO_MODE && (config.APP_ENV === "production" || config.APP_ENV === "staging")
      },
      n8n: {
        method: "POST",
        secretHeader: "x-tm-webhook-secret",
        acceptedPayloads: ["normalized", "raw_meta"],
        normalizedFields: ["sender_id", "message_id", "text", "timestamp", "display_name", "attachments"]
      }
    });
  });

  app.get("/api/v1/events", async (request, reply) => {
    requirePermission(request);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": config.WEB_ORIGIN,
      "Access-Control-Allow-Credentials": "true"
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
    const listener = (event: { organizationId?: string; eventId?: string }) => {
      if (event.organizationId && event.organizationId !== request.user?.organizationId) return;
      reply.raw.write(`id: ${event.eventId ?? randomUUID()}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
    };
    eventBus.on("event", listener);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 20_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      eventBus.off("event", listener);
    });
  });

  app.get("/api/v1/dashboard/summary", async (request, reply) => {
    const user = requirePermission(request, "dashboard.view");
    const [conversations, cases, jobs, documents, release, notifications] = await Promise.all([
      query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE bot_mode = 'bot')::int AS bot_active,
                count(*) FILTER (WHERE bot_mode = 'human')::int AS human_active,
                count(*) FILTER (WHERE unread_count > 0)::int AS unread
         FROM conversation.conversations WHERE organization_id = $1`,
        [user.organizationId]
      ),
      query(
        `SELECT count(*) FILTER (WHERE status <> 'resolved')::int AS open,
                count(*) FILTER (WHERE assigned_user_id IS NULL AND status <> 'resolved')::int AS unassigned,
                count(*) FILTER (WHERE sla_due_at < now() AND status <> 'resolved')::int AS breached,
                count(*) FILTER (WHERE sla_due_at BETWEEN now() AND now() + interval '15 minutes' AND status <> 'resolved')::int AS due_soon
         FROM case_mgmt.cases WHERE organization_id = $1`,
        [user.organizationId]
      ),
      query(
        `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                COALESCE(max(EXTRACT(EPOCH FROM (now() - created_at))) FILTER (WHERE status = 'queued'),0)::int AS oldest_age_seconds
         FROM platform.jobs WHERE organization_id = $1`,
        [user.organizationId]
      ),
      query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status IN ('draft','in_review'))::int AS pending,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM knowledge.documents WHERE organization_id = $1`,
        [user.organizationId]
      ),
      query(
        `SELECT id, release_code, status, manifest, activated_at
         FROM studio.releases WHERE organization_id = $1 AND environment = $2 AND status IN ('active','canary')
         ORDER BY activated_at DESC NULLS LAST LIMIT 1`,
        [user.organizationId, config.APP_ENV === "production" ? "production" : "development"]
      ),
      query(
        `SELECT id, type, title, body, severity, entity_type, entity_id, created_at
         FROM platform.notifications WHERE organization_id = $1 AND (user_id = $2 OR user_id IS NULL)
         ORDER BY created_at DESC LIMIT 8`,
        [user.organizationId, user.id]
      )
    ]);
    return sendData(request, reply, {
      conversations: conversations.rows[0],
      cases: cases.rows[0],
      jobs: jobs.rows[0],
      documents: documents.rows[0],
      release: release.rows[0] ?? null,
      notifications: notifications.rows
    });
  });

  app.get("/api/v1/conversations", async (request, reply) => {
    const user = requirePermission(request, "conversation.read.team");
    const filters = request.query as Record<string, string | undefined>;
    const result = await query(
      `SELECT c.id, c.environment, c.bot_mode, c.current_state, c.priority, c.unread_count, c.last_message_at,
              c.assigned_user_id, ct.display_name AS contact_name, ct.segment, ct.tags,
              a.name AS channel_name, co.name AS course_name,
              lm.raw_text AS last_message, lm.direction AS last_direction,
              active_case.id AS case_id, active_case.status AS case_status, active_case.sla_due_at
       FROM conversation.conversations c
       JOIN conversation.contacts ct ON ct.id = c.contact_id
       JOIN channel.accounts a ON a.id = c.channel_account_id
       LEFT JOIN catalog.courses co ON co.id = c.selected_course_id
       LEFT JOIN LATERAL (
         SELECT raw_text, direction FROM conversation.messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
       ) lm ON true
       LEFT JOIN LATERAL (
         SELECT id, status, sla_due_at FROM case_mgmt.cases WHERE conversation_id = c.id AND status <> 'resolved' ORDER BY created_at DESC LIMIT 1
       ) active_case ON true
       WHERE c.organization_id = $1
         AND ($2::text IS NULL OR c.bot_mode = $2)
         AND ($3::text IS NULL OR c.current_state = $3)
         AND ($4::text IS NULL OR ct.display_name ILIKE '%' || $4 || '%' OR lm.raw_text ILIKE '%' || $4 || '%')
         AND ($5::text IS NULL OR c.environment = $5)
       ORDER BY c.last_message_at DESC NULLS LAST LIMIT 100`,
      [user.organizationId, filters.mode ?? null, filters.state ?? null, filters.search ?? null, filters.environment ?? null]
    );
    return sendData(request, reply, result.rows);
  });

  app.get("/api/v1/conversations/:id", async (request, reply) => {
    const user = requirePermission(request, "conversation.read.team");
    const { id } = request.params as { id: string };
    const [conversation, messages, cases, traces] = await Promise.all([
      query(
        `SELECT c.*, ct.display_name AS contact_name, ct.phone, ct.email::text, ct.segment, ct.tags, ct.profile,
                a.name AS channel_name, co.name AS course_name
         FROM conversation.conversations c
         JOIN conversation.contacts ct ON ct.id = c.contact_id
         JOIN channel.accounts a ON a.id = c.channel_account_id
         LEFT JOIN catalog.courses co ON co.id = c.selected_course_id
         WHERE c.id = $1 AND c.organization_id = $2`,
        [id, user.organizationId]
      ),
      query(
        `SELECT id, direction, sender_type, raw_text, message_type, status, metadata,
                created_at, sent_at, delivered_at, read_at
         FROM conversation.messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [id]
      ),
      query("SELECT * FROM case_mgmt.cases WHERE conversation_id = $1 ORDER BY created_at DESC", [id]),
      query(
        `SELECT id, purpose, provider, model, decision, validation, latency_ms, status, created_at
         FROM platform.ai_runs WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [id]
      )
    ]);
    if (!conversation.rowCount) throw createHttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    await query("UPDATE conversation.conversations SET unread_count = 0 WHERE id = $1", [id]);
    return sendData(request, reply, { ...conversation.rows[0], messages: messages.rows, cases: cases.rows, traces: traces.rows });
  });

  app.post("/api/v1/conversations/:id/messages", async (request, reply) => {
    const user = requirePermission(request, "conversation.reply.assigned");
    const { id } = request.params as { id: string };
    const body = messageSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const conversation = await client.query<{ organization_id: string; bot_mode: string }>(
        "SELECT organization_id, bot_mode FROM conversation.conversations WHERE id = $1 FOR UPDATE",
        [id]
      );
      const row = conversation.rows[0];
      if (!row) throw createHttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
      if (row.bot_mode !== "human") throw createHttpError(409, "HUMAN_MODE_REQUIRED", "Take over the conversation before sending an agent reply.");
      const message = await client.query<{ id: string }>(
        `INSERT INTO conversation.messages(
           organization_id, conversation_id, direction, sender_type, raw_text, normalized_text, status, correlation_id,
           metadata
         ) VALUES ($1,$2,'outbound','agent',$3,$3,'queued',$4,$5) RETURNING id`,
        [row.organization_id, id, body.text, request.correlationId, JSON.stringify({ actor_id: user.id })]
      );
      const messageId = message.rows[0]!.id;
      await publishOutbox(client, row.organization_id, "message", messageId, "channel.message.send", { messageId, conversationId: id, text: body.text }, `send:${messageId}`);
      await writeAudit(client, user, "conversation.message.send", "conversation", id, null, { messageId, text: body.text }, request.correlationId, request.ip);
      await emitEvent(client, {
        eventType: "conversation.message.created",
        organizationId: row.organization_id,
        correlationId: request.correlationId,
        aggregate: { type: "conversation", id },
        payload: { messageId, direction: "outbound", senderType: "agent", status: "queued" }
      });
      return { messageId, status: "queued" };
    });
    return sendData(request, reply, result, 201);
  });

  app.post("/api/v1/conversations/:id/takeover", async (request, reply) => {
    const user = requirePermission(request, "conversation.takeover");
    const { id } = request.params as { id: string };
    const body = takeoverSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const conversation = await client.query<{ organization_id: string; current_state: string; bot_mode: string }>(
        "SELECT organization_id, current_state, bot_mode FROM conversation.conversations WHERE id = $1 FOR UPDATE",
        [id]
      );
      const row = conversation.rows[0];
      if (!row) throw createHttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
      const existing = await client.query<{ id: string }>("SELECT id FROM case_mgmt.cases WHERE conversation_id = $1 AND status <> 'resolved'", [id]);
      const caseId = existing.rows[0]?.id ?? (
        await client.query<{ id: string }>(
          `INSERT INTO case_mgmt.cases(
             organization_id, conversation_id, reason_code, summary, priority, assigned_team_id, assigned_user_id, sla_due_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '30 minutes') RETURNING id`,
          [row.organization_id, id, body.reasonCode, body.note ?? "An agent manually took over the conversation.", body.priority, SALES_TEAM_ID, body.assignedUserId ?? user.id]
        )
      ).rows[0]!.id;
      await client.query(
        "UPDATE conversation.conversations SET bot_mode = 'human', current_state = 'HUMAN', assigned_user_id = $2, priority = $3, version = version + 1 WHERE id = $1",
        [id, body.assignedUserId ?? user.id, body.priority]
      );
      await client.query(
        `UPDATE conversation.messages SET status = 'cancelled'
         WHERE conversation_id = $1 AND direction = 'outbound' AND sender_type = 'bot' AND status IN ('generated','queued')`,
        [id]
      );
      await client.query(
        "INSERT INTO case_mgmt.events(case_id, event_type, actor_id, payload) VALUES ($1,'takeover',$2,$3)",
        [caseId, user.id, JSON.stringify(body)]
      );
      await writeAudit(client, user, "conversation.takeover", "conversation", id, { bot_mode: row.bot_mode }, { bot_mode: "human", case_id: caseId }, request.correlationId, request.ip);
      await emitEvent(client, {
        eventType: "conversation.mode.changed",
        organizationId: row.organization_id,
        correlationId: request.correlationId,
        aggregate: { type: "conversation", id },
        payload: { botMode: "human", caseId, actorId: user.id }
      });
      return { conversationId: id, caseId, botMode: "human", status: "open" };
    });
    return sendData(request, reply, result, 201);
  });

  app.post("/api/v1/conversations/:id/release", async (request, reply) => {
    const user = requirePermission(request, "conversation.release_bot");
    const { id } = request.params as { id: string };
    const body = z.object({
      targetState: z.enum(["ICE_BREAK", "QUALIFICATION", "QNA_COURSE", "QNA_PRICE", "RESOLVED"]).default("QUALIFICATION"),
      note: z.string().max(2000).optional()
    }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const current = await client.query<{ organization_id: string; current_state: string; bot_mode: string }>(
        "SELECT organization_id, current_state, bot_mode FROM conversation.conversations WHERE id = $1 FOR UPDATE",
        [id]
      );
      const row = current.rows[0];
      if (!row) throw createHttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
      await client.query(
        "UPDATE conversation.conversations SET bot_mode = 'bot', current_state = $2, version = version + 1 WHERE id = $1",
        [id, body.targetState]
      );
      await client.query(
        `UPDATE case_mgmt.cases SET status = 'resolved', resolved_at = now(), resolution_code = 'RETURN_TO_BOT', resolution_summary = $2
         WHERE conversation_id = $1 AND status <> 'resolved'`,
        [id, body.note ?? "Returned the conversation to the bot."]
      );
      await client.query(
        `INSERT INTO conversation.state_transitions(organization_id, conversation_id, from_state, to_state, trigger, reason)
         VALUES ($1,$2,$3,$4,'agent_release',$5)`,
        [row.organization_id, id, row.current_state, body.targetState, body.note]
      );
      await writeAudit(client, user, "conversation.release_bot", "conversation", id, row, { bot_mode: "bot", current_state: body.targetState }, request.correlationId, request.ip);
      await emitEvent(client, {
        eventType: "conversation.mode.changed",
        organizationId: row.organization_id,
        correlationId: request.correlationId,
        aggregate: { type: "conversation", id },
        payload: { botMode: "bot", state: body.targetState, actorId: user.id }
      });
      return { conversationId: id, botMode: "bot", state: body.targetState };
    });
    return sendData(request, reply, result);
  });

  app.get("/api/v1/cases", async (request, reply) => {
    const user = requirePermission(request, "conversation.read.team");
    const filters = request.query as Record<string, string | undefined>;
    const result = await query(
      `SELECT c.*, ct.display_name AS contact_name, conv.current_state, conv.bot_mode,
              u.display_name AS assignee_name,
              GREATEST(EXTRACT(EPOCH FROM (c.sla_due_at - now())),0)::int AS sla_seconds_remaining
       FROM case_mgmt.cases c
       JOIN conversation.conversations conv ON conv.id = c.conversation_id
       JOIN conversation.contacts ct ON ct.id = conv.contact_id
       LEFT JOIN iam.users u ON u.id = c.assigned_user_id
       WHERE c.organization_id = $1 AND ($2::text IS NULL OR c.status = $2)
       ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                c.sla_due_at ASC NULLS LAST LIMIT 200`,
      [user.organizationId, filters.status ?? null]
    );
    return sendData(request, reply, result.rows);
  });

  app.get("/api/v1/cases/:id", async (request, reply) => {
    const user = requirePermission(request, "conversation.read.team");
    const { id } = request.params as { id: string };
    const [caseResult, notes, events] = await Promise.all([
      query(
        `SELECT c.*, ct.display_name AS contact_name, conv.current_state, conv.bot_mode, conv.id AS conversation_id,
                u.display_name AS assignee_name, t.name AS team_name
         FROM case_mgmt.cases c
         JOIN conversation.conversations conv ON conv.id = c.conversation_id
         JOIN conversation.contacts ct ON ct.id = conv.contact_id
         LEFT JOIN iam.users u ON u.id = c.assigned_user_id
         LEFT JOIN iam.teams t ON t.id = c.assigned_team_id
         WHERE c.id = $1 AND c.organization_id = $2`,
        [id, user.organizationId]
      ),
      query("SELECT n.*, u.display_name AS author_name FROM case_mgmt.notes n LEFT JOIN iam.users u ON u.id=n.author_id WHERE case_id=$1 ORDER BY created_at", [id]),
      query("SELECT * FROM case_mgmt.events WHERE case_id=$1 ORDER BY created_at", [id])
    ]);
    if (!caseResult.rowCount) throw createHttpError(404, "CASE_NOT_FOUND", "Case not found.");
    return sendData(request, reply, { ...caseResult.rows[0], notes: notes.rows, events: events.rows });
  });

  app.patch("/api/v1/cases/:id", async (request, reply) => {
    const user = requirePermission(request, "case.assign.team");
    const { id } = request.params as { id: string };
    const body = z.object({
      status: z.enum(["new","assigned","in_progress","waiting_customer","escalated","resolved","reopened"]).optional(),
      priority: z.enum(["low","normal","high","urgent"]).optional(),
      assignedUserId: z.uuid().nullable().optional(),
      resolutionCode: z.string().max(100).optional(),
      resolutionSummary: z.string().max(2000).optional(),
      note: z.string().max(2000).optional(),
      version: z.number().int().positive().optional()
    }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const before = await client.query<any>("SELECT * FROM case_mgmt.cases WHERE id = $1 FOR UPDATE", [id]);
      const current = before.rows[0];
      if (!current) throw createHttpError(404, "CASE_NOT_FOUND", "Case not found.");
      if (body.version && body.version !== current.version) throw createHttpError(409, "VERSION_CONFLICT", "This case was updated by another user.", { currentVersion: current.version });
      const updated = await client.query<any>(
        `UPDATE case_mgmt.cases SET
           status = COALESCE($2,status), priority = COALESCE($3,priority),
           assigned_user_id = CASE WHEN $4::boolean THEN $5::uuid ELSE assigned_user_id END,
           resolution_code = COALESCE($6,resolution_code), resolution_summary = COALESCE($7,resolution_summary),
           resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE resolved_at END,
           version = version + 1
         WHERE id = $1 RETURNING *`,
        [id, body.status ?? null, body.priority ?? null, Object.hasOwn(body, "assignedUserId"), body.assignedUserId ?? null, body.resolutionCode ?? null, body.resolutionSummary ?? null]
      );
      if (body.note) await client.query("INSERT INTO case_mgmt.notes(case_id,author_id,body) VALUES ($1,$2,$3)", [id, user.id, body.note]);
      await client.query("INSERT INTO case_mgmt.events(case_id,event_type,actor_id,payload) VALUES ($1,'updated',$2,$3)", [id, user.id, JSON.stringify(body)]);
      await writeAudit(client, user, "case.update", "case", id, current, updated.rows[0], request.correlationId, request.ip);
      await emitEvent(client, {
        eventType: "case.updated",
        organizationId: current.organization_id,
        correlationId: request.correlationId,
        aggregate: { type: "case", id },
        payload: { status: updated.rows[0].status, priority: updated.rows[0].priority, version: updated.rows[0].version }
      });
      return updated.rows[0];
    });
    return sendData(request, reply, result);
  });

  app.get("/api/v1/contacts", async (request, reply) => {
    const user = requirePermission(request, "conversation.read.team");
    const result = await query(
      `SELECT ct.*, count(DISTINCT c.id)::int AS conversation_count, count(DISTINCT ca.id)::int AS case_count,
              max(c.last_message_at) AS last_activity_at
       FROM conversation.contacts ct
       LEFT JOIN conversation.conversations c ON c.contact_id = ct.id
       LEFT JOIN case_mgmt.cases ca ON ca.conversation_id = c.id
       WHERE ct.organization_id = $1
       GROUP BY ct.id ORDER BY last_activity_at DESC NULLS LAST`,
      [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.get("/api/v1/contacts/:id", async (request, reply) => {
    const user = requirePermission(request, "conversation.read.team");
    const { id } = request.params as { id: string };
    const [contact, conversations, cases] = await Promise.all([
      query("SELECT * FROM conversation.contacts WHERE id=$1 AND organization_id=$2", [id, user.organizationId]),
      query("SELECT * FROM conversation.conversations WHERE contact_id=$1 ORDER BY last_message_at DESC", [id]),
      query("SELECT ca.* FROM case_mgmt.cases ca JOIN conversation.conversations c ON c.id=ca.conversation_id WHERE c.contact_id=$1 ORDER BY ca.created_at DESC", [id])
    ]);
    if (!contact.rowCount) throw createHttpError(404, "CONTACT_NOT_FOUND", "Contact not found.");
    return sendData(request, reply, { ...contact.rows[0], conversations: conversations.rows, cases: cases.rows });
  });

  app.get("/api/v1/courses", async (request, reply) => {
    const user = requirePermission(request);
    const includeArchived = (request.query as { includeArchived?: string }).includeArchived === "true";
    const result = await query(
      `SELECT c.*, COALESCE(jsonb_agg(DISTINCT a.alias) FILTER (WHERE a.alias IS NOT NULL),'[]') AS aliases,
              count(DISTINCT o.id)::int AS offering_count, count(DISTINCT p.id)::int AS pricing_rule_count,
              COALESCE(to_jsonb(f) - 'course_id' - 'organization_id','{}'::jsonb) AS facts
       FROM catalog.courses c
       LEFT JOIN catalog.course_aliases a ON a.course_id = c.id
       LEFT JOIN catalog.offerings o ON o.course_id = c.id AND o.status <> 'archived'
       LEFT JOIN pricing.rules p ON p.course_id = c.id AND p.status <> 'archived'
       LEFT JOIN catalog.course_facts f ON f.course_id = c.id
       WHERE c.organization_id = $1 AND ($2::boolean OR c.status <> 'archived')
       GROUP BY c.id,f.course_id ORDER BY c.name`,
      [user.organizationId, includeArchived]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/courses", async (request, reply) => {
    const user = requirePermission(request, "course.publish");
    const body = z.object({ code: z.string().min(2).max(40), name: z.string().min(2).max(200), category: z.string().max(100).optional(), description: z.string().max(5000).optional(), aliases: z.array(z.string().min(1).max(200)).default([]) }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const course = await client.query<any>(
        `INSERT INTO catalog.courses(organization_id,code,name,category,description,status)
         VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
        [user.organizationId, body.code, body.name, body.category ?? null, body.description ?? null]
      );
      for (const alias of [body.name, ...body.aliases]) await client.query("INSERT INTO catalog.course_aliases(course_id,alias) VALUES ($1,$2) ON CONFLICT DO NOTHING", [course.rows[0].id, alias]);
      await writeAudit(client, user, "course.create", "course", course.rows[0].id, null, course.rows[0], request.correlationId, request.ip);
      return course.rows[0];
    });
    return sendData(request, reply, result, 201);
  });

  app.get("/api/v1/course-offerings", async (request, reply) => {
    const user = requirePermission(request);
    const result = await query(
      `SELECT o.*, c.name AS course_name FROM catalog.offerings o
       JOIN catalog.courses c ON c.id=o.course_id WHERE o.organization_id=$1 ORDER BY o.start_at ASC NULLS LAST`,
      [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.get("/api/v1/pricing-rules", async (request, reply) => {
    const user = requirePermission(request);
    const includeArchived = (request.query as { includeArchived?: string }).includeArchived === "true";
    const result = await query(
      `SELECT p.*, c.name AS course_name, o.cohort_name FROM pricing.rules p
       JOIN catalog.courses c ON c.id=p.course_id LEFT JOIN catalog.offerings o ON o.id=p.offering_id
       WHERE p.organization_id=$1 AND ($2::boolean OR p.status <> 'archived') ORDER BY c.name,p.priority,p.effective_from DESC`,
      [user.organizationId, includeArchived]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/pricing-rules", async (request, reply) => {
    const user = requirePermission(request, "pricing.publish");
    const body = z.object({
      courseId: z.uuid(), offeringId: z.uuid().nullable().optional(), audienceSegment: z.string().min(2), deliveryMode: z.enum(["online","offline","hybrid"]).optional(),
      standardPrice: z.number().nonnegative(), earlyBirdPrice: z.number().nonnegative().nullable().optional(), promotionName: z.string().max(200).nullable().optional(),
      groupPrice: z.number().nonnegative().nullable().optional(), alumniPrice: z.number().nonnegative().nullable().optional(),
      installmentInfo: z.string().max(30_000).nullable().optional(), note: z.string().max(30_000).nullable().optional(),
      offlineRegions: z.array(z.string().max(200)).default([]), courseType: z.string().max(200).nullable().optional(), comboName: z.string().max(300).nullable().optional(),
      effectiveFrom: z.iso.datetime(), effectiveTo: z.iso.datetime().nullable().optional(), priority: z.number().int().min(0).max(1000).default(100),
      status: z.enum(["draft","review","approved","published"]).default("published")
    }).parse(request.body);
    const conflict = await query(
      `SELECT id FROM pricing.rules WHERE course_id=$1 AND audience_segment=$2
       AND COALESCE(delivery_mode,'')=COALESCE($3,'') AND status='published'
       AND tstzrange(effective_from,COALESCE(effective_to,'infinity')) && tstzrange($4::timestamptz,COALESCE($5::timestamptz,'infinity'))
       AND priority=$6 LIMIT 1`,
      [body.courseId, body.audienceSegment, body.deliveryMode ?? null, body.effectiveFrom, body.effectiveTo ?? null, body.priority]
    );
    if (conflict.rowCount) throw createHttpError(409, "PRICING_CONFLICT", "A pricing rule already has the same scope, effective period, and priority.", { conflictId: conflict.rows[0]?.id });
    const result = await query(
      `INSERT INTO pricing.rules(
         organization_id,course_id,offering_id,audience_segment,delivery_mode,standard_price,early_bird_price,
         group_price,alumni_price,installment_info,note,offline_regions,course_type,combo_name,
         promotion_name,effective_from,effective_to,priority,status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [user.organizationId, body.courseId, body.offeringId ?? null, body.audienceSegment, body.deliveryMode ?? null,
        body.standardPrice, body.earlyBirdPrice ?? null, body.groupPrice ?? null, body.alumniPrice ?? null,
        body.installmentInfo ?? null, body.note ?? null, body.offlineRegions, body.courseType ?? null, body.comboName ?? null,
        body.promotionName ?? null, body.effectiveFrom, body.effectiveTo ?? null, body.priority, body.status]
    );
    await writeAudit(pool, user, "pricing_rule.create", "pricing_rule", result.rows[0]!.id, null, result.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, result.rows[0], 201);
  });

  app.post("/api/v1/pricing/preview", async (request, reply) => {
    requirePermission(request);
    const body = z.object({ courseId: z.uuid(), audience: z.string().default("Working professionals"), deliveryMode: z.string().default("online"), asOf: z.iso.datetime().optional() }).parse(request.body);
    const quote = await getPricingQuote(body.courseId, body.audience, body.deliveryMode, body.asOf ? new Date(body.asOf) : new Date());
    return sendData(request, reply, { quote, grounded: Boolean(quote) });
  });

  app.post("/api/v1/dev/simulate-message", async (request, reply) => {
    const user = requirePermission(request, "conversation.takeover");
    if (!config.DEMO_MODE && config.APP_ENV === "production") throw createHttpError(404, "NOT_FOUND", "Not found");
    const body = z.object({
      externalUserId: z.string().min(2).default(`demo-${Date.now()}`),
      displayName: z.string().min(1).max(200).default("Demo Customer"),
      text: z.string().min(1).max(10_000),
      messageId: z.string().optional()
    }).parse(request.body);
    const result = await ingestInboundMessage({
      organizationId: user.organizationId,
      channelAccountId: DEMO_CHANNEL_ID,
      externalUserId: body.externalUserId,
      externalMessageId: body.messageId ?? `demo-${Date.now()}-${randomUUID().slice(0, 8)}`,
      text: body.text,
      displayName: body.displayName,
      environment: "test",
      correlationId: request.correlationId
    });
    return sendData(request, reply, result, result.status === "accepted" ? 202 : 200);
  });

  app.get("/api/v1/notifications", async (request, reply) => {
    const user = requirePermission(request);
    const result = await query(
      `SELECT * FROM platform.notifications WHERE organization_id=$1 AND (user_id=$2 OR user_id IS NULL)
       ORDER BY created_at DESC LIMIT 100`,
      [user.organizationId, user.id]
    );
    return sendData(request, reply, result.rows);
  });

  app.get("/api/v1/jobs", async (request, reply) => {
    const user = requirePermission(request);
    const result = await query("SELECT * FROM platform.jobs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100", [user.organizationId]);
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/jobs/:id/retry", async (request, reply) => {
    const user = requirePermission(request, "channel.manage");
    const { id } = request.params as { id: string };
    const result = await query(
      `UPDATE platform.jobs SET status='queued', attempts=0, available_at=now(), last_error=NULL, current_step='retry_requested'
       WHERE id=$1 AND organization_id=$2 AND status='failed' RETURNING *`,
      [id, user.organizationId]
    );
    if (!result.rowCount) throw createHttpError(409, "JOB_NOT_RETRYABLE", "The job is not in a retryable state.");
    return sendData(request, reply, result.rows[0]);
  });
}
