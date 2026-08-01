import "fastify";
import type { SessionUser } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    rawBody?: Buffer;
    correlationId: string;
  }
}

