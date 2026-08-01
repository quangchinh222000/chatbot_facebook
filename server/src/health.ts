/**
 * Health check cho từng thành phần của stack (yêu cầu Giai đoạn A).
 *
 * Bản trước /api/v1/health chỉ chạy `SELECT now()` rồi báo "ok", nên UI không
 * thể trả lời được các câu hỏi bắt buộc: MinIO có sống không, Tika có sống
 * không, worker có chạy không, embedding provider đã cấu hình chưa.
 */

import { config, runtimeMode } from "./config.js";
import { query } from "./db.js";
import { minio } from "./knowledge.js";

export type ComponentStatus = "healthy" | "degraded" | "down" | "not_configured";

export interface ComponentHealth {
  component: string;
  status: ComponentStatus;
  detail: string;
  latencyMs?: number;
  meta?: Record<string, unknown>;
}

async function timed<T>(run: () => Promise<T>) {
  const started = Date.now();
  try {
    const value = await run();
    return { ok: true as const, value, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkDatabase(): Promise<ComponentHealth> {
  const result = await timed(() => query<{ now: string }>("SELECT now()::text AS now"));
  return result.ok
    ? { component: "database", status: "healthy", detail: `PostgreSQL phản hồi lúc ${result.value.rows[0]?.now}`, latencyMs: result.latencyMs }
    : { component: "database", status: "down", detail: result.error, latencyMs: result.latencyMs };
}

async function checkMigrations(): Promise<ComponentHealth> {
  const result = await timed(() =>
    query<{ count: string; latest: string | null }>(
      "SELECT count(*)::text AS count, max(filename) AS latest FROM platform.schema_migrations"
    )
  );
  if (!result.ok) return { component: "migrations", status: "down", detail: result.error };
  const row = result.value.rows[0];
  return {
    component: "migrations",
    status: Number(row?.count ?? 0) > 0 ? "healthy" : "down",
    detail: `${row?.count ?? 0} migration đã áp dụng, mới nhất ${row?.latest ?? "—"}`,
    meta: { applied: Number(row?.count ?? 0), latest: row?.latest }
  };
}

async function checkWorker(): Promise<ComponentHealth> {
  const result = await timed(() =>
    query<{ worker_id: string; status: string; seconds_since: number; jobs_processed: string; last_error: string | null }>(
      `SELECT worker_id, status, jobs_processed::text,
              EXTRACT(EPOCH FROM (now() - last_seen_at))::int AS seconds_since, last_error
       FROM platform.worker_heartbeats
       ORDER BY last_seen_at DESC LIMIT 1`
    )
  );
  if (!result.ok) return { component: "worker", status: "down", detail: result.error };
  const row = result.value.rows[0];
  if (!row) {
    return { component: "worker", status: "down", detail: "Chưa có worker nào đăng ký heartbeat" };
  }
  const stale = row.seconds_since > config.WORKER_STALE_SECONDS;
  return {
    component: "worker",
    status: stale ? "down" : row.status === "running" ? "healthy" : "degraded",
    detail: stale
      ? `Worker ${row.worker_id} mất heartbeat ${row.seconds_since}s (ngưỡng ${config.WORKER_STALE_SECONDS}s)`
      : `Worker ${row.worker_id} đang chạy, đã xử lý ${row.jobs_processed} job`,
    meta: { workerId: row.worker_id, secondsSinceHeartbeat: row.seconds_since, lastError: row.last_error }
  };
}

async function checkJobQueue(): Promise<ComponentHealth> {
  const result = await timed(() =>
    query<{ queued: number; failed: number; oldest: number; dead_letters: number }>(
      `SELECT
         count(*) FILTER (WHERE status='queued')::int AS queued,
         count(*) FILTER (WHERE status='failed')::int AS failed,
         COALESCE(max(EXTRACT(EPOCH FROM (now()-available_at))) FILTER (WHERE status='queued' AND available_at<=now()),0)::int AS oldest,
         (SELECT count(*)::int FROM platform.dead_letter_events) AS dead_letters
       FROM platform.jobs`
    )
  );
  if (!result.ok) return { component: "job_queue", status: "down", detail: result.error };
  const row = result.value.rows[0]!;
  const backlogged = row.oldest > 120;
  return {
    component: "job_queue",
    status: row.failed > 0 || backlogged ? "degraded" : "healthy",
    detail: backlogged
      ? `Job cũ nhất đã chờ ${row.oldest}s — worker có thể không tiêu thụ kịp`
      : `${row.queued} job đang chờ, ${row.failed} thất bại, ${row.dead_letters} dead letter`,
    meta: row
  };
}

async function checkMinio(): Promise<ComponentHealth> {
  const result = await timed(() => withTimeout(minio.bucketExists(config.MINIO_BUCKET), 4_000, "MinIO"));
  if (!result.ok) return { component: "minio", status: "down", detail: result.error, latencyMs: result.latencyMs };
  return {
    component: "minio",
    status: result.value ? "healthy" : "degraded",
    detail: result.value ? `Bucket ${config.MINIO_BUCKET} sẵn sàng` : `Bucket ${config.MINIO_BUCKET} chưa tồn tại`,
    latencyMs: result.latencyMs
  };
}

async function checkTika(): Promise<ComponentHealth> {
  const result = await timed(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(`${config.TIKA_URL.replace(/\/$/, "")}/version`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Tika trả về ${response.status}`);
      return (await response.text()).trim();
    } finally {
      clearTimeout(timer);
    }
  });
  return result.ok
    ? { component: "tika", status: "healthy", detail: result.value, latencyMs: result.latencyMs }
    : { component: "tika", status: "down", detail: result.error, latencyMs: result.latencyMs };
}

function checkModelGateway(): ComponentHealth {
  if (!config.OPENAI_API_KEY) {
    return {
      component: "model_gateway",
      status: "not_configured",
      detail: "Chưa có OPENAI_API_KEY — mọi lượt AI sẽ rơi về fallback tất định, không dùng để kết luận chất lượng",
      meta: { model: config.OPENAI_CHAT_MODEL, baseUrl: config.OPENAI_BASE_URL }
    };
  }
  return {
    component: "model_gateway",
    status: "healthy",
    detail: `Đã cấu hình ${config.OPENAI_CHAT_MODEL} qua ${config.OPENAI_BASE_URL}`,
    meta: { model: config.OPENAI_CHAT_MODEL, classifier: config.OPENAI_CLASSIFIER_MODEL }
  };
}

/**
 * Embedding hiện vẫn là feature hashing 64 chiều (local), CHƯA phải semantic
 * embedding thật. Báo cáo đúng sự thật thay vì để UI hiển thị màu xanh.
 * Sẽ thay ở Đợt 3 — xem docs/AUDIT-2026-08.md mục 5.6.
 */
function checkEmbeddingProvider(): ComponentHealth {
  return {
    component: "embedding_provider",
    status: "degraded",
    detail: "Đang dùng local feature-hashing 64 chiều. Chỉ phù hợp Demo Mode, không phải semantic embedding.",
    meta: { provider: "local-feature-hash", dimensions: 64, plannedReplacement: "openai/text-embedding-3-small" }
  };
}

async function checkChannelIntegration(): Promise<ComponentHealth> {
  const configured = Boolean(
    config.META_APP_SECRET && config.META_VERIFY_TOKEN && config.META_PAGE_ACCESS_TOKEN && config.META_PAGE_ID
  );
  // Không được coi Demo Mode là integration healthy (yêu cầu 5.16).
  if (config.DEMO_MODE) {
    return {
      component: "meta_channel",
      status: "not_configured",
      detail: "DEMO_MODE đang bật — không có lời gọi nào ra Facebook, kể cả khi đã có credential",
      meta: { credentialsConfigured: configured }
    };
  }
  return {
    component: "meta_channel",
    status: configured ? "healthy" : "not_configured",
    detail: configured ? "Đủ credential Meta" : "Thiếu một hoặc nhiều credential Meta bắt buộc",
    meta: { credentialsConfigured: configured }
  };
}

async function checkActiveRelease(): Promise<ComponentHealth> {
  const result = await timed(() =>
    query<{ release_code: string; status: string; environment: string }>(
      `SELECT release_code, status, environment FROM studio.releases
       WHERE status IN ('active','canary')
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, activated_at DESC NULLS LAST LIMIT 1`
    )
  );
  if (!result.ok) return { component: "active_release", status: "down", detail: result.error };
  const row = result.value.rows[0];
  return {
    component: "active_release",
    status: row ? "healthy" : "degraded",
    detail: row ? `${row.release_code} (${row.status}, ${row.environment})` : "Chưa có release nào được kích hoạt",
    meta: row ?? undefined
  };
}

export async function collectHealth() {
  const components = await Promise.all([
    checkDatabase(),
    checkMigrations(),
    checkWorker(),
    checkJobQueue(),
    checkMinio(),
    checkTika(),
    Promise.resolve(checkModelGateway()),
    Promise.resolve(checkEmbeddingProvider()),
    checkChannelIntegration(),
    checkActiveRelease()
  ]);

  // "not_configured" và "degraded" không làm cả hệ thống thành down — chúng chỉ
  // mô tả năng lực hiện có. Chỉ thành phần thật sự chết mới hạ trạng thái chung.
  const down = components.filter((item) => item.status === "down");
  const degraded = components.filter((item) => item.status === "degraded");

  return {
    status: down.length ? "down" : degraded.length ? "degraded" : "ok",
    runtimeMode,
    environment: config.APP_ENV,
    demoMode: config.DEMO_MODE,
    checkedAt: new Date().toISOString(),
    components
  };
}
