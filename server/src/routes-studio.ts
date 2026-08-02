import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "./auth.js";
import { config } from "./config.js";
import { pool, query, withTransaction } from "./db.js";
import { flowGraphSchema } from "./flow.js";
import { createHttpError, sendData } from "./http.js";
import { minio, queueDocumentIndex, searchKnowledge, validatePublicUrl } from "./knowledge.js";
import { previewConversationResponse } from "./orchestrator.js";
import { emitEvent, enqueueJob, writeAudit } from "./platform.js";

const documentSchema = z.object({
  title: z.string().min(2).max(300),
  sourceType: z.enum(["text", "url", "pdf", "docx", "pptx", "image", "html", "markdown"]).default("text"),
  sourceUrl: z.string().url().optional(),
  content: z.string().max(2_000_000).default(""),
  tags: z.array(z.string().max(50)).max(30).default([])
});

const promptSchema = z.object({
  code: z.string().regex(/^[a-z0-9_\-]+$/i).max(80),
  name: z.string().min(2).max(200),
  purpose: z.string().min(2).max(1000),
  systemTemplate: z.string().min(5).max(100_000),
  userTemplate: z.string().max(100_000).optional(),
  allowedTools: z.array(z.string()).default([]),
  modelProfileCode: z.string().optional(),
  changeReason: z.string().max(1000).optional()
});

const flowSchema = z.object({
  code: z.string().regex(/^[a-z0-9_\-]+$/i).min(2).max(80),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  graph: flowGraphSchema,
  changeReason: z.string().max(1000).optional()
});

const releaseSchema = z.object({
  releaseCode: z.string().regex(/^[a-z0-9._\-]+$/i).max(80),
  environment: z.enum(["development", "staging", "production"]).default("development"),
  manifest: z.record(z.string(), z.unknown()),
  changeSummary: z.string().max(2000).optional()
});

const transitionSchema = z.object({
  status: z.enum(["draft", "in_review", "changes_requested", "approved", "published", "archived"]),
  comment: z.string().max(2000).optional()
});

function contentHash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function ruleConflicts(rules: Array<Record<string, unknown>>) {
  const seen = new Map<string, number>();
  const conflicts: Array<{ code: string; indexes: number[] }> = [];
  rules.forEach((rule, index) => {
    const key = JSON.stringify({ when: rule.when, priority: rule.priority ?? 0 });
    const prior = seen.get(key);
    if (prior !== undefined && JSON.stringify(rules[prior]?.then) !== JSON.stringify(rule.then)) {
      conflicts.push({ code: "SAME_CONDITION_DIFFERENT_ACTION", indexes: [prior, index] });
    }
    seen.set(key, index);
  });
  return conflicts;
}

