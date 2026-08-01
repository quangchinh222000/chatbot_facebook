import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export function dataEnvelope(request: FastifyRequest, data: unknown, warnings: unknown[] = []) {
  return {
    data,
    meta: {
      request_id: request.correlationId,
      permissions: request.user?.permissions ?? [],
      warnings
    }
  };
}

export function sendData(request: FastifyRequest, reply: FastifyReply, data: unknown, statusCode = 200, warnings: unknown[] = []) {
  return reply.code(statusCode).send(dataEnvelope(request, data, warnings));
}

export function createHttpError(statusCode: number, code: string, message: string, details?: unknown) {
  const error = new Error(message) as Error & { statusCode: number; code: string; details?: unknown };
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

export function requestCorrelationId(request: FastifyRequest) {
  const incoming = request.headers["x-correlation-id"];
  if (typeof incoming === "string" && /^[0-9a-f-]{36}$/i.test(incoming)) return incoming;
  return randomUUID();
}

