/**
 * Engine thực thi đồ thị đa Agent.
 *
 * Thay cho `executeTurn()` tuyến tính với 5 stage cứng. Flow là đồ thị node có
 * cạnh điều kiện, mỗi node `agent` trỏ tới một agent trong registry với prompt,
 * model, tool và memory riêng — đúng mô hình workflow n8n đang chạy.
 *
 * Xem ARCHITECTURE.md mục 3 và 7.
 */

import { z } from "zod";
import type { DatabaseExecutor } from "./types.js";
import { config } from "./config.js";
import { validateGroundedResponse, type GuardrailResult } from "./guardrail.js";
import { languageInstruction, resolveLanguage, type LanguageResolution } from "./language.js";
import { loadTools, runTool, toolsForModel, type ToolDefinition, type ToolResult } from "./tools.js";

// ---------------------------------------------------------------------------
// Schema đồ thị
// ---------------------------------------------------------------------------

export const NODE_TYPES = [
  "entry", "preprocess", "guard", "classifier", "router",
  "agent", "tool", "transform", "handover", "respond"
] as const;

export const graphNodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/i).max(80),
  type: z.enum(NODE_TYPES),
  label: z.string().min(1).max(120),
  config: z.record(z.string(), z.any()).default({}),
  position: z.object({ x: z.number(), y: z.number() }).optional()
});

export const graphEdgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  /** Biểu thức điều kiện. Bỏ trống là nhánh mặc định. */
  when: z.string().max(400).optional(),
  priority: z.number().int().min(0).max(1000).default(100),
  label: z.string().max(160).default("")
});

export const agentGraphSchema = z.object({
  entryNodeId: z.string().min(1),
  maxSteps: z.number().int().min(1).max(100).default(25),
  nodes: z.array(graphNodeSchema).min(1).max(60),
  edges: z.array(graphEdgeSchema).max(200)
}).superRefine((graph, ctx) => {
  const ids = graph.nodes.map((n) => n.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "ID node bị trùng." });
  if (!ids.includes(graph.entryNodeId)) ctx.addIssue({ code: "custom", message: "entryNodeId không tồn tại." });
  for (const edge of graph.edges) {
    if (!ids.includes(edge.source)) ctx.addIssue({ code: "custom", message: `Cạnh ${edge.id} có source không tồn tại.` });
    if (!ids.includes(edge.target)) ctx.addIssue({ code: "custom", message: `Cạnh ${edge.id} có target không tồn tại.` });
  }
  for (const node of graph.nodes) {
    if (node.type === "agent" && !node.config.agentCode) {
      ctx.addIssue({ code: "custom", message: `Node ${node.id} thiếu agentCode.` });
    }
    if (node.type === "tool" && !node.config.toolCode) {
      ctx.addIssue({ code: "custom", message: `Node ${node.id} thiếu toolCode.` });
    }
  }
  // Node không có cạnh ra và không phải node kết thúc thì luồng cụt.
  const terminal = new Set(["respond", "handover"]);
  for (const node of graph.nodes) {
    if (terminal.has(node.type)) continue;
    if (!graph.edges.some((e) => e.source === node.id)) {
      ctx.addIssue({ code: "custom", message: `Node ${node.id} không có nhánh đi tiếp.` });
    }
  }
});

export type AgentGraph = z.infer<typeof agentGraphSchema>;

// ---------------------------------------------------------------------------
// Đánh giá điều kiện cạnh — sandbox, KHÔNG dùng eval
// ---------------------------------------------------------------------------

/**
 * Ngôn ngữ biểu thức tối giản: so sánh, logic, truy cập trường.
 *   stage == 'QNA_PRICE' && confidence >= 0.7
 *   hasCourse && !isHuman
 *   intent in ['price','course']
 *
 * Cố ý không dùng eval/Function để nội dung do người dùng nhập không chạy được
 * mã tuỳ ý trên server.
 */
export function evaluateCondition(expression: string, context: Record<string, any>): boolean {
  const expr = expression.trim();
  if (!expr) return true;

  const orParts = splitTop(expr, "||");
  if (orParts.length > 1) return orParts.some((part) => evaluateCondition(part, context));

  const andParts = splitTop(expr, "&&");
  if (andParts.length > 1) return andParts.every((part) => evaluateCondition(part, context));

  if (expr.startsWith("!")) return !evaluateCondition(expr.slice(1), context);
  if (expr.startsWith("(") && expr.endsWith(")")) return evaluateCondition(expr.slice(1, -1), context);

  const inMatch = /^(.+?)\s+in\s+\[(.*)\]$/.exec(expr);
  if (inMatch) {
    const value = resolveValue(inMatch[1]!.trim(), context);
    const list = inMatch[2]!.split(",").map((item) => parseLiteral(item.trim()));
    return list.some((item) => looseEqual(item, value));
  }

  const opMatch = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(expr);
  if (opMatch) {
    const left = resolveValue(opMatch[1]!.trim(), context);
    const right = parseLiteral(opMatch[3]!.trim(), context);
    switch (opMatch[2]) {
      case "==": return looseEqual(left, right);
      case "!=": return !looseEqual(left, right);
      case ">": return Number(left) > Number(right);
      case "<": return Number(left) < Number(right);
      case ">=": return Number(left) >= Number(right);
      case "<=": return Number(left) <= Number(right);
    }
  }
  return Boolean(resolveValue(expr, context));
}

