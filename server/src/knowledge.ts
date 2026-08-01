import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client as MinioClient } from "minio";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { enqueueJob, emitEvent } from "./platform.js";
import type { CourseMatch } from "./types.js";

export const minio = new MinioClient({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY
});

export function localEmbedding(text: string, dimensions = 64) {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text.normalize("NFKC").toLocaleLowerCase("vi-VN").match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt16BE(0) % dimensions;
    const sign = digest[2]! % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * (1 + (digest[3]! / 255));
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

export function vectorLiteral(vector: number[]) {
  return `[${vector.join(",")}]`;
}

export function chunkText(content: string, target = 900, max = 1400, overlap = 120) {
  const normalized = content.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = "";
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(max / 3)));
  for (const paragraph of paragraphs) {
    let candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    while (candidate.length > max) {
      let cut = candidate.lastIndexOf(" ", max);
      if (cut < Math.min(target, max) * 0.6) cut = max;
      const head = candidate.slice(0, cut).trim();
      chunks.push(head);
      const suffix = safeOverlap ? head.slice(-safeOverlap).trimStart() : "";
      const remainder = candidate.slice(cut).trimStart();
      candidate = suffix ? `${suffix}\n${remainder}` : remainder;
    }
    buffer = candidate;
  }
  if (buffer) chunks.push(buffer);
  return chunks.filter(Boolean);
}

export async function findCourseByText(organizationId: string, text: string): Promise<CourseMatch | null> {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("vi-VN");
  const exact = await query<{
    id: string;
    code: string;
    name: string;
    description: string | null;
    alias: string;
  }>(
    `SELECT c.id, c.code, c.name, c.description, a.alias::text
     FROM catalog.courses c
     JOIN catalog.course_aliases a ON a.course_id = c.id
     WHERE c.organization_id = $1 AND c.status = 'active'
     ORDER BY length(a.alias::text) DESC`,
    [organizationId]
  );
  for (const row of exact.rows) {
    if (normalized.includes(row.alias.toLocaleLowerCase("vi-VN"))) {
      return { ...row, confidence: 0.98, matchedAlias: row.alias };
    }
  }
  const fuzzy = await query<{
    id: string;
    code: string;
    name: string;
    description: string | null;
    confidence: number;
  }>(
    `SELECT c.id, c.code, c.name, c.description,
            GREATEST(similarity(lower(c.name), lower($2)), COALESCE(max(similarity(lower(a.alias::text), lower($2))), 0))::float AS confidence
     FROM catalog.courses c
     LEFT JOIN catalog.course_aliases a ON a.course_id = c.id
     WHERE c.organization_id = $1 AND c.status = 'active'
     GROUP BY c.id
     ORDER BY confidence DESC
     LIMIT 1`,
    [organizationId, text]
  );
  const row = fuzzy.rows[0];
  return row && row.confidence >= 0.34 ? row : null;
}

export async function lookupCourse(courseId: string) {
  const [course, offerings] = await Promise.all([
    query<{ id: string; code: string; name: string; description: string | null }>("SELECT id, code, name, description FROM catalog.courses WHERE id = $1 AND status = 'active'", [courseId]),
    query<{ id: string; delivery_mode: string; schedule_text: string | null; start_at: string | null; certificate: string | null }>(
      `SELECT id, delivery_mode, schedule_text, start_at::text, certificate
       FROM catalog.offerings WHERE course_id = $1 AND status = 'active'
       ORDER BY start_at ASC NULLS LAST`,
      [courseId]
    )
  ]);
  return { course: course.rows[0] ?? null, offerings: offerings.rows };
}

