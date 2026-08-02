/**
 * Embedding provider.
 *
 * Bản trước dùng `localEmbedding()` — băm SHA256 từng token vào 64 chiều.
 * Đó là feature hashing, không phải semantic embedding: hai câu cùng nghĩa mà
 * khác từ vựng cho vector gần như trực giao. Hệ quả là **thêm tài liệu vào
 * cũng không giúp AI hiểu thêm**, nó chỉ khớp được khi trùng từ khoá.
 *
 * Đây là lỗi chặn tuyệt đối của Module Tài liệu, nên phải sửa trước mọi thứ.
 */

import { createHash } from "node:crypto";
import { config } from "./config.js";

export interface EmbeddingProfile {
  /** Mã ổn định, ghi vào chunk và collection để biết vector sinh bằng gì. */
  code: string;
  provider: "openai" | "local";
  model: string;
  dimensions: number;
  batchSize: number;
  timeoutMs: number;
  maxRetries: number;
  /** Chỉ dùng được trong Demo Mode, phải cảnh báo rõ trên giao diện. */
  demoOnly: boolean;
}

export const OPENAI_SMALL: EmbeddingProfile = {
  code: "openai-text-embedding-3-small-1536",
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
  batchSize: 96,
  timeoutMs: 30_000,
  maxRetries: 3,
  demoOnly: false
};

export const LOCAL_HASH: EmbeddingProfile = {
  code: "local-feature-hash-64",
  provider: "local",
  model: "feature-hash-v1",
  dimensions: 64,
  batchSize: 512,
  timeoutMs: 0,
  maxRetries: 0,
  demoOnly: true
};

/**
 * Profile đang hoạt động. Có API key thì dùng embedding thật; không thì rơi về
 * local và hệ thống phải báo `degraded`, không được báo khoẻ.
 */
export function activeProfile(): EmbeddingProfile {
  return config.OPENAI_API_KEY ? OPENAI_SMALL : LOCAL_HASH;
}

export function profileByCode(code: string): EmbeddingProfile {
  return [OPENAI_SMALL, LOCAL_HASH].find((p) => p.code === code) ?? activeProfile();
}

// ---------------------------------------------------------------------------
// Local — chỉ để Demo Mode chạy được khi chưa cấu hình API key
// ---------------------------------------------------------------------------

export function localEmbedding(text: string, dimensions = LOCAL_HASH.dimensions) {
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

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openAiEmbed(texts: string[], profile: EmbeddingProfile): Promise<number[][]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= profile.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
    try {
      const response = await fetch(`${config.OPENAI_BASE_URL.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: profile.model, input: texts })
      });
      const payload = (await response.json()) as {
        data?: Array<{ embedding: number[]; index: number }>;
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(payload.error?.message ?? `Embedding trả về ${response.status}`);
      const rows = payload.data ?? [];
      if (rows.length !== texts.length) {
        throw new Error(`Provider trả ${rows.length} vector cho ${texts.length} đoạn`);
      }
      // Giữ đúng thứ tự đầu vào — provider không đảm bảo thứ tự trả về.
      return [...rows].sort((a, b) => a.index - b.index).map((row) => {
        if (row.embedding.length !== profile.dimensions) {
          throw new Error(`Vector ${row.embedding.length} chiều, cấu hình chờ ${profile.dimensions}`);
        }
        return row.embedding;
      });
    } catch (error) {
      lastError = error;
      // Lỗi tạm thời thì lùi dần rồi thử lại; hết lượt mới ném ra.
      if (attempt < profile.maxRetries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface EmbedResult {
  vectors: number[][];
  profile: EmbeddingProfile;
  /** Số đoạn thất bại sau khi đã thử lại. Tài liệu vẫn lưu, chunk lỗi đánh dấu riêng. */
  failures: Array<{ index: number; error: string }>;
}

/**
 * Nhúng nhiều đoạn. Chia lô theo `batchSize` để không vượt giới hạn provider,
 * và một lô hỏng không kéo đổ cả tài liệu.
 */
export async function embedTexts(texts: string[], profile = activeProfile()): Promise<EmbedResult> {
  if (!texts.length) return { vectors: [], profile, failures: [] };

  if (profile.provider === "local") {
    return { vectors: texts.map((text) => localEmbedding(text, profile.dimensions)), profile, failures: [] };
  }

  const vectors: number[][] = new Array(texts.length);
  const failures: EmbedResult["failures"] = [];

  for (let start = 0; start < texts.length; start += profile.batchSize) {
    const slice = texts.slice(start, start + profile.batchSize);
    try {
      const embedded = await openAiEmbed(slice, profile);
      embedded.forEach((vector, offset) => { vectors[start + offset] = vector; });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      slice.forEach((_, offset) => {
        failures.push({ index: start + offset, error: message });
        // Vector rỗng để lời gọi bên ngoài biết đoạn này chưa nhúng được.
        vectors[start + offset] = [];
      });
    }
  }
  return { vectors, profile, failures };
}

export async function embedOne(text: string, profile = activeProfile()) {
  const result = await embedTexts([text], profile);
  const vector = result.vectors[0];
  if (!vector?.length) throw new Error(result.failures[0]?.error ?? "Không nhúng được nội dung");
  return { vector, profile: result.profile };
}

export function vectorLiteral(vector: number[]) {
  return `[${vector.join(",")}]`;
}