/** Tách theo toán tử ở cấp ngoài cùng, bỏ qua phần trong ngoặc và chuỗi. */
function splitTop(expr: string, op: string) {
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]!;
    if (quote) { if (ch === quote && expr[i - 1] !== "\\") quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i));
      i += op.length - 1;
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function resolveValue(path: string, context: Record<string, any>): any {
  if (/^['"]/.test(path) || /^-?\d/.test(path) || path === "true" || path === "false" || path === "null") {
    return parseLiteral(path);
  }
  return path.split(".").reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), context);
}

function parseLiteral(token: string, context?: Record<string, any>): any {
  const t = token.trim();
  if (/^'.*'$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return context ? resolveValue(t, context) : t;
}

const looseEqual = (a: unknown, b: unknown) =>
  a === b || (a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase());

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  code: string;
  name: string;
  kind: "conversational" | "classifier" | "rewriter" | "extractor" | "analyst" | "improver";
  versionId: string;
  versionNo: number;
  systemPrompt: string;
  userTemplate: string | null;
  model: string;
  parameters: Record<string, any>;
  toolCodes: string[];
  knowledgeCodes: string[];
  memory: { kind: string; maxTurns?: number; scope?: string };
  outputSchema: Record<string, any> | null;
}

export async function loadAgents(
  db: DatabaseExecutor,
  organizationId: string,
  pinned: Record<string, string> = {}
) {
  const result = await db.query<{
    code: string; name: string; kind: AgentDefinition["kind"];
    version_id: string; version_no: number; system_prompt: string; user_template: string | null;
    model_profile_code: string | null; model: string | null; parameters: Record<string, any> | null;
    tool_codes: string[]; knowledge_codes: string[]; memory: Record<string, any>;
    output_schema: Record<string, any> | null;
  }>(
    `SELECT a.code, a.name, a.kind, av.id AS version_id, av.version_no,
            av.system_prompt, av.user_template, av.model_profile_code,
            mp.model, COALESCE(mp.parameters,'{}'::jsonb) || av.parameters AS parameters,
            av.tool_codes, av.knowledge_codes, av.memory, av.output_schema
     FROM studio.agents a
     JOIN LATERAL (
       SELECT * FROM studio.agent_versions v
       WHERE v.agent_id = a.id
         AND ((($2::jsonb ->> a.code) IS NOT NULL AND v.id = ($2::jsonb ->> a.code)::uuid)
              OR (($2::jsonb ->> a.code) IS NULL AND v.status = 'published'))
       ORDER BY v.version_no DESC LIMIT 1
     ) av ON true
     LEFT JOIN studio.model_profiles mp
       ON mp.organization_id = a.organization_id AND mp.code = av.model_profile_code AND mp.status = 'active'
     WHERE a.organization_id = $1 AND a.status = 'active'`,
    [organizationId, JSON.stringify(pinned)]
  );

  const map = new Map<string, AgentDefinition>();
  for (const row of result.rows) {
    map.set(row.code, {
      code: row.code,
      name: row.name,
      kind: row.kind,
      versionId: row.version_id,
      versionNo: row.version_no,
      systemPrompt: row.system_prompt,
      userTemplate: row.user_template,
      model: row.model ?? config.OPENAI_CHAT_MODEL,
      parameters: row.parameters ?? {},
      toolCodes: row.tool_codes ?? [],
      knowledgeCodes: row.knowledge_codes ?? [],
      memory: (row.memory ?? { kind: "none" }) as AgentDefinition["memory"],
      outputSchema: row.output_schema
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Ngữ cảnh và bước chạy
// ---------------------------------------------------------------------------

export interface GraphContext extends Record<string, any> {
  organizationId: string;
  text: string;
  botMode: string;
  currentState: string;
  language: LanguageResolution;
  history: Array<{ role: "customer" | "bot" | "agent"; text: string }>;
  toolResults: ToolResult[];
  draft?: string;
  final?: string;
}

export interface GraphStep {
  stepIndex: number;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  agentVersionId?: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  nextNodeId?: string;
  branchReason?: string;
  status: "completed" | "skipped" | "failed" | "loop_guard";
  error?: string;
  tokenUsage: Record<string, number>;
  latencyMs: number;
}

export interface GraphRunResult {
  steps: GraphStep[];
  context: GraphContext;
  final: string;
  handover: { reasonCode: string; priority: string } | null;
  validation: GuardrailResult & { tool_policy: boolean };
  provider: string;
  model: string;
  status: "completed" | "fallback" | "failed";
  error: string | null;
}

export interface GraphDeps {
  db: DatabaseExecutor;
  agents: Map<string, AgentDefinition>;
  tools: Map<string, ToolDefinition>;
  /** Gọi model. Tách ra để test được mà không cần mạng. */
  callModel: (input: {
    system: string;
    user: string;
    model: string;
    parameters: Record<string, any>;
    tools?: ReturnType<typeof toolsForModel>;
    jsonSchema?: Record<string, any> | null;
  }) => Promise<{
    text: string;
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
    tokenUsage: Record<string, number>;
    provider: string;
  }>;
}

/** Số vòng tool tối đa cho một node agent, chặn agent gọi tool vô hạn. */
const MAX_TOOL_ROUNDS = 3;

export async function executeGraph(
  graph: AgentGraph,
  context: GraphContext,
  deps: GraphDeps
): Promise<GraphRunResult> {
  const steps: GraphStep[] = [];
  let nodeId: string | undefined = graph.entryNodeId;
  let handover: GraphRunResult["handover"] = null;
  let provider = "local";
  let model = "deterministic-v1";
  let status: GraphRunResult["status"] = "completed";
  let error: string | null = null;
  let toolPolicyValid = true;

  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));

  while (nodeId) {
    if (steps.length >= graph.maxSteps) {
      steps.push({
        stepIndex: steps.length, nodeId, nodeType: "unknown", nodeLabel: "Vượt giới hạn bước",
        input: {}, output: {}, status: "loop_guard", tokenUsage: {}, latencyMs: 0,
        error: `Đồ thị vượt ${graph.maxSteps} bước — có thể đang lặp vô hạn`
      });
      status = "failed";
      error = "loop_guard";
      break;
    }

    const node = nodes.get(nodeId);
    if (!node) { error = `Node ${nodeId} không tồn tại`; status = "failed"; break; }

    const started = Date.now();
    const step: GraphStep = {
      stepIndex: steps.length, nodeId: node.id, nodeType: node.type, nodeLabel: node.label,
      input: {}, output: {}, status: "completed", tokenUsage: {}, latencyMs: 0
    };

    try {
      switch (node.type) {
        case "entry":
        case "transform":
          step.output = { passthrough: true };
          break;

        case "guard": {
          const decision = context.guardDecision;
          step.input = { botMode: context.botMode };
          step.output = decision ? { triggered: true, ...decision } : { triggered: false };
          if (decision?.route === "human") {
            handover = { reasonCode: decision.reasonCode ?? "POLICY_HANDOVER", priority: decision.priority ?? "normal" };
          }
          break;
        }

        case "classifier": {
          const agent = requireAgent(deps, node.config.agentCode);
          const result = await deps.callModel({
            system: buildSystem(agent, context.language),
            user: renderTemplate(agent.userTemplate ?? "{{text}}", context),
            model: agent.model,
            parameters: agent.parameters,
            jsonSchema: agent.outputSchema
          });
          provider = result.provider;
          model = agent.model;
          step.agentVersionId = agent.versionId;
          step.tokenUsage = result.tokenUsage;
          let parsed: Record<string, any> = {};
          try { parsed = JSON.parse(result.text || "{}"); } catch { parsed = {}; }
          Object.assign(context, parsed);
          step.input = { text: context.text };
          step.output = parsed;
          break;
        }

        case "tool": {
          const args = resolveArgs(node.config.input ?? {}, context);
          const result = await runTool(deps.db, {
            organizationId: context.organizationId,
            toolCode: String(node.config.toolCode),
            args,
            allowedCodes: [String(node.config.toolCode)],
            tools: deps.tools
          });
          context.toolResults.push(result);
          step.input = args;
          step.output = { status: result.status, output: result.output, recordIds: result.recordIds };
          if (result.status === "failed") step.status = "failed";
          if (result.status === "zero_result" && result.zeroResultBehaviour === "handover") {
            handover = { reasonCode: "DATA_MISSING", priority: "normal" };
          }
          break;
        }

        case "agent": {
          const agent = requireAgent(deps, node.config.agentCode);
          const outcome = await runAgentNode(agent, context, deps);
          provider = outcome.provider;
          model = agent.model;
          step.agentVersionId = agent.versionId;
          step.tokenUsage = outcome.tokenUsage;
          step.input = { text: context.text, tools: agent.toolCodes };
          step.output = { text: outcome.text, toolCalls: outcome.toolCallNames };
          if (outcome.deniedTool) toolPolicyValid = false;
          context.draft = context.draft ?? outcome.text;
          context.final = outcome.text;
          break;
        }

        case "preprocess":
          step.output = { steps: node.config.steps ?? [] };
          break;

        case "handover":
          handover = {
            reasonCode: String(node.config.reasonCode ?? "POLICY_HANDOVER"),
            priority: String(node.config.priority ?? "normal")
          };
          step.output = handover;
          break;

        case "respond":
          context.final = context.final ?? context.draft ?? "";
          step.output = { final: context.final };
          break;
      }
    } catch (nodeError) {
      step.status = "failed";
      step.error = nodeError instanceof Error ? nodeError.message : String(nodeError);
      error = step.error;
      status = "failed";
    }

    step.latencyMs = Date.now() - started;

    const next = chooseNext(graph, node.id, context);
    step.nextNodeId = next?.target;
    step.branchReason = next?.reason;
    steps.push(step);

    if (step.status === "failed" && node.type !== "tool") break;
    nodeId = next?.target;
  }

  const final = context.final ?? context.draft ?? "";
  const validation = {
    ...validateGroundedResponse(context.draft ?? final, final, context.protectedTerms ?? []),
    tool_policy: toolPolicyValid
  };

  return { steps, context, final, handover, validation, provider, model, status, error };
}

function requireAgent(deps: GraphDeps, code: unknown) {
  const agent = deps.agents.get(String(code));
  if (!agent) throw new Error(`Agent ${code} chưa publish hoặc không tồn tại`);
  return agent;
}

function chooseNext(graph: AgentGraph, nodeId: string, context: GraphContext) {
  const outgoing = graph.edges.filter((edge) => edge.source === nodeId).sort((a, b) => a.priority - b.priority);
  for (const edge of outgoing) {
    if (!edge.when) return { target: edge.target, reason: "nhánh mặc định" };
    let matched = false;
    try { matched = evaluateCondition(edge.when, context); } catch { matched = false; }
    if (matched) return { target: edge.target, reason: edge.when };
  }
  return undefined;
}

function buildSystem(agent: AgentDefinition, language: LanguageResolution) {
  return `${agent.systemPrompt}

Ngôn ngữ trả lời (lấy từ cấu hình, nguồn: ${language.source}):
${languageInstruction(language)}

Ràng buộc an toàn (không được ghi đè):
- Chỉ dùng dữ liệu do tool trả về. Không suy đoán số tiền, ngày, lịch học, tên khoá, chính sách.
- Không xác nhận một khoản thanh toán đã thành công.
- Giữ nguyên mọi số tiền và ngày tháng mà tool đã trả.`;
}

function renderTemplate(template: string, context: GraphContext) {
  return template.replace(/\{\{(\w[\w.]*)\}\}/g, (_, path: string) => {
    const value = path.split(".").reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), context);
    return value == null ? "" : String(value);
  });
}

