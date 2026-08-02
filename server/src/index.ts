import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { ZodError } from "zod";
import { authenticateRequest } from "./auth.js";
import { config } from "./config.js";
import { closeDatabase } from "./db.js";
import { startEventListener, stopEventListener } from "./events.js";
import { createHttpError, requestCorrelationId } from "./http.js";
import { registerCoreRoutes } from "./routes-core.js";
import { registerStudioRoutes } from "./routes-studio.js";
import { registerStructuredRoutes } from "./routes-structured.js";
import { registerPlatformRoutes } from "./routes-platform.js";

export function createApp() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 10 * 1024 * 1024,
    genReqId: () => crypto.randomUUID()
  });

  app.decorateRequest("user", null);
  app.decorateRequest("correlationId", "");
  app.decorateRequest("rawBody", undefined);

  app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    allowedHeaders: ["content-type", "x-correlation-id", "x-hub-signature-256", "x-tm-webhook-secret"]
  });
  app.register(cookie);
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    request.rawBody = raw;
    try {
      done(null, raw.length ? JSON.parse(raw.toString("utf8")) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    request.correlationId = requestCorrelationId(request);
    reply.header("x-correlation-id", request.correlationId);
    await authenticateRequest(request);
  });

  app.addHook("preHandler", async (request) => {
    const params = request.params as Record<string, unknown> | null;
    if (!params) return;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const [key, value] of Object.entries(params)) {
      if ((key === "id" || key.endsWith("Id")) && typeof value === "string" && !uuid.test(value)) {
        throw createHttpError(400, "INVALID_RESOURCE_ID", `${key} is not a valid UUID.`);
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const typedError = error as Error & { statusCode?: number; code?: string; details?: unknown };
    const statusCode = error instanceof ZodError ? 400 : (error as Error & { statusCode?: number }).statusCode ?? 500;
    const code = error instanceof ZodError ? "VALIDATION_ERROR" : (error as Error & { code?: string }).code ?? "INTERNAL_ERROR";
    if (statusCode >= 500) request.log.error(error);
    reply.code(statusCode).send({
      error: {
        code,
        message: statusCode >= 500 && config.APP_ENV === "production" ? "Internal server error" : typedError.message,
        details: error instanceof ZodError ? error.issues : typedError.details
      },
      meta: { request_id: request.correlationId }
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "API endpoint not found." }, meta: { request_id: request.correlationId } });
  });

  app.register(registerCoreRoutes);
  app.register(registerStructuredRoutes);
  app.register(registerStudioRoutes);
  app.register(registerPlatformRoutes);
  return app;
}

async function main() {
  const app = createApp();
  await startEventListener();
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  const shutdown = async () => {
    await app.close();
    await stopEventListener();
    await closeDatabase();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.env.NODE_ENV !== "test") {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