export async function getPricingQuote(courseId: string, audience = "Working professionals", deliveryMode = "online", asOf = new Date()) {
  const result = await query<{
    id: string;
    currency: string;
    standard_price: string;
    early_bird_price: string | null;
    promotion_name: string | null;
    audience_segment: string;
    delivery_mode: string | null;
    version: number;
  }>(
    `SELECT id, currency, standard_price::text, early_bird_price::text, promotion_name,
            audience_segment, delivery_mode, version
     FROM pricing.rules
     WHERE course_id = $1 AND status = 'published'
       AND effective_from <= $4
       AND (effective_to IS NULL OR effective_to > $4)
     ORDER BY
       CASE WHEN audience_segment = $2 THEN 0 WHEN audience_segment = 'Working professionals' THEN 1 ELSE 2 END,
       CASE WHEN delivery_mode = $3 THEN 0 WHEN delivery_mode = 'online' THEN 1 ELSE 2 END,
       priority ASC
     LIMIT 1`,
    [courseId, audience, deliveryMode, asOf]
  );
  return result.rows[0] ?? null;
}

export async function searchKnowledge(organizationId: string, searchText: string, topK = 5) {
  const embedding = vectorLiteral(localEmbedding(searchText));
  const result = await query<{
    id: string;
    content: string;
    heading_path: string | null;
    document_revision_id: string;
    document_title: string;
    vector_score: number;
    fts_score: number;
    score: number;
  }>(
    `SELECT c.id, c.content, c.heading_path, c.document_revision_id, d.title AS document_title,
            COALESCE(1 - (c.embedding <=> $2::vector), 0)::float AS vector_score,
            ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', $3))::float AS fts_score,
            (0.55 * COALESCE(1 - (c.embedding <=> $2::vector), 0)
             + 0.45 * ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', $3)))::float AS score
     FROM knowledge.chunks c
     JOIN knowledge.document_revisions r ON r.id = c.document_revision_id
     JOIN knowledge.documents d ON d.id = r.document_id
     WHERE c.organization_id = $1 AND r.status IN ('ready','published') AND d.status <> 'archived'
     ORDER BY score DESC, c.created_at DESC
     LIMIT $4`,
    [organizationId, embedding, searchText, Math.min(Math.max(topK, 1), 20)]
  );
  return result.rows;
}

export async function indexDocumentRevision(revisionId: string, correlationId: string) {
  return withTransaction(async (client) => {
    const revision = await client.query<{
      id: string;
      document_id: string;
      clean_content: string;
      organization_id: string;
      profile_id: string;
      target_chars: number;
      max_chars: number;
      overlap_chars: number;
      document_status: string;
      revision_status: string;
    }>(
      `SELECT r.id, r.document_id, r.clean_content, d.organization_id, p.id AS profile_id,
              p.target_chars, p.max_chars, p.overlap_chars,d.status AS document_status,r.status AS revision_status
       FROM knowledge.document_revisions r
       JOIN knowledge.documents d ON d.id = r.document_id
       JOIN knowledge.chunk_profiles p ON p.organization_id = d.organization_id AND p.code = 'heading-aware-v1'
       WHERE r.id = $1 FOR UPDATE`,
      [revisionId]
    );
    const row = revision.rows[0];
    if (!row) throw new Error("Document revision not found");
    if (row.document_status === "archived" || row.revision_status === "archived") return { revisionId, chunkCount: 0, skipped: "archived" };
    await client.query("UPDATE knowledge.document_revisions SET status = 'indexing' WHERE id = $1", [revisionId]);
    await client.query("DELETE FROM knowledge.chunks WHERE document_revision_id = $1", [revisionId]);
    const chunks = chunkText(row.clean_content, row.target_chars, row.max_chars, row.overlap_chars);
    for (const [index, content] of chunks.entries()) {
      const embedding = vectorLiteral(localEmbedding(content));
      await client.query(
        `INSERT INTO knowledge.chunks(
           organization_id, document_revision_id, chunk_profile_id, chunk_index, content, embedding, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6::vector,$7)`,
        [row.organization_id, revisionId, row.profile_id, index, content, embedding, JSON.stringify({ token_estimate: Math.ceil(content.length / 4) })]
      );
    }
    await client.query("UPDATE knowledge.document_revisions SET status = 'ready', updated_at = now() WHERE id = $1", [revisionId]);
    await client.query("UPDATE knowledge.documents SET status = 'ready' WHERE id = $1", [row.document_id]);
    await emitEvent(client, {
      eventType: "knowledge.index.completed",
      organizationId: row.organization_id,
      correlationId,
      aggregate: { type: "document_revision", id: revisionId },
      payload: { documentId: row.document_id, revisionId, chunkCount: chunks.length }
    });
    return { revisionId, chunkCount: chunks.length };
  });
}

