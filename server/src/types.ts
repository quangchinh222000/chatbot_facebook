import type { PoolClient } from "pg";

export const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
export const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000030";
export const DEMO_CHANNEL_ID = "00000000-0000-4000-8000-000000000100";
export const SALES_TEAM_ID = "00000000-0000-4000-8000-000000000010";

export type DatabaseExecutor = Pick<PoolClient, "query">;

export interface SessionUser {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  permissions: string[];
  roles: string[];
}

export interface DomainEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  organizationId: string;
  correlationId: string;
  aggregate: { type: string; id: string };
  payload: Record<string, unknown>;
  schemaVersion: 1;
}

export interface CourseMatch {
  id: string;
  code: string;
  name: string;
  description: string | null;
  confidence: number;
  matchedAlias?: string;
}

export interface PolicyDecision {
  route: "bot" | "human" | "stop";
  stage: "NEW" | "ICE_BREAK" | "QUALIFICATION" | "QNA_COURSE" | "QNA_PRICE" | "CLOSING" | "HUMAN" | "RESOLVED";
  reasonCode?: string;
  signals: string[];
  confidence: number;
}

