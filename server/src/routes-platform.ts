/**
 * API cho những thứ đã có schema nhưng chưa có đường gọi:
 * feedback, retrieval test, re-embed, agent registry, tool registry,
 * đề xuất cải tiến prompt, và lịch định kỳ.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "./auth.js";
import { pool, query, withTransaction } from "./db.js";
import { activeProfile } from "./embedding.js";
import { agentGraphSchema } from "./graph.js";
import { createHttpError, sendData } from "./http.js";
import { searchKnowledge } from "./knowledge.js";
import { enqueueJob, writeAudit } from "./platform.js";
import { listSchedules, nextRunAt } from "./scheduler.js";
import { loadTools, runTool } from "./tools.js";

export async function registerPlatformRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Phản hồi "AI trả lời sai" — nhiên liệu cho vòng tự cải tiến
  // -------------------------------------------------------------------------
  app.post("/api/v1/feedback", async (request, reply) => {
    const user = requirePermission(request, "feedback.write");
    const body = z.object({
      aiRunId: z.uuid().optional(),
      conversationId: z.uuid().optional(),
      messageId: z.uuid().optional(),
      rating: z.enum(["good", "wrong", "incomplete", "wrong_tone", "unsafe"]),
      reasonCode: z.string().max(100).optional(),
      comment: z.string().max(2000).optional(),
      correctedText: z.string().max(6000).optional()
    }).parse(request.body);

    const result = await query(
      `INSERT INTO platform.response_feedback(
         organization_id, ai_run_id, conversation_id, message_id, source,
         rating, reason_code, comment, corrected_text, reported_by
       ) VALUES ($1,$2,$3,$4,'human',$5,$6,$7,$8,$9) RETURNING *`,
      [user.organizationId, body.aiRunId ?? null, body.conversationId ?? null, body.messageId ?? null,
       body.rating, body.reasonCode ?? null, body.comment ?? null, body.correctedText ?? null, user.id]
    );
    return sendData(request, reply, result.rows[0], 201);
  });

  app.get("/api/v1/feedback", async (request, reply) => {
    const user = requirePermission(request, "ai_trace.read");
    const filters = request.query as { rating?: string; days?: string };
    const result = await query(
      `SELECT f.*, u.display_name AS reporter_name
       FROM platform.response_feedback f
       LEFT JOIN iam.users u ON u.id = f.reported_by
       WHERE f.organization_id = $1
         AND ($2::text IS NULL OR f.rating = $2)
         AND f.created_at > now() - make_interval(days => $3)
       ORDER BY f.created_at DESC LIMIT 200`,
      [user.organizationId, filters.rating ?? null, Number(filters.days ?? 30)]
    );
    return sendData(request, reply, result.rows);
  });


  // -------------------------------------------------------------------------
  // Trace — danh sách lượt AI và chi tiết từng bước
  // -------------------------------------------------------------------------
  app.get("/api/v1/traces", async (request, reply) => {
    const user = requirePermission(request, "ai_trace.read");
    const q = request.query as { limit?: string; mode?: string };
    const result = await query(
      `SELECT id, conversation_id, purpose, provider, model, status, run_mode, environment,
              language, decision, validation, latency_ms, token_usage, runtime_config,
              input, created_at
       FROM platform.ai_runs
       WHERE organization_id = $1 AND ($2::text IS NULL OR run_mode = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [user.organizationId, q.mode ?? null, Math.min(Number(q.limit ?? 50), 200)]
    );
    return sendData(request, reply, result.rows);
  });

  app.get("/api/v1/traces/:id", async (request, reply) => {
    const user = requirePermission(request, "ai_trace.read");
    const { id } = request.params as { id: string };
    const [run, steps, toolCalls, retrieval] = await Promise.all([
      query("SELECT * FROM platform.ai_runs WHERE id=$1 AND organization_id=$2", [id, user.organizationId]),
      query("SELECT * FROM platform.ai_run_steps WHERE ai_run_id=$1 ORDER BY step_index", [id]),
      query("SELECT * FROM platform.ai_tool_calls WHERE ai_run_id=$1 ORDER BY created_at", [id]),
      query("SELECT * FROM platform.retrieval_snapshots WHERE ai_run_id=$1", [id])
    ]);
    if (!run.rowCount) throw createHttpError(404, "TRACE_NOT_FOUND", "Không tìm thấy lượt AI.");
    return sendData(request, reply, {
      ...run.rows[0], steps: steps.rows, toolCalls: toolCalls.rows, retrieval: retrieval.rows
    });
  });

  // -------------------------------------------------------------------------
  // Chunk preview + retrieval test
  // -------------------------------------------------------------------------
  app.get("/api/v1/knowledge/revisions/:id/chunks", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const { id } = request.params as { id: string };
    const result = await query(
      `SELECT c.id, c.chunk_index, c.heading_path, c.content, c.token_estimate,
              c.embedding_status, c.embedding_model, c.embedding_error, c.embedded_at,
              length(c.content) AS characters
       FROM knowledge.chunks c
       JOIN knowledge.document_revisions r ON r.id = c.document_revision_id
       JOIN knowledge.documents d ON d.id = r.document_id
       WHERE c.document_revision_id = $1 AND d.organization_id = $2
       ORDER BY c.chunk_index`,
      [id, user.organizationId]
    );

    // Cảnh báo chất lượng: đoạn quá dài khó truy hồi chính xác, đoạn quá ngắn
    // thường là rác cắt sót từ header/footer.
    const chunks = result.rows as Array<Record<string, any>>;
    const warnings = {
      tooLong: chunks.filter((c) => Number(c.token_estimate ?? 0) > 1200).map((c) => c.chunk_index),
      tooShort: chunks.filter((c) => Number(c.characters ?? 0) < 80).map((c) => c.chunk_index),
      notEmbedded: chunks.filter((c) => c.embedding_status !== "embedded").map((c) => c.chunk_index)
    };
    return sendData(request, reply, {
      chunks,
      total: chunks.length,
      embeddingProfile: activeProfile(),
      warnings
    });
  });

  app.post("/api/v1/knowledge/retrieval-test", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const body = z.object({
      question: z.string().min(3).max(500),
      topK: z.number().int().min(1).max(20).default(5),
      documentRevisionId: z.uuid().optional()
    }).parse(request.body);

    const started = Date.now();
    const results = await searchKnowledge(user.organizationId, body.question, body.topK);
    const scores = results.map((row) => Number(row.score ?? 0));
    const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    const saved = await query(
      `INSERT INTO knowledge.retrieval_tests(
         organization_id, document_revision_id, question, top_k, results,
         top_score, average_score, run_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [user.organizationId, body.documentRevisionId ?? null, body.question, body.topK,
       JSON.stringify(results), scores[0] ?? 0, average, user.id]
    );

    return sendData(request, reply, {
      id: saved.rows[0]?.id,
      question: body.question,
      results,
      metrics: {
        topScore: Number((scores[0] ?? 0).toFixed(4)),
        averageScore: Number(average.toFixed(4)),
        returned: results.length,
        latencyMs: Date.now() - started,
        embeddingProfile: activeProfile().code
      }
    });
  });

  app.get("/api/v1/knowledge/retrieval-tests", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const result = await query(
      `SELECT id, question, top_k, top_score, average_score, verdict, created_at
       FROM knowledge.retrieval_tests WHERE organization_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  // -------------------------------------------------------------------------
  // Nhúng lại
  // -------------------------------------------------------------------------
  app.post("/api/v1/knowledge/reembed", async (request, reply) => {
    const user = requirePermission(request, "knowledge.publish");
    const body = z.object({ collectionCode: z.string().max(80).optional(), reason: z.string().max(500).optional() })
      .parse(request.body ?? {});

    const revisions = await query<{ id: string }>(
      `SELECT DISTINCT r.id
       FROM knowledge.document_revisions r
       JOIN knowledge.documents d ON d.id = r.document_id
       LEFT JOIN knowledge.collection_members m ON m.document_revision_id = r.id
       LEFT JOIN knowledge.collections c ON c.id = m.collection_id
       WHERE d.organization_id = $1 AND r.status IN ('ready','published')
         AND ($2::text IS NULL OR c.code = $2)`,
      [user.organizationId, body.collectionCode ?? null]
    );
    if (!revisions.rowCount) throw createHttpError(404, "NOTHING_TO_REEMBED", "Không có revision nào cần nhúng lại.");

    const run = await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO knowledge.reembed_runs(
           organization_id, to_profile_code, status, total_chunks, reason, created_by
         ) VALUES ($1,$2,'running',
           (SELECT count(*)::int FROM knowledge.chunks WHERE organization_id = $1), $3, $4)
         RETURNING id`,
        [user.organizationId, activeProfile().code, body.reason ?? "Nhúng lại thủ công", user.id]
      );
      for (const revision of revisions.rows) {
        await enqueueJob(client, user.organizationId, "INDEX_DOCUMENT",
          { revisionId: revision.id }, `reembed:${revision.id}:${inserted.rows[0]!.id}`, new Date(), 80);
      }
      await writeAudit(client, user, "knowledge.reembed", "collection",
        body.collectionCode ?? "all", null, { revisions: revisions.rowCount }, request.correlationId, request.ip);
      return inserted.rows[0]!;
    });

    return sendData(request, reply, { runId: run.id, queuedRevisions: revisions.rowCount }, 202);
  });

  app.get("/api/v1/knowledge/reembed-runs", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const result = await query(
      `SELECT r.*,
              (SELECT count(*)::int FROM knowledge.chunks c
               WHERE c.organization_id = r.organization_id AND c.embedding_status = 'embedded') AS embedded_now
       FROM knowledge.reembed_runs r WHERE r.organization_id = $1
       ORDER BY r.created_at DESC LIMIT 20`,
      [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  // -------------------------------------------------------------------------
  // Agent registry
  // -------------------------------------------------------------------------
  app.get("/api/v1/agents", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const result = await query(
      `SELECT a.id, a.code, a.name, a.description, a.kind, a.status,
              v.id AS version_id, v.version_no, v.status AS version_status,
              v.system_prompt, v.user_template, v.model_profile_code,
              v.tool_codes, v.knowledge_codes, v.memory, v.output_schema,
              pub.version_no AS published_version_no,
              (SELECT count(*)::int FROM studio.agent_versions x WHERE x.agent_id = a.id) AS version_count
       FROM studio.agents a
       LEFT JOIN LATERAL (SELECT * FROM studio.agent_versions WHERE agent_id=a.id ORDER BY version_no DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT version_no FROM studio.agent_versions WHERE agent_id=a.id AND status='published' ORDER BY version_no DESC LIMIT 1) pub ON true
       WHERE a.organization_id = $1 AND a.status = 'active'
       ORDER BY a.name`,
      [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/agents", async (request, reply) => {
    const user = requirePermission(request, "studio.write");
    const body = z.object({
      code: z.string().regex(/^[a-z][a-z0-9-]*$/).max(80),
      name: z.string().min(2).max(120),
      description: z.string().max(500).optional(),
      kind: z.enum(["conversational", "classifier", "rewriter", "extractor", "analyst", "improver"]).default("conversational"),
      systemPrompt: z.string().min(20).max(20000),
      userTemplate: z.string().max(5000).optional(),
      modelProfileCode: z.string().max(80).optional(),
      toolCodes: z.array(z.string().max(80)).default([]),
      knowledgeCodes: z.array(z.string().max(80)).default([]),
      outputSchema: z.record(z.string(), z.any()).optional()
    }).parse(request.body);

    if (body.kind === "classifier" && !body.outputSchema) {
      throw createHttpError(400, "SCHEMA_REQUIRED", "Agent loại classifier bắt buộc phải có outputSchema.");
    }

    const result = await withTransaction(async (client) => {
      const agent = await client.query<{ id: string }>(
        `INSERT INTO studio.agents(organization_id, code, name, description, kind, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [user.organizationId, body.code, body.name, body.description ?? null, body.kind, user.id]
      );
      const agentId = agent.rows[0]!.id;
      await client.query(
        `INSERT INTO studio.agent_versions(
           agent_id, version_no, system_prompt, user_template, model_profile_code,
           tool_codes, knowledge_codes, memory, output_schema, status, created_by
         ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,'draft',$9)`,
        [agentId, body.systemPrompt, body.userTemplate ?? null, body.modelProfileCode ?? null,
         body.toolCodes, body.knowledgeCodes,
         JSON.stringify(body.kind === "conversational"
           ? { kind: "conversation_window", maxTurns: 12, scope: "conversation" }
           : { kind: "none" }),
         body.outputSchema ? JSON.stringify(body.outputSchema) : null, user.id]
      );
      await writeAudit(client, user, "agent.create", "agent", agentId, null, body, request.correlationId, request.ip);
      return { id: agentId, code: body.code };
    });
    return sendData(request, reply, result, 201);
  });

  app.post("/api/v1/agents/:id/versions", async (request, reply) => {
    const user = requirePermission(request, "studio.write");
    const { id } = request.params as { id: string };
    const body = z.object({
      systemPrompt: z.string().min(20).max(20000),
      userTemplate: z.string().max(5000).optional(),
      toolCodes: z.array(z.string().max(80)).optional(),
      knowledgeCodes: z.array(z.string().max(80)).optional(),
      changeSummary: z.string().max(500).optional()
    }).parse(request.body);

    const result = await query(
      `INSERT INTO studio.agent_versions(
         agent_id, version_no, system_prompt, user_template, model_profile_code,
         parameters, tool_codes, knowledge_codes, memory, output_schema, status, change_summary, created_by
       )
       SELECT a.id, COALESCE(max(v.version_no),0)+1, $2,
              COALESCE($3, max(v.user_template)), max(v.model_profile_code),
              '{}'::jsonb,
              COALESCE($4::text[], (array_agg(v.tool_codes ORDER BY v.version_no DESC))[1]),
              COALESCE($5::text[], (array_agg(v.knowledge_codes ORDER BY v.version_no DESC))[1]),
              (array_agg(v.memory ORDER BY v.version_no DESC))[1],
              (array_agg(v.output_schema ORDER BY v.version_no DESC))[1],
              'draft', $6, $7
       FROM studio.agents a LEFT JOIN studio.agent_versions v ON v.agent_id = a.id
       WHERE a.id = $1 AND a.organization_id = $8
       GROUP BY a.id RETURNING *`,
      [id, body.systemPrompt, body.userTemplate ?? null, body.toolCodes ?? null,
       body.knowledgeCodes ?? null, body.changeSummary ?? null, user.id, user.organizationId]
    );
    if (!result.rowCount) throw createHttpError(404, "AGENT_NOT_FOUND", "Không tìm thấy agent.");
    return sendData(request, reply, result.rows[0], 201);
  });

  app.post("/api/v1/agent-versions/:id/publish", async (request, reply) => {
    const user = requirePermission(request, "studio.approve");
    const { id } = request.params as { id: string };
    const result = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE studio.agent_versions v SET status='published', published_by=$2
         FROM studio.agents a
         WHERE v.id=$1 AND a.id=v.agent_id AND a.organization_id=$3 RETURNING v.*`,
        [id, user.id, user.organizationId]
      );
      if (!updated.rowCount) throw createHttpError(404, "VERSION_NOT_FOUND", "Không tìm thấy phiên bản agent.");
      // Chỉ một bản published cho mỗi agent.
      await client.query(
        `UPDATE studio.agent_versions SET status='archived'
         WHERE agent_id=$1 AND id<>$2 AND status='published'`,
        [updated.rows[0]!.agent_id, id]
      );
      await writeAudit(client, user, "agent_version.publish", "agent_version", id, null, null, request.correlationId, request.ip);
      return updated.rows[0];
    });
    return sendData(request, reply, result);
  });

  // -------------------------------------------------------------------------
  // Tool registry
  // -------------------------------------------------------------------------
  app.get("/api/v1/tools", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const tools = await loadTools(pool, user.organizationId);
    return sendData(request, reply, [...tools.values()]);
  });

  app.post("/api/v1/tools/:code/test", async (request, reply) => {
    const user = requirePermission(request, "studio.write");
    const { code } = request.params as { code: string };
    const body = z.object({ args: z.record(z.string(), z.any()).default({}) }).parse(request.body ?? {});
    const result = await runTool(pool, {
      organizationId: user.organizationId,
      toolCode: code,
      args: body.args,
      allowedCodes: [code]
    });
    return sendData(request, reply, result);
  });

  /** Sinh tool từ một bảng Dữ liệu — tạo bảng xong là AI dùng được ngay. */
  app.post("/api/v1/tools/from-table", async (request, reply) => {
    const user = requirePermission(request, "studio.write");
    const body = z.object({
      tableCode: z.string().max(80),
      toolCode: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
      name: z.string().min(2).max(120),
      description: z.string().min(10).max(500),
      filterColumns: z.array(z.string().max(80)).min(1),
      outputColumns: z.array(z.string().max(80)).default([]),
      zeroResultBehaviour: z.enum(["ask_clarifying", "handover", "return_empty"]).default("return_empty"),
      limit: z.number().int().min(1).max(100).default(20)
    }).parse(request.body);

    const table = await query<{ id: string; schema_definition: any }>(
      "SELECT id, schema_definition FROM structured.tables WHERE organization_id=$1 AND code=$2 AND status<>'archived'",
      [user.organizationId, body.tableCode]
    );
    if (!table.rowCount) throw createHttpError(404, "TABLE_NOT_FOUND", "Không tìm thấy bảng dữ liệu.");

    const columns = (table.rows[0]!.schema_definition?.columns ?? []) as Array<{ key: string; label: string; type: string }>;
    const known = new Set(columns.map((c) => c.key));
    const unknown = [...body.filterColumns, ...body.outputColumns].filter((c) => !known.has(c));
    if (unknown.length) {
      throw createHttpError(400, "UNKNOWN_COLUMN", `Cột không tồn tại trong bảng: ${unknown.join(", ")}`);
    }

    const inputSchema = {
      type: "object",
      additionalProperties: false,
      required: [body.filterColumns[0]],
      properties: Object.fromEntries(body.filterColumns.map((key) => {
        const column = columns.find((c) => c.key === key)!;
        return [key, { type: column.type === "number" || column.type === "currency" ? "number" : "string", description: column.label }];
      }))
    };
    const outputColumns = body.outputColumns.length ? body.outputColumns : columns.map((c) => c.key);

    const result = await withTransaction(async (client) => {
      const tool = await client.query<{ id: string }>(
        `INSERT INTO studio.tools(organization_id, code, name, purpose, kind, source_table_code, status)
         VALUES ($1,$2,$3,$4,'structured_query',$5,'active')
         ON CONFLICT (organization_id, code) DO UPDATE SET name=EXCLUDED.name, purpose=EXCLUDED.purpose
         RETURNING id`,
        [user.organizationId, body.toolCode, body.name, body.description, body.tableCode]
      );
      const toolId = tool.rows[0]!.id;
      await client.query(
        `INSERT INTO studio.tool_versions(tool_id, version_no, input_schema, output_schema, binding, policy, status)
         SELECT $1, COALESCE(max(version_no),0)+1, $2, $3, $4, $5, 'published'
         FROM studio.tool_versions WHERE tool_id = $1`,
        [toolId, JSON.stringify(inputSchema),
         JSON.stringify({ type: "array", items: { type: "object" } }),
         JSON.stringify({ tableCode: body.tableCode, filters: body.filterColumns, columns: outputColumns, limit: body.limit }),
         JSON.stringify({ timeout_ms: 5000, zero_result_behaviour: body.zeroResultBehaviour })]
      );
      await writeAudit(client, user, "tool.create_from_table", "tool", toolId, null, body, request.correlationId, request.ip);
      return { id: toolId, code: body.toolCode };
    });
    return sendData(request, reply, result, 201);
  });

  // -------------------------------------------------------------------------
  // Đề xuất cải tiến prompt
  // -------------------------------------------------------------------------
  app.get("/api/v1/improvement-proposals", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const status = (request.query as { status?: string }).status;
    const result = await query(
      `SELECT p.*, a.code AS agent_code, a.name AS agent_name,
              base.version_no AS base_version_no, base.system_prompt AS base_prompt,
              prop.version_no AS proposed_version_no, prop.system_prompt AS proposed_prompt
       FROM studio.improvement_proposals p
       JOIN studio.agents a ON a.id = p.agent_id
       LEFT JOIN studio.agent_versions base ON base.id = p.base_version_id
       LEFT JOIN studio.agent_versions prop ON prop.id = p.proposed_version_id
       WHERE p.organization_id = $1 AND ($2::text IS NULL OR p.status = $2)
       ORDER BY p.signal_count DESC, p.created_at DESC LIMIT 100`,
      [user.organizationId, status ?? null]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/improvement-proposals/:id/review", async (request, reply) => {
    const user = requirePermission(request, "proposal.review");
    const { id } = request.params as { id: string };
    const body = z.object({
      decision: z.enum(["approved", "rejected"]),
      comment: z.string().max(2000).optional()
    }).parse(request.body);

    const result = await withTransaction(async (client) => {
      const proposal = await client.query<{ proposed_version_id: string | null; agent_id: string }>(
        `UPDATE studio.improvement_proposals
         SET status=$2, review_comment=$3, reviewed_by=$4, reviewed_at=now()
         WHERE id=$1 AND organization_id=$5 AND status='awaiting_review'
         RETURNING proposed_version_id, agent_id`,
        [id, body.decision, body.comment ?? null, user.id, user.organizationId]
      );
      if (!proposal.rowCount) throw createHttpError(409, "NOT_REVIEWABLE", "Đề xuất không ở trạng thái chờ duyệt.");
      const row = proposal.rows[0]!;

      // Duyệt là publish luôn bản nháp AI soạn — vẫn phải qua release mới tới
      // runtime, nên đây chưa phải thay đổi hành vi khách hàng thấy.
      if (body.decision === "approved" && row.proposed_version_id) {
        await client.query("UPDATE studio.agent_versions SET status='published', published_by=$2 WHERE id=$1",
          [row.proposed_version_id, user.id]);
        await client.query(
          "UPDATE studio.agent_versions SET status='archived' WHERE agent_id=$1 AND id<>$2 AND status='published'",
          [row.agent_id, row.proposed_version_id]);
      }
      await writeAudit(client, user, `proposal.${body.decision}`, "improvement_proposal", id, null, body, request.correlationId, request.ip);
      return { id, status: body.decision };
    });
    return sendData(request, reply, result);
  });

  // -------------------------------------------------------------------------
  // Lịch định kỳ
  // -------------------------------------------------------------------------
  app.get("/api/v1/schedules", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    return sendData(request, reply, await listSchedules(user.organizationId));
  });

  app.patch("/api/v1/schedules/:code", async (request, reply) => {
    const user = requirePermission(request, "schedule.manage");
    const { code } = request.params as { code: string };
    const body = z.object({
      enabled: z.boolean().optional(),
      cronExpression: z.string().max(100).optional(),
      payload: z.record(z.string(), z.any()).optional()
    }).parse(request.body);

    if (body.cronExpression) {
      try { nextRunAt(body.cronExpression, new Date()); }
      catch (error) { throw createHttpError(400, "INVALID_CRON", error instanceof Error ? error.message : "Cron không hợp lệ"); }
    }

    const result = await query(
      `UPDATE platform.schedules
       SET enabled = COALESCE($3, enabled),
           cron_expression = COALESCE($4, cron_expression),
           payload = COALESCE($5, payload),
           next_run_at = CASE WHEN $4 IS NOT NULL THEN NULL ELSE next_run_at END
       WHERE organization_id=$1 AND code=$2 RETURNING *`,
      [user.organizationId, code, body.enabled ?? null, body.cronExpression ?? null,
       body.payload ? JSON.stringify(body.payload) : null]
    );
    if (!result.rowCount) throw createHttpError(404, "SCHEDULE_NOT_FOUND", "Không tìm thấy lịch.");
    return sendData(request, reply, result.rows[0]);
  });

  /** Chạy lịch ngay, không đợi tới giờ. */
  app.post("/api/v1/schedules/:code/run-now", async (request, reply) => {
    const user = requirePermission(request, "schedule.manage");
    const { code } = request.params as { code: string };
    const schedule = await query<{ job_type: string; payload: Record<string, unknown> }>(
      "SELECT job_type, payload FROM platform.schedules WHERE organization_id=$1 AND code=$2",
      [user.organizationId, code]
    );
    if (!schedule.rowCount) throw createHttpError(404, "SCHEDULE_NOT_FOUND", "Không tìm thấy lịch.");
    const jobId = await withTransaction((client) =>
      enqueueJob(client, user.organizationId, schedule.rows[0]!.job_type,
        { ...schedule.rows[0]!.payload, scheduleCode: code, correlationId: request.correlationId },
        `manual:${code}:${Date.now()}`, new Date(), 60));
    return sendData(request, reply, { jobId }, 202);
  });

  // -------------------------------------------------------------------------
  // Kiểm tra đồ thị flow trước khi publish
  // -------------------------------------------------------------------------
  app.post("/api/v1/flows/validate", async (request, reply) => {
    requirePermission(request, "studio.write");
    const parsed = agentGraphSchema.safeParse((request.body as { graph?: unknown })?.graph ?? request.body);
    if (!parsed.success) {
      return sendData(request, reply, {
        valid: false,
        errors: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    return sendData(request, reply, {
      valid: true,
      nodeCount: parsed.data.nodes.length,
      edgeCount: parsed.data.edges.length,
      maxSteps: parsed.data.maxSteps
    });
  });
}
