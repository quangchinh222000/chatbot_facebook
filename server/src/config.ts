import { z } from "zod";

const booleanString = z
  .string()
  .default("false")
  .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase()));

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ADMIN_EMAIL: z.email().default("admin@tm.local"),
  ADMIN_PASSWORD: z.string().min(8).default("Admin@123"),
  APP_ENV: z.enum(["development", "staging", "production", "test"]).default("development"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  // Chỉ là giá trị dự phòng cuối cùng. Nguồn sự thật là
  // platform.runtime_settings.debounce_seconds, có thể ghi đè theo channel
  // qua channel.accounts.policy.debounceSeconds — xem runtime.ts.
  DEBOUNCE_SECONDS: z.coerce.number().min(0).max(300).default(8),
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(25_000),
  WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(120).default(10),
  /** Ngưỡng coi worker là chết khi không thấy heartbeat. */
  WORKER_STALE_SECONDS: z.coerce.number().int().min(5).max(600).default(45),
  DEMO_MODE: z.string().default("true").transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase())),
  LOG_LEVEL: z.string().default("info"),
  MINIO_ENDPOINT: z.string().default("minio"),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: booleanString,
  MINIO_ACCESS_KEY: z.string().default("tm_minio"),
  MINIO_SECRET_KEY: z.string().default("tm_minio_local_only"),
  MINIO_BUCKET: z.string().default("tm-knowledge"),
  TIKA_URL: z.string().url().default("http://tika:9998"),
  META_APP_SECRET: z.string().default(""),
  META_VERIFY_TOKEN: z.string().default(""),
  META_PAGE_ACCESS_TOKEN: z.string().default(""),
  META_PAGE_ID: z.string().default(""),
  META_CHANNEL_NAME: z.string().default("TM Academy Messenger"),
  META_GRAPH_VERSION: z.string().default("v22.0"),
  N8N_WEBHOOK_SECRET: z.string().default(""),
  PUBLIC_WEBHOOK_BASE_URL: z.string().url().default("http://localhost:4000"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_CHAT_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_CLASSIFIER_MODEL: z.string().default("gpt-4o-mini")
});

export const config = schema.parse(process.env);
export const isProduction = config.APP_ENV === "production";

/**
 * Chế độ vận hành hiển thị trên UI (yêu cầu 5.16). DEMO_MODE thắng APP_ENV vì
 * nó là công tắc chặn mọi lời gọi ra bên ngoài.
 */
export type RuntimeMode = "DEMO" | "TEST" | "STAGING" | "PRODUCTION";

export const runtimeMode: RuntimeMode = config.DEMO_MODE
  ? "DEMO"
  : config.APP_ENV === "production"
    ? "PRODUCTION"
    : config.APP_ENV === "staging"
      ? "STAGING"
      : "TEST";

/**
 * Production không được khởi động khi thiếu secret bắt buộc — nếu không, hệ
 * thống sẽ âm thầm chạy với guard rỗng và tự coi integration là healthy.
 */
const PRODUCTION_REQUIRED_SECRETS = [
  "SESSION_SECRET",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "META_PAGE_ACCESS_TOKEN",
  "META_PAGE_ID",
  "N8N_WEBHOOK_SECRET",
  "OPENAI_API_KEY"
] as const;

export function assertProductionSecrets() {
  if (config.APP_ENV !== "production" || config.DEMO_MODE) return;
  const missing = PRODUCTION_REQUIRED_SECRETS.filter((key) => !String(config[key] ?? "").trim());
  if (missing.length) {
    throw new Error(
      `Production khởi động thất bại: thiếu ${missing.join(", ")}. ` +
        "Cấu hình đủ secret hoặc chạy với DEMO_MODE=true."
    );
  }
}
