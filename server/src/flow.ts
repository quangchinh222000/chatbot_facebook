import type { DatabaseExecutor } from "./types.js";
import { z } from "zod";

export const runtimeStages = ["ICE_BREAK", "QUALIFICATION", "QNA_COURSE", "QNA_PRICE", "HUMAN"] as const;

export const flowNodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/i).max(80),
  label: z.string().min(2).max(120),
  runtimeStage: z.enum(runtimeStages),
  promptCode: z.string().regex(/^[a-z0-9_-]+$/i).max(80),
  description: z.string().max(500).default(""),
  position: z.object({ x: z.number().min(0).max(5000), y: z.number().min(0).max(5000) }).optional()
});

export const flowEdgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  label: z.string().max(160).default("")
});

export const flowGraphSchema = z.object({
  entryNodeId: z.string().min(1).max(80),
  nodes: z.array(flowNodeSchema).min(1).max(30),
  edges: z.array(flowEdgeSchema).max(100)
}).superRefine((graph, context) => {
  const nodeIds = graph.nodes.map((node) => node.id);
  const stageKeys = graph.nodes.map((node) => node.runtimeStage);
  if (new Set(nodeIds).size !== nodeIds.length) context.addIssue({ code: "custom", message: "Flow node IDs must be unique." });
  if (new Set(stageKeys).size !== stageKeys.length) context.addIssue({ code: "custom", message: "Each runtime stage can appear only once in a flow." });
  if (!nodeIds.includes(graph.entryNodeId)) context.addIssue({ code: "custom", message: "The entry node must reference an existing node." });
  for (const edge of graph.edges) {
    if (!nodeIds.includes(edge.source) || !nodeIds.includes(edge.target)) context.addIssue({ code: "custom", message: `Edge ${edge.id} references a missing node.` });
    if (edge.source === edge.target) context.addIssue({ code: "custom", message: `Edge ${edge.id} cannot loop to the same node.` });
  }
});

export type FlowGraph = z.infer<typeof flowGraphSchema>;

const fallbackPromptCodes: Record<string, string> = {
  ICE_BREAK: "ice-break",
  QUALIFICATION: "qualification",
  QNA_COURSE: "qna-course",
  QNA_PRICE: "qna-price",
  HUMAN: "handover-summary"
};

export async function resolveRuntimeFlow(db: DatabaseExecutor, organizationId: string, release: any) {
  const pinnedId = release?.manifest?.flowVersionId ?? null;
  const result = await db.query<{
    id: string; version_no: number; graph: FlowGraph; code: string; name: string;
  }>(
    `SELECT fv.id,fv.version_no,fv.graph,f.code,f.name
     FROM studio.flow_versions fv JOIN studio.flows f ON f.id=fv.flow_id
     WHERE f.organization_id=$1
       AND (($2::uuid IS NOT NULL AND fv.id=$2) OR ($2::uuid IS NULL AND fv.status='published'))
     ORDER BY CASE WHEN fv.id=$2 THEN 0 ELSE 1 END,fv.version_no DESC LIMIT 1`,
    [organizationId, pinnedId]
  );
  const row = result.rows[0] ?? null;
  return row ? { ...row, graph: flowGraphSchema.parse(row.graph), source: pinnedId ? "release" as const : "published" as const } : null;
}

export function promptCodeForStage(flow: { graph: FlowGraph } | null, stage: string) {
  return flow?.graph.nodes.find((node) => node.runtimeStage === stage)?.promptCode ?? fallbackPromptCodes[stage] ?? "intent-classifier";
}