function isPrivateAddress(address: string) {
  if (address === "127.0.0.1" || address === "::1" || address === "0.0.0.0") return true;
  if (address.startsWith("10.") || address.startsWith("192.168.") || address.startsWith("169.254.")) return true;
  const match = /^172\.(\d+)\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  return false;
}

export async function validatePublicUrl(input: string) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http/https URLs are allowed");
  if (!url.hostname || url.username || url.password) throw new Error("URL credentials are not allowed");
  if (isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new Error("Private network URL is blocked");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error("URL resolves to a blocked network");
  return url;
}

export async function safeFetchText(input: string, redirects = 0): Promise<string> {
  if (redirects > 3) throw new Error("Too many redirects");
  const url = await validatePublicUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { "user-agent": "TM-Academy-Knowledge-Ingest/1.0" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect without location");
      return safeFetchText(new URL(location, url).toString(), redirects + 1);
    }
    if (!response.ok) throw new Error(`Source URL returned ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!/(text|json|xml|html|markdown)/i.test(type)) throw new Error(`Unsupported content type: ${type}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > 5_000_000) throw new Error("Source exceeds 5 MB");
    const text = await response.text();
    if (text.length > 5_000_000) throw new Error("Source exceeds 5 MB");
    return text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ").replace(/\s+/g, " ").trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function parseDocument(documentId: string, correlationId: string) {
  const result = await query<{
    id: string;
    organization_id: string;
    source_type: string;
    source_url: string | null;
    object_key: string | null;
    title: string;
    status: string;
  }>("SELECT id, organization_id, source_type, source_url, object_key, title, status FROM knowledge.documents WHERE id = $1", [documentId]);
  const document = result.rows[0];
  if (!document) throw new Error("Document not found");
  if (document.status === "archived") return { documentId, revisionId: null, characters: 0, skipped: "archived" };
  let content = "";
  if (document.source_url) {
    content = await safeFetchText(document.source_url);
  } else if (document.object_key) {
    const stream = await minio.getObject(config.MINIO_BUCKET, document.object_key);
    const buffer = await streamToBuffer(stream);
    const response = await fetch(`${config.TIKA_URL}/tika`, {
      method: "PUT",
      headers: { Accept: "text/plain", "Content-Type": "application/octet-stream" },
      body: buffer
    });
    if (!response.ok) throw new Error(`Tika parse failed: ${response.status}`);
    content = (await response.text()).trim();
  }
  if (!content) throw new Error("Parser produced empty content");
  const contentHash = createHash("sha256").update(content).digest("hex");
  return withTransaction(async (client) => {
    const locked = await client.query<{ status: string }>("SELECT status FROM knowledge.documents WHERE id=$1 FOR UPDATE", [documentId]);
    if (locked.rows[0]?.status === "archived") return { documentId, revisionId: null, characters: 0, skipped: "archived" };
    const revision = await client.query<{ id: string }>(
      `INSERT INTO knowledge.document_revisions(
         document_id, revision_no, original_content, clean_content, content_hash, status
       ) SELECT $1, COALESCE(max(revision_no),0)+1, $2, $2, $3, 'draft'
         FROM knowledge.document_revisions WHERE document_id = $1
       RETURNING id`,
      [documentId, content, contentHash]
    );
    const revisionId = revision.rows[0]!.id;
    await client.query("UPDATE knowledge.documents SET status = 'draft' WHERE id = $1", [documentId]);
    await emitEvent(client, {
      eventType: "knowledge.document.parsed",
      organizationId: document.organization_id,
      correlationId,
      aggregate: { type: "document", id: documentId },
      payload: { revisionId, characters: content.length }
    });
    return { documentId, revisionId, characters: content.length };
  });
}

export async function queueDocumentIndex(client: PoolClient, organizationId: string, revisionId: string) {
  return enqueueJob(client, organizationId, "INDEX_DOCUMENT", { revisionId }, `index-document:${revisionId}:${Date.now()}`);
}
