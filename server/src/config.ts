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
  DEBOUNCE_SECONDS: z.coerce.number().min(0).max(120).default(20),
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