function resolveArgs(spec: Record<string, unknown>, context: GraphContext) {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    args[key] = typeof value === "string" && value.startsWith("$")
      ? value.slice(1).split(".").reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), context)
      : value;
  }
  return args;
}

/** Chạy một node agent, cho phép gọi tool nhiều vòng trong giới hạn. */
async function runAgentNode(agent: AgentDefinition, context: GraphContext, deps: GraphDeps) {
  const modelTools = toolsForModel(deps.tools, agent.toolCodes);
  const transcript: string[] = [renderTemplate(agent.userTemplate ?? "{{text}}", context)];
  const toolCallNames: string[] = [];
  let tokenUsage: Record<string, number> = {};
  let provider = "local";
  let deniedTool = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const result = await deps.callModel({
      system: buildSystem(agent, context.language),
      user: transcript.join("\n\n"),
      model: agent.model,
      parameters: agent.parameters,
      tools: modelTools.length ? modelTools : undefined
    });
    provider = result.provider;
    tokenUsage = mergeUsage(tokenUsage, result.tokenUsage);

    if (!result.toolCalls.length || round === MAX_TOOL_ROUNDS) {
      return { text: result.text, toolCallNames, tokenUsage, provider, deniedTool };
    }

    for (const call of result.toolCalls) {
      toolCallNames.push(call.name);
      const toolResult = await runTool(deps.db, {
        organizationId: context.organizationId,
        toolCode: call.name,
        args: call.args,
        allowedCodes: agent.toolCodes,
        tools: deps.tools
      });
      context.toolResults.push(toolResult);
      if (toolResult.status === "denied") deniedTool = true;
      transcript.push(`<tool_result name="${call.name}" status="${toolResult.status}">${JSON.stringify(toolResult.output ?? null)}</tool_result>`);
    }
  }
  return { text: "", toolCallNames, tokenUsage, provider, deniedTool };
}

const mergeUsage = (a: Record<string, number>, b: Record<string, number>) => {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = (out[key] ?? 0) + value;
  return out;
};