export async function registerStudioRoutes(app: FastifyInstance) {
  app.get("/api/v1/knowledge/documents", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const values = z.object({
      q: z.string().max(200).default(""),
      status: z.string().max(40).default(""),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(30)
    }).parse(request.query);
    const offset = (values.page - 1) * values.pageSize;
    const [result, count] = await Promise.all([query(
      `SELECT d.*, r.id AS latest_revision_id, r.revision_no, r.status AS revision_status,
              r.updated_at AS revision_updated_at, count(c.id)::int AS chunk_count
       FROM knowledge.documents d
       LEFT JOIN LATERAL (
         SELECT * FROM knowledge.document_revisions WHERE document_id=d.id ORDER BY revision_no DESC LIMIT 1
       ) r ON true
       LEFT JOIN knowledge.chunks c ON c.document_revision_id=r.id
       WHERE d.organization_id=$1 AND d.status<>'archived'
         AND ($2='' OR d.title ILIKE '%'||$2||'%' OR array_to_string(d.tags,' ') ILIKE '%'||$2||'%')
         AND ($3='' OR d.status=$3 OR r.status=$3)
       GROUP BY d.id, r.id, r.revision_no, r.status, r.updated_at
       ORDER BY d.updated_at DESC LIMIT $4 OFFSET $5`,
      [user.organizationId, values.q, values.status, values.pageSize, offset]
    ), query<{ count: number }>(
      `SELECT count(*)::int AS count FROM knowledge.documents d
       LEFT JOIN LATERAL (SELECT status FROM knowledge.document_revisions WHERE document_id=d.id ORDER BY revision_no DESC LIMIT 1) r ON true
       WHERE d.organization_id=$1 AND d.status<>'archived'
         AND ($2='' OR d.title ILIKE '%'||$2||'%' OR array_to_string(d.tags,' ') ILIKE '%'||$2||'%')
         AND ($3='' OR d.status=$3 OR r.status=$3)`, [user.organizationId, values.q, values.status]
    )]);
    const total = count.rows[0]?.count ?? 0;
    return sendData(request, reply, { documents: result.rows, total, page: values.page, pageSize: values.pageSize, pages: Math.max(1, Math.ceil(total / values.pageSize)) });
  });

  app.post("/api/v1/knowledge/documents", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const body = documentSchema.parse(request.body);
    if (body.sourceType === "url" && !body.sourceUrl) throw createHttpError(400, "SOURCE_URL_REQUIRED", "A URL source requires sourceUrl.");
    if (body.sourceUrl) {
      try { await validatePublicUrl(body.sourceUrl); }
      catch (error) { throw createHttpError(400, "UNSAFE_SOURCE_URL", error instanceof Error ? error.message : "The URL is not safe."); }
    }
    const result = await withTransaction(async (client) => {
      const document = await client.query<{ id: string }>(
        `INSERT INTO knowledge.documents(organization_id,title,source_type,source_url,owner_id,tags,status)
         VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING id`,
        [user.organizationId, body.title, body.sourceType, body.sourceUrl ?? null, user.id, body.tags]
      );
      const documentId = document.rows[0]!.id;
      let revisionId: string | null = null;
      if (body.sourceType === "url") {
        await client.query("UPDATE knowledge.documents SET status='parsing' WHERE id=$1", [documentId]);
        await enqueueJob(client, user.organizationId, "PARSE_DOCUMENT", { documentId, correlationId: request.correlationId }, `parse-document:${documentId}`, new Date(), 20);
      } else {
        const revision = await client.query<{ id: string }>(
          `INSERT INTO knowledge.document_revisions(document_id,revision_no,original_content,clean_content,content_hash,status,created_by)
           VALUES ($1,1,$2,$2,$3,'draft',$4) RETURNING id`,
          [documentId, body.content, contentHash(body.content), user.id]
        );
        revisionId = revision.rows[0]!.id;
      }
      await writeAudit(client, user, "knowledge.document.created", "knowledge_document", documentId, null, body, request.correlationId, request.ip);
      return { documentId, revisionId, status: body.sourceType === "url" ? "parsing" : "draft" };
    });
    return sendData(request, reply, result, body.sourceType === "url" ? 202 : 201);
  });

  app.post("/api/v1/knowledge/documents/upload", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const file = await request.file();
    if (!file) throw createHttpError(400, "FILE_REQUIRED", "Select a file to upload.");
    const extension = extname(file.filename).toLowerCase();
    const sourceTypes: Record<string, string> = {
      ".pdf": "pdf", ".docx": "docx", ".pptx": "pptx", ".png": "image", ".jpg": "image", ".jpeg": "image",
      ".html": "html", ".htm": "html", ".md": "markdown", ".txt": "text"
    };
    const sourceType = sourceTypes[extension];
    if (!sourceType) throw createHttpError(415, "UNSUPPORTED_FILE", "Supported formats are PDF, DOCX, PPTX, images, HTML, Markdown, and TXT.");
    const buffer = await file.toBuffer();
    const fields = file.fields as Record<string, { value?: unknown }>;
    const title = String(fields.title?.value ?? file.filename).trim().slice(0, 300);
    const tags = String(fields.tags?.value ?? "upload").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 30);
    const documentId = randomUUID();
    const objectKey = `${user.organizationId}/${documentId}/${randomUUID()}${extension}`;
    await minio.putObject(config.MINIO_BUCKET, objectKey, buffer, buffer.length, { "Content-Type": file.mimetype, "X-Amz-Meta-Original-Name": encodeURIComponent(file.filename) });
    try {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO knowledge.documents(id,organization_id,title,source_type,object_key,owner_id,tags,status,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'parsing',$8)`,
          [documentId, user.organizationId, title, sourceType, objectKey, user.id, tags, JSON.stringify({ original_filename: file.filename, mime_type: file.mimetype, bytes: buffer.length })]
        );
        await enqueueJob(client, user.organizationId, "PARSE_DOCUMENT", { documentId, correlationId: request.correlationId }, `parse-document:${documentId}`, new Date(), 20);
        await writeAudit(client, user, "knowledge.document.uploaded", "knowledge_document", documentId, null, { title, sourceType, filename: file.filename, bytes: buffer.length }, request.correlationId, request.ip);
      });
    } catch (error) {
      await minio.removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined);
      throw error;
    }
    return sendData(request, reply, { documentId, status: "parsing", filename: file.filename, bytes: buffer.length }, 202);
  });

  app.get("/api/v1/knowledge/documents/:id", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const { id } = request.params as { id: string };
    const document = await query("SELECT * FROM knowledge.documents WHERE id=$1 AND organization_id=$2", [id, user.organizationId]);
    if (!document.rowCount) throw createHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found.");
    const revisions = await query("SELECT * FROM knowledge.document_revisions WHERE document_id=$1 ORDER BY revision_no DESC", [id]);
    return sendData(request, reply, { ...document.rows[0], revisions: revisions.rows });
  });

  app.patch("/api/v1/knowledge/documents/:id", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { id } = request.params as { id: string };
    const body = z.object({ title: z.string().min(2).max(300).optional(), tags: z.array(z.string().max(50)).max(30).optional() }).parse(request.body);
    const current = await query<any>("SELECT * FROM knowledge.documents WHERE id=$1 AND organization_id=$2", [id, user.organizationId]);
    if (!current.rows[0]) throw createHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found.");
    const updated = await query<any>(
      "UPDATE knowledge.documents SET title=$2,tags=$3,updated_at=now() WHERE id=$1 RETURNING *",
      [id, body.title ?? current.rows[0].title, body.tags ?? current.rows[0].tags]
    );
    await writeAudit(pool, user, "knowledge.document.updated", "knowledge_document", id, current.rows[0], updated.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, updated.rows[0]);
  });

  app.delete("/api/v1/knowledge/documents/:id", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { id } = request.params as { id: string };
    const current = await query<any>("SELECT * FROM knowledge.documents WHERE id=$1 AND organization_id=$2", [id, user.organizationId]);
    if (!current.rows[0]) throw createHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found.");
    const updated = await withTransaction(async (client) => {
      await client.query("UPDATE knowledge.document_revisions SET status='archived',updated_at=now() WHERE document_id=$1", [id]);
      return (await client.query<any>("UPDATE knowledge.documents SET status='archived',updated_at=now() WHERE id=$1 RETURNING id,status", [id])).rows[0];
    });
    await writeAudit(pool, user, "knowledge.document.archive", "knowledge_document", id, current.rows[0], updated, request.correlationId, request.ip);
    return sendData(request, reply, updated);
  });

  app.post("/api/v1/knowledge/documents/:id/revisions", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { id } = request.params as { id: string };
    const body = z.object({ content: z.string().max(2_000_000), changeReason: z.string().max(1000).optional() }).parse(request.body);
    const result = await query(
      `INSERT INTO knowledge.document_revisions(document_id,revision_no,parent_revision_id,original_content,clean_content,content_hash,status,metadata,created_by)
       SELECT d.id, COALESCE(max(r.revision_no),0)+1,
              (SELECT id FROM knowledge.document_revisions WHERE document_id=d.id ORDER BY revision_no DESC LIMIT 1),
              $3,$3,$4,'draft',$5,$6
       FROM knowledge.documents d LEFT JOIN knowledge.document_revisions r ON r.document_id=d.id
       WHERE d.id=$1 AND d.organization_id=$2 GROUP BY d.id RETURNING *`,
      [id, user.organizationId, body.content, contentHash(body.content), JSON.stringify({ changeReason: body.changeReason }), user.id]
    );
    if (!result.rowCount) throw createHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found.");
    const revision = result.rows[0] as { id: string };

    /**
     * Tự động nhúng ngay khi lưu, không đợi publish.
     *
     * Kỳ vọng nghiệp vụ: "sửa tài liệu trong này thì tự động embedding cho AI
     * đọc". Bản trước chỉ nhúng khi chuyển sang approved/published, nên người
     * viết không thấy được tài liệu của mình truy hồi ra sao trước khi duyệt.
     *
     * Runtime vẫn chỉ đọc revision đã publish — nhúng sớm là để xem thử và
     * chạy retrieval test, không phải để phát hành.
     */
    await withTransaction((client) => queueDocumentIndex(client, user.organizationId, revision.id));
    return sendData(request, reply, revision, 201);
  });

  app.post("/api/v1/knowledge/revisions/:id/transition", async (request, reply) => {
    const user = requirePermission(request, "knowledge.approve");
    const { id } = request.params as { id: string };
    const body = transitionSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const updated = await client.query<{ id: string; document_id: string; status: string }>(
        `UPDATE knowledge.document_revisions r SET status=$3, approved_by=CASE WHEN $3 IN ('approved','published') THEN $4 ELSE approved_by END, updated_at=now()
         FROM knowledge.documents d WHERE r.id=$1 AND d.id=r.document_id AND d.organization_id=$2 RETURNING r.id,r.document_id,r.status`,
        [id, user.organizationId, body.status, user.id]
      );
      const revision = updated.rows[0];
      if (!revision) throw createHttpError(404, "REVISION_NOT_FOUND", "Document revision not found.");
      if (body.status === "approved" || body.status === "published") await queueDocumentIndex(client, user.organizationId, revision.id);
      if (body.status === "published") await client.query("UPDATE knowledge.documents SET status='published',updated_at=now() WHERE id=$1", [revision.document_id]);
      await writeAudit(client, user, `knowledge.revision.${body.status}`, "knowledge_revision", id, null, body, request.correlationId, request.ip);
      return revision;
    });
    return sendData(request, reply, result);
  });

  app.get("/api/v1/knowledge/search", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const values = z.object({ q: z.string().min(2), topK: z.coerce.number().int().min(1).max(20).default(5) }).parse(request.query);
    return sendData(request, reply, await searchKnowledge(user.organizationId, values.q, values.topK));
  });

  app.get("/api/v1/knowledge/collections", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const result = await query(
      `SELECT c.*, count(cm.document_revision_id)::int AS member_count FROM knowledge.collections c
       LEFT JOIN knowledge.collection_members cm ON cm.collection_id=c.id WHERE c.organization_id=$1
       GROUP BY c.id ORDER BY c.updated_at DESC`, [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/knowledge/collections", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const body = z.object({ code: z.string().min(2), name: z.string().min(2), description: z.string().optional(), revisionIds: z.array(z.uuid()).default([]) }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const collection = await client.query<{ id: string }>(
        `INSERT INTO knowledge.collections(organization_id,code,name,description) VALUES ($1,$2,$3,$4) RETURNING *`,
        [user.organizationId, body.code, body.name, body.description ?? null]
      );
      for (const revisionId of body.revisionIds) await client.query("INSERT INTO knowledge.collection_members VALUES ($1,$2) ON CONFLICT DO NOTHING", [collection.rows[0]!.id, revisionId]);
      return collection.rows[0];
    });
    return sendData(request, reply, result, 201);
  });

  app.get("/api/v1/studio/overview", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const result = await query(
      `SELECT
        (SELECT count(*)::int FROM studio.prompts WHERE organization_id=$1) AS prompts,
        (SELECT count(*)::int FROM studio.rule_sets WHERE organization_id=$1) AS rule_sets,
        (SELECT count(*)::int FROM studio.model_profiles WHERE organization_id=$1) AS models,
        (SELECT count(*)::int FROM studio.evaluation_cases ec JOIN studio.evaluation_suites es ON es.id=ec.suite_id WHERE es.organization_id=$1) AS evaluation_cases,
        (SELECT count(*)::int FROM studio.releases WHERE organization_id=$1) AS releases`, [user.organizationId]
    );
    return sendData(request, reply, result.rows[0]);
  });

  app.get("/api/v1/studio/prompts", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const result = await query(
      `SELECT p.*, v.id AS version_id,v.version_no,v.status,v.system_template,v.user_template,v.output_schema,v.allowed_tools,v.model_profile_code,v.created_at AS version_created_at,
              pub.id AS published_version_id,pub.version_no AS published_version_no,
              COALESCE((SELECT count(*)::int FROM studio.prompt_versions pv WHERE pv.prompt_id=p.id),0) AS version_count
       FROM studio.prompts p LEFT JOIN LATERAL (SELECT * FROM studio.prompt_versions WHERE prompt_id=p.id ORDER BY version_no DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT id,version_no FROM studio.prompt_versions WHERE prompt_id=p.id AND status='published' ORDER BY version_no DESC LIMIT 1) pub ON true
       WHERE p.organization_id=$1 ORDER BY p.name`, [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.get("/api/v1/studio/prompts/:id/versions", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const { id } = request.params as { id: string };
    const result = await query(
      `SELECT pv.* FROM studio.prompt_versions pv JOIN studio.prompts p ON p.id=pv.prompt_id
       WHERE p.id=$1 AND p.organization_id=$2 ORDER BY pv.version_no DESC`, [id, user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.get("/api/v1/studio/flows", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const environment = config.APP_ENV === "production" ? "production" : "development";
    const result = await query(
      `SELECT f.*,v.id AS version_id,v.version_no,v.status,v.graph,v.change_reason,v.created_at AS version_created_at,
              pub.id AS published_version_id,pub.version_no AS published_version_no
       FROM studio.flows f
       LEFT JOIN LATERAL (SELECT * FROM studio.flow_versions WHERE flow_id=f.id ORDER BY version_no DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT id,version_no FROM studio.flow_versions WHERE flow_id=f.id AND status='published' ORDER BY version_no DESC LIMIT 1) pub ON true
       WHERE f.organization_id=$1 ORDER BY f.name`, [user.organizationId]
    );
    const activeRelease = await query<any>(
      `SELECT manifest FROM studio.releases WHERE organization_id=$1 AND environment=$2 AND status='active' ORDER BY activated_at DESC LIMIT 1`,
      [user.organizationId, environment]
    );
    const activeFlowVersionId = activeRelease.rows[0]?.manifest?.flowVersionId ?? null;
    return sendData(request, reply, result.rows.map((row: any) => ({ ...row, runtime_active: row.version_id === activeFlowVersionId, runtime_version_id: activeFlowVersionId })));
  });

  app.get("/api/v1/studio/flows/:id/versions", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const { id } = request.params as { id: string };
    const result = await query(
      `SELECT fv.* FROM studio.flow_versions fv JOIN studio.flows f ON f.id=fv.flow_id
       WHERE f.id=$1 AND f.organization_id=$2 ORDER BY fv.version_no DESC`, [id, user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/studio/flows", async (request, reply) => {
    const user = requirePermission(request, "studio.write");
    const body = flowSchema.parse(request.body);
    const promptCodes = [...new Set(body.graph.nodes.map((node) => node.promptCode))];
    const verified = await query<{ code: string }>(
      "SELECT code FROM studio.prompts WHERE organization_id=$1 AND code=ANY($2::text[])", [user.organizationId, promptCodes]
    );
    const found = new Set(verified.rows.map((row) => row.code));
    const missing = promptCodes.filter((code) => !found.has(code));
    if (missing.length) throw createHttpError(400, "FLOW_PROMPTS_NOT_FOUND", "Every flow node must reference an existing prompt.", { missing });
    const result = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO studio.flows(organization_id,code,name,description) VALUES ($1,$2,$3,$4)
         ON CONFLICT(organization_id,code) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,updated_at=now()`,
        [user.organizationId, body.code, body.name, body.description ?? null]
      );
      const flow = await client.query<{ id: string }>("SELECT id FROM studio.flows WHERE organization_id=$1 AND code=$2 FOR UPDATE", [user.organizationId, body.code]);
      const version = await client.query(
        `INSERT INTO studio.flow_versions(flow_id,version_no,graph,change_reason,created_by)
         SELECT $1,COALESCE(max(version_no),0)+1,$2,$3,$4 FROM studio.flow_versions WHERE flow_id=$1 RETURNING *`,
        [flow.rows[0]!.id, JSON.stringify(body.graph), body.changeReason ?? null, user.id]
      );
      await writeAudit(client, user, "studio.flow.version.create", "flow", flow.rows[0]!.id, null, version.rows[0], request.correlationId, request.ip);
      return version.rows[0];
    });
    return sendData(request, reply, result, 201);
  });

  app.post("/api/v1/studio/flow-versions/:id/transition", async (request, reply) => {
    const user = requirePermission(request, "studio.approve");
    const { id } = request.params as { id: string };
    const body = z.object({ status: z.enum(["draft", "in_review", "approved", "published", "retired"]) }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const current = await client.query<any>(
        `SELECT fv.* FROM studio.flow_versions fv JOIN studio.flows f ON f.id=fv.flow_id
         WHERE fv.id=$1 AND f.organization_id=$2 FOR UPDATE`, [id, user.organizationId]
      );
      if (!current.rows[0]) throw createHttpError(404, "FLOW_VERSION_NOT_FOUND", "Flow version not found.");
      if (body.status === "published") {
        const graph = flowGraphSchema.parse(current.rows[0].graph);
        const codes = [...new Set(graph.nodes.map((node) => node.promptCode))];
        const published = await client.query<{ code: string }>(
          `SELECT DISTINCT p.code FROM studio.prompts p JOIN studio.prompt_versions pv ON pv.prompt_id=p.id
           WHERE p.organization_id=$1 AND p.code=ANY($2::text[]) AND pv.status='published'`, [user.organizationId, codes]
        );
        const found = new Set(published.rows.map((row) => row.code));
        const missing = codes.filter((code) => !found.has(code));
        if (missing.length) throw createHttpError(409, "FLOW_PROMPTS_NOT_PUBLISHED", "Publish every prompt referenced by this flow before publishing the flow.", { missing });
      }
      const updated = await client.query(
        "UPDATE studio.flow_versions SET status=$2,approved_by=CASE WHEN $2 IN ('approved','published') THEN $3 ELSE approved_by END WHERE id=$1 RETURNING *",
        [id, body.status, user.id]
      );
      return updated.rows[0];
    });
    return sendData(request, reply, result);
  });

  app.get("/api/v1/studio/runtime", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const environment = config.APP_ENV === "production" ? "production" : "development";
    const release = await query<any>(
      `SELECT id,release_code,environment,status,manifest,checksum,activated_at FROM studio.releases
       WHERE organization_id=$1 AND environment=$2 AND status IN ('active','canary')
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,activated_at DESC NULLS LAST LIMIT 1`,
      [user.organizationId, environment]
    );
    const active = release.rows[0] ?? null;
    const prompts = await query<any>(
      `SELECT p.code,p.name,pv.id AS version_id,pv.version_no,pv.status,pv.model_profile_code,mp.model,
              (($2::jsonb->'promptVersionIds'->>p.code)=pv.id::text) AS pinned
       FROM studio.prompts p
       JOIN studio.prompt_versions pv ON pv.prompt_id=p.id
       LEFT JOIN studio.model_profiles mp ON mp.organization_id=p.organization_id AND mp.code=pv.model_profile_code
       WHERE p.organization_id=$1 AND (
         (($2::jsonb->'promptVersionIds'->>p.code) IS NOT NULL AND pv.id::text=($2::jsonb->'promptVersionIds'->>p.code))
         OR (($2::jsonb->'promptVersionIds'->>p.code) IS NULL AND pv.status='published' AND pv.version_no=(SELECT max(x.version_no) FROM studio.prompt_versions x WHERE x.prompt_id=p.id AND x.status='published'))
       ) ORDER BY p.code`, [user.organizationId, JSON.stringify(active?.manifest ?? {})]
    );
    const flow = await query<any>(
      `SELECT f.id,f.code,f.name,fv.id AS version_id,fv.version_no,fv.status,fv.graph
       FROM studio.flow_versions fv JOIN studio.flows f ON f.id=fv.flow_id
       WHERE f.organization_id=$1 AND (
         (($2::jsonb->>'flowVersionId') IS NOT NULL AND fv.id::text=($2::jsonb->>'flowVersionId'))
         OR (($2::jsonb->>'flowVersionId') IS NULL AND fv.status='published')
       ) ORDER BY CASE WHEN fv.id::text=($2::jsonb->>'flowVersionId') THEN 0 ELSE 1 END,fv.version_no DESC LIMIT 1`,
      [user.organizationId, JSON.stringify(active?.manifest ?? {})]
    );
    return sendData(request, reply, { environment, release: active, prompts: prompts.rows, flow: flow.rows[0] ?? null, registryConnected: active?.manifest?.promptRuntime === "registry-connected-v2" });
  });

  app.post("/api/v1/studio/prompt-preview", async (request, reply) => {
    const user = requirePermission(request, "studio.evaluate");
    const body = z.object({ message: z.string().min(1).max(10_000), state: z.string().max(80).default("NEW"), releaseId: z.uuid().nullable().optional() }).parse(request.body);
    return sendData(request, reply, await previewConversationResponse({ organizationId: user.organizationId, message: body.message, state: body.state, releaseId: body.releaseId }));
  });

  app.post("/api/v1/studio/prompts", async (request, reply) => {
    const user = requirePermission(request, "studio.write");
    const body = promptSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const prompt = await client.query<{ id: string }>(
        `INSERT INTO studio.prompts(organization_id,code,name,purpose) VALUES ($1,$2,$3,$4)
         ON CONFLICT (organization_id,code) DO UPDATE SET name=EXCLUDED.name,purpose=EXCLUDED.purpose RETURNING id`,
        [user.organizationId, body.code, body.name, body.purpose]
      );
      const version = await client.query(
        `INSERT INTO studio.prompt_versions(prompt_id,version_no,system_template,user_template,allowed_tools,model_profile_code,change_reason,created_by)
         SELECT $1,COALESCE(max(version_no),0)+1,$2,$3,$4,$5,$6,$7 FROM studio.prompt_versions WHERE prompt_id=$1 RETURNING *`,
        [prompt.rows[0]!.id, body.systemTemplate, body.userTemplate ?? null, body.allowedTools, body.modelProfileCode ?? null, body.changeReason ?? null, user.id]
      );
      return version.rows[0];
    });
    return sendData(request, reply, result, 201);
  });

  app.post("/api/v1/studio/prompt-versions/:id/transition", async (request, reply) => {
    const user = requirePermission(request, "studio.approve");
    const { id } = request.params as { id: string };
    const body = z.object({ status: z.enum(["draft", "in_review", "approved", "published", "retired"]) }).parse(request.body);
    const result = await query(
      `UPDATE studio.prompt_versions v SET status=$3,approved_by=CASE WHEN $3 IN ('approved','published') THEN $4 ELSE approved_by END
       FROM studio.prompts p WHERE v.id=$1 AND p.id=v.prompt_id AND p.organization_id=$2 RETURNING v.*`,
      [id, user.organizationId, body.status, user.id]
    );
    if (!result.rowCount) throw createHttpError(404, "PROMPT_VERSION_NOT_FOUND", "Prompt version not found.");
    return sendData(request, reply, result.rows[0]);
  });

  app.get("/api/v1/studio/rules", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const result = await query(
      `SELECT rs.*,rv.id AS version_id,rv.version_no,rv.status,rv.rules,rv.conflicts FROM studio.rule_sets rs
       LEFT JOIN LATERAL (SELECT * FROM studio.rule_versions WHERE rule_set_id=rs.id ORDER BY version_no DESC LIMIT 1) rv ON true
       WHERE rs.organization_id=$1 ORDER BY rs.name`, [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/studio/rules", async (request, reply) => {
    const user = requirePermission(request, "studio.write");
    const body = z.object({ code: z.string().min(2), name: z.string().min(2), rules: z.array(z.record(z.string(), z.unknown())) }).parse(request.body);
    const conflicts = ruleConflicts(body.rules);
    const result = await withTransaction(async (client) => {
      const set = await client.query<{ id: string }>(
        `INSERT INTO studio.rule_sets(organization_id,code,name) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [user.organizationId, body.code, body.name]
      );
      const version = await client.query(
        `INSERT INTO studio.rule_versions(rule_set_id,version_no,rules,conflicts,created_by)
         SELECT $1,COALESCE(max(version_no),0)+1,$2,$3,$4 FROM studio.rule_versions WHERE rule_set_id=$1 RETURNING *`,
        [set.rows[0]!.id, JSON.stringify(body.rules), JSON.stringify(conflicts), user.id]
      );
      return version.rows[0];
    });
    return sendData(request, reply, result, 201, conflicts.length ? [{ code: "RULE_CONFLICTS", count: conflicts.length }] : []);
  });

  app.get("/api/v1/studio/models", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const result = await query("SELECT * FROM studio.model_profiles WHERE organization_id=$1 ORDER BY name", [user.organizationId]);
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/studio/models", async (request, reply) => {
    const user = requirePermission(request, "studio.write");
    const body = z.object({ code: z.string().min(2), name: z.string().min(2), provider: z.string().min(2), model: z.string().min(1), parameters: z.record(z.string(), z.unknown()).default({}), fallbackChain: z.array(z.unknown()).default([]) }).parse(request.body);
    const result = await query(
      `INSERT INTO studio.model_profiles(organization_id,code,name,provider,model,parameters,fallback_chain)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id,code) DO UPDATE
       SET name=EXCLUDED.name,provider=EXCLUDED.provider,model=EXCLUDED.model,parameters=EXCLUDED.parameters,fallback_chain=EXCLUDED.fallback_chain RETURNING *`,
      [user.organizationId, body.code, body.name, body.provider, body.model, JSON.stringify(body.parameters), JSON.stringify(body.fallbackChain)]
    );
    return sendData(request, reply, result.rows[0], 201);
  });

  app.get("/api/v1/studio/evaluation-suites", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const result = await query(
      `SELECT s.*,count(c.id)::int AS case_count FROM studio.evaluation_suites s LEFT JOIN studio.evaluation_cases c ON c.suite_id=s.id
       WHERE s.organization_id=$1 GROUP BY s.id ORDER BY s.name`, [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.get("/api/v1/studio/evaluation-runs", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const result = await query(
      `SELECT r.*,s.name AS suite_name,cr.release_code AS candidate_release_code FROM studio.evaluation_runs r JOIN studio.evaluation_suites s ON s.id=r.suite_id
       LEFT JOIN studio.releases cr ON cr.id=r.candidate_release_id
       WHERE r.organization_id=$1 ORDER BY r.created_at DESC LIMIT 100`, [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/studio/evaluation-runs", async (request, reply) => {
    const user = requirePermission(request, "studio.evaluate");
    const body = z.object({ suiteId: z.uuid(), candidateReleaseId: z.uuid().optional(), baselineReleaseId: z.uuid().optional() }).parse(request.body);
    const run = await withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO studio.evaluation_runs(organization_id,suite_id,candidate_release_id,baseline_release_id,created_by)
         SELECT $1,id,$3,$4,$5 FROM studio.evaluation_suites WHERE id=$2 AND organization_id=$1 RETURNING *`,
        [user.organizationId, body.suiteId, body.candidateReleaseId ?? null, body.baselineReleaseId ?? null, user.id]
      );
      if (!result.rowCount) throw createHttpError(404, "SUITE_NOT_FOUND", "Evaluation suite not found.");
      const row = result.rows[0]!;
      await enqueueJob(client, user.organizationId, "RUN_EVALUATION", { runId: row.id, correlationId: request.correlationId }, `evaluation:${row.id}`, new Date(), 3);
      return row;
    });
    return sendData(request, reply, run, 202);
  });

  app.get("/api/v1/studio/evaluation-runs/:id", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const { id } = request.params as { id: string };
    const run = await query("SELECT * FROM studio.evaluation_runs WHERE id=$1 AND organization_id=$2", [id, user.organizationId]);
    if (!run.rowCount) throw createHttpError(404, "RUN_NOT_FOUND", "Evaluation run not found.");
    const results = await query(
      `SELECT er.*,ec.code,ec.input,ec.expected,ec.severity FROM studio.evaluation_results er JOIN studio.evaluation_cases ec ON ec.id=er.case_id WHERE er.run_id=$1 ORDER BY ec.code`, [id]
    );
    return sendData(request, reply, { ...run.rows[0], results: results.rows });
  });

  app.get("/api/v1/studio/releases", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const result = await query(
      `SELECT r.*,
        (SELECT er.status FROM studio.evaluation_runs er WHERE er.candidate_release_id=r.id ORDER BY er.created_at DESC LIMIT 1) AS evaluation_status,
        (SELECT count(*)::int FROM studio.release_approvals ra WHERE ra.release_id=r.id AND ra.decision='approved') AS approval_count
       FROM studio.releases r WHERE r.organization_id=$1 ORDER BY r.created_at DESC`, [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/studio/releases", async (request, reply) => {
    const user = requirePermission(request, "studio.release");
    const body = releaseSchema.parse(request.body);
    const promptMap = z.record(z.string(), z.uuid()).default({}).parse(body.manifest.promptVersionIds ?? {});
    const flowVersionId = z.uuid().parse(body.manifest.flowVersionId);
    const promptIds = Object.values(promptMap);
    if (promptIds.length) {
      const verified = await query<{ id: string; code: string }>(
        `SELECT pv.id,p.code FROM studio.prompt_versions pv JOIN studio.prompts p ON p.id=pv.prompt_id
         WHERE p.organization_id=$1 AND pv.id=ANY($2::uuid[]) AND pv.status='published'`, [user.organizationId, promptIds]
      );
      const verifiedMap = new Map(verified.rows.map((row) => [row.code, row.id]));
      if (verified.rows.length !== new Set(promptIds).size || Object.entries(promptMap).some(([code, id]) => verifiedMap.get(code) !== id)) throw createHttpError(400, "INVALID_RELEASE_PROMPTS", "Every prompt key must pin its own published version in this organization.");
    }
    const verifiedFlow = await query<any>(
      `SELECT fv.graph FROM studio.flow_versions fv JOIN studio.flows f ON f.id=fv.flow_id
       WHERE fv.id=$1 AND f.organization_id=$2 AND fv.status='published'`, [flowVersionId, user.organizationId]
    );
    if (!verifiedFlow.rowCount) throw createHttpError(400, "INVALID_RELEASE_FLOW", "The pinned conversation flow must exist, belong to this organization, and be published.");
    const flowPromptCodes = [...new Set(flowGraphSchema.parse(verifiedFlow.rows[0].graph).nodes.map((node) => node.promptCode))];
    const missingFlowPrompts = flowPromptCodes.filter((code) => !promptMap[code]);
    if (missingFlowPrompts.length) throw createHttpError(400, "RELEASE_FLOW_PROMPTS_MISSING", "The release must pin every prompt referenced by its conversation flow.", { missing: missingFlowPrompts });
    const existing = await query("SELECT id FROM studio.releases WHERE organization_id=$1 AND environment=$2 AND manifest=$3::jsonb LIMIT 1", [user.organizationId, body.environment, JSON.stringify(body.manifest)]);
    if (existing.rowCount) throw createHttpError(409, "RELEASE_CONTENT_EXISTS", "An existing release already contains this exact runtime bundle.");
    const checksum = contentHash(canonicalJson(body.manifest));
    const result = await query(
      `INSERT INTO studio.releases(organization_id,release_code,environment,status,manifest,checksum,change_summary,created_by)
       VALUES ($1,$2,$3,'candidate',$4,$5,$6,$7) RETURNING *`,
      [user.organizationId, body.releaseCode, body.environment, JSON.stringify(body.manifest), checksum, body.changeSummary ?? null, user.id]
    );
    return sendData(request, reply, result.rows[0], 201);
  });

  app.post("/api/v1/studio/releases/:id/approve", async (request, reply) => {
    const user = requirePermission(request, "studio.approve");
    const { id } = request.params as { id: string };
    const body = z.object({ decision: z.enum(["approved", "rejected", "changes_requested"]).default("approved"), comment: z.string().max(2000).optional() }).parse(request.body ?? {});
    const result = await withTransaction(async (client) => {
      const release = await client.query<{ id: string; status: string }>("SELECT id,status FROM studio.releases WHERE id=$1 AND organization_id=$2 FOR UPDATE", [id, user.organizationId]);
      if (!release.rowCount) throw createHttpError(404, "RELEASE_NOT_FOUND", "Release not found.");
      await client.query("INSERT INTO studio.release_approvals(release_id,actor_id,decision,comment) VALUES ($1,$2,$3,$4)", [id, user.id, body.decision, body.comment ?? null]);
      const status = body.decision === "approved" ? "candidate" : body.decision === "rejected" ? "archived" : "draft";
      const updated = await client.query("UPDATE studio.releases SET status=$2,approved_by=CASE WHEN $2='candidate' THEN $3 ELSE approved_by END WHERE id=$1 RETURNING *", [id, status, user.id]);
      return updated.rows[0];
    });
    return sendData(request, reply, result);
  });

  app.post("/api/v1/studio/releases/:id/activate", async (request, reply) => {
    const user = requirePermission(request, "studio.release");
    const { id } = request.params as { id: string };
    const result = await withTransaction(async (client) => {
      const release = await client.query<{ id: string; environment: string; approved_by: string | null; evaluation_status: string | null }>(
        `SELECT r.id,r.environment,r.approved_by,
           (SELECT er.status FROM studio.evaluation_runs er WHERE er.candidate_release_id=r.id ORDER BY er.created_at DESC LIMIT 1) AS evaluation_status
         FROM studio.releases r WHERE r.id=$1 AND r.organization_id=$2 AND r.status IN ('candidate','canary') FOR UPDATE`, [id, user.organizationId]
      );
      const row = release.rows[0];
      if (!row) throw createHttpError(409, "RELEASE_NOT_ACTIVATABLE", "The release is not in an activatable state.");
      if (!row.approved_by) throw createHttpError(409, "RELEASE_APPROVAL_REQUIRED", "Approve the release before activation.");
      if (row.evaluation_status !== "passed") throw createHttpError(409, "RELEASE_EVALUATION_REQUIRED", "A passing evaluation run for this candidate is required before activation.");
      await client.query("UPDATE studio.releases SET status='archived' WHERE organization_id=$1 AND environment=$2 AND status='active' AND id<>$3", [user.organizationId, row.environment, id]);
      const updated = await client.query("UPDATE studio.releases SET status='active',activated_at=now() WHERE id=$1 RETURNING *", [id]);
      await emitEvent(client, { eventType: "release.activated", organizationId: user.organizationId, correlationId: request.correlationId, aggregate: { type: "release", id }, payload: { environment: row.environment } });
      await writeAudit(client, user, "studio.release.activated", "release", id, null, updated.rows[0], request.correlationId, request.ip);
      return updated.rows[0];
    });
    return sendData(request, reply, result);
  });

  app.get("/api/v1/studio/datasets", async (request, reply) => {
    const user = requirePermission(request, "studio.read");
    const result = await query(
      `SELECT d.*,v.id AS version_id,v.version_no,v.status,v.row_count,v.validation_summary FROM studio.datasets d
       LEFT JOIN LATERAL (SELECT * FROM studio.dataset_versions WHERE dataset_id=d.id ORDER BY version_no DESC LIMIT 1) v ON true
       WHERE d.organization_id=$1 ORDER BY d.name`, [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/studio/simulate", async (request, reply) => {
    const user = requirePermission(request, "studio.evaluate");
    const body = z.object({ message: z.string().min(1), state: z.string().default("NEW"), botMode: z.string().default("bot") }).parse(request.body);
    const jobId = randomUUID();
    const { simulateDecision } = await import("./evaluation.js");
    return sendData(request, reply, { id: jobId, decision: await simulateDecision({ ...body, organizationId: user.organizationId }) });
  });
}
