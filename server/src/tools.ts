/**
 * Thực thi tool từ registry.
 *
 * Trước đây tool là 3 chuỗi hard-code trong `requiredToolForStage()` và bảng
 * `studio.tools` chỉ nằm không. Nay tool được đọc từ DB, kiểm tra tham số theo
 * `input_schema`, và chỉ chạm được đúng nguồn dữ liệu khai báo trong `binding`.
 *
 * AI không bao giờ sinh SQL. Nó gọi tool theo tên, tool tự dựng câu truy vấn
 * trong phạm vi của mình.
 */

import type { DatabaseExecutor } from "./types.js";
import { getPricingQuote, lookupCourse, searchKnowledge } from "./knowledge.js";

export type ZeroResultBehaviour = "ask_clarifying" | "handover" | "return_empty";

export interface ToolDefinition {
  code: string;
  name: string;
  description: string;
  kind: "structured_query" | "knowledge_search" | "pricing_quote" | "http";
  versionId: string;
  versionNo: number;
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  binding: Record<string, any>;
  zeroResultBehaviour: ZeroResultBehaviour;
  timeoutMs: number;
}

export interface ToolResult {
  toolCode: string;
  status: "completed" | "zero_result" | "failed" | "denied";
  output: unknown;
  error?: string;
  latencyMs: number;
  /** Bản ghi cụ thể đã dùng — để trace truy nguyên được số liệu. */
  recordIds: string[];
  zeroResultBehaviour?: ZeroResultBehaviour;
}

export async function loadTools(db: DatabaseExecutor, organizationId: string, codes?: string[]) {
  const result = await db.query<{
    code: string; name: string; description: string; kind: ToolDefinition["kind"];
    version_id: string; version_no: number;
    input_schema: Record<string, any>; output_schema: Record<string, any>;
    binding: Record<string, any>; policy: Record<string, any>;
  }>(
    `SELECT t.code, t.name, COALESCE(t.purpose, t.name) AS description, t.kind,
            tv.id AS version_id, tv.version_no, tv.input_schema, tv.output_schema,
            tv.binding, tv.policy
     FROM studio.tools t
     JOIN LATERAL (
       SELECT * FROM studio.tool_versions
       WHERE tool_id = t.id AND status IN ('published','approved')
       ORDER BY version_no DESC LIMIT 1
     ) tv ON true
     WHERE t.organization_id = $1 AND t.status = 'active'
       AND ($2::text[] IS NULL OR t.code = ANY($2))`,
    [organizationId, codes?.length ? codes : null]
  );
  const map = new Map<string, ToolDefinition>();
  for (const row of result.rows) {
    map.set(row.code, {
      code: row.code,
      name: row.name,
      description: row.description,
      kind: row.kind,
      versionId: row.version_id,
      versionNo: row.version_no,
      inputSchema: row.input_schema ?? {},
      outputSchema: row.output_schema ?? {},
      binding: row.binding ?? {},
      zeroResultBehaviour: (row.policy?.zero_result_behaviour as ZeroResultBehaviour) ?? "return_empty",
      timeoutMs: Number(row.policy?.timeout_ms ?? 5000)
    });
  }
  return map;
}

/**
 * Kiểm tra tham số theo input_schema. Cố ý viết gọn thay vì kéo cả thư viện
 * JSON Schema: chỉ cần required, type và additionalProperties.
 */
export function validateToolInput(schema: Record<string, any>, input: Record<string, unknown>) {
  const errors: string[] = [];
  const properties = (schema.properties ?? {}) as Record<string, any>;
  for (const key of (schema.required ?? []) as string[]) {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      errors.push(`thiếu tham số bắt buộc: ${key}`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in properties)) errors.push(`tham số không được phép: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const spec = properties[key];
    if (!spec || value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const expected = spec.type;
    if (expected === "integer" && (!Number.isInteger(Number(value)))) errors.push(`${key} phải là số nguyên`);
    else if (expected === "number" && Number.isNaN(Number(value))) errors.push(`${key} phải là số`);
    else if (expected && expected !== "integer" && expected !== "number" && actual !== expected) {
      errors.push(`${key} phải là ${expected}, nhận được ${actual}`);
    }
  }
  return errors;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} quá ${ms}ms`)), ms))
  ]);

/**
 * Chạy một tool.
 *
 * `allowedCodes` là danh sách tool của agent đang gọi. Ngoài danh sách đó là
 * chặn — quyền dùng tool thuộc về agent, không thuộc về stage như trước.
 */
export async function runTool(
  db: DatabaseExecutor,
  input: {
    organizationId: string;
    toolCode: string;
    args: Record<string, unknown>;
    allowedCodes: string[];
    tools?: Map<string, ToolDefinition>;
  }
): Promise<ToolResult> {
  const started = Date.now();
  const base = { toolCode: input.toolCode, recordIds: [] as string[] };

  if (!input.allowedCodes.includes(input.toolCode)) {
    return { ...base, status: "denied", output: null, latencyMs: 0,
      error: `Agent không được cấp tool ${input.toolCode}` };
  }

  const tools = input.tools ?? (await loadTools(db, input.organizationId, [input.toolCode]));
  const tool = tools.get(input.toolCode);
  if (!tool) {
    return { ...base, status: "failed", output: null, latencyMs: Date.now() - started,
      error: `Tool ${input.toolCode} không tồn tại hoặc chưa publish` };
  }

  const errors = validateToolInput(tool.inputSchema, input.args);
  if (errors.length) {
    return { ...base, status: "failed", output: null, latencyMs: Date.now() - started,
      error: `Tham số không hợp lệ: ${errors.join("; ")}` };
  }

  try {
    const output = await withTimeout(executeBinding(db, tool, input), tool.timeoutMs, `Tool ${tool.code}`);
    const empty =
      output == null ||
      (Array.isArray(output) && output.length === 0) ||
      (typeof output === "object" && "course" in (output as any) && !(output as any).course);
    return {
      ...base,
      status: empty ? "zero_result" : "completed",
      output,
      recordIds: collectRecordIds(output),
      latencyMs: Date.now() - started,
      zeroResultBehaviour: empty ? tool.zeroResultBehaviour : undefined
    };
  } catch (error) {
    return { ...base, status: "failed", output: null, latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error) };
  }
}

function collectRecordIds(output: unknown): string[] {
  const ids: string[] = [];
  const visit = (value: any, depth = 0) => {
    if (!value || depth > 3) return;
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
    if (typeof value === "object") {
      if (typeof value.id === "string") ids.push(value.id);
      Object.values(value).forEach((item) => visit(item, depth + 1));
    }
  };
  visit(output);
  return [...new Set(ids)];
}

async function executeBinding(
  db: DatabaseExecutor,
  tool: ToolDefinition,
  input: { organizationId: string; args: Record<string, unknown> }
) {
  const args = input.args;
  switch (tool.kind) {
    case "pricing_quote":
      return getPricingQuote(
        String(args.course_id),
        typeof args.audience === "string" ? args.audience : undefined,
        typeof args.delivery_mode === "string" ? args.delivery_mode : undefined,
        args.as_of ? new Date(String(args.as_of)) : undefined
      );

    case "knowledge_search":
      return searchKnowledge(
        input.organizationId,
        String(args.query ?? ""),
        Number(args.top_k ?? tool.binding.topK ?? 3)
      );

    case "structured_query":
      return structuredQuery(db, tool, input);

    case "http":
      throw new Error("Tool kind 'http' chưa được bật");

    default:
      throw new Error(`Tool kind ${tool.kind} không hỗ trợ`);
  }
}

/**
 * Đọc bảng Structured Data trong đúng phạm vi khai báo ở binding.
 *
 * Bảng dựng sẵn (course-catalog, pricing-rules) có schema riêng nên đọc qua
 * hàm chuyên dụng; bảng do người dùng tạo đọc qua registry chung.
 */
async function structuredQuery(
  db: DatabaseExecutor,
  tool: ToolDefinition,
  input: { organizationId: string; args: Record<string, unknown> }
) {
  const tableCode = String(tool.binding.tableCode ?? "");

  if (tableCode === "course-catalog") {
    return lookupCourse(String(input.args.course_id));
  }

  const limit = Math.min(Number(tool.binding.limit ?? 20), 100);
  const columns = Array.isArray(tool.binding.columns) ? (tool.binding.columns as string[]) : null;

  // Lọc theo các tham số agent truyền vào, chỉ trên cột được binding cho phép.
  const filterable = new Set<string>(
    Array.isArray(tool.binding.filters) ? (tool.binding.filters as string[]) : Object.keys(tool.inputSchema.properties ?? {})
  );
  const conditions: string[] = [];
  const params: unknown[] = [input.organizationId, tableCode];
  for (const [key, value] of Object.entries(input.args)) {
    if (!filterable.has(key) || value === undefined || value === null || value === "") continue;
    params.push(key, String(value));
    // Khớp không phân biệt hoa thường; tên cột là tham số nên không nối chuỗi.
    conditions.push(`lower(r.data ->> $${params.length - 1}) = lower($${params.length})`);
  }

  const result = await db.query<{ id: string; data: Record<string, unknown> }>(
    `SELECT r.id, r.data
     FROM structured.records r
     JOIN structured.tables t ON t.id = r.table_id
     WHERE t.organization_id = $1 AND t.code = $2 AND r.status = 'active' AND t.status <> 'archived'
       ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""}
     ORDER BY r.updated_at DESC
     LIMIT ${limit}`,
    params
  );

  return result.rows.map((row) => ({
    id: row.id,
    ...(columns ? Object.fromEntries(columns.filter((c) => c in row.data).map((c) => [c, row.data[c]])) : row.data)
  }));
}

/** Mô tả tool cho model theo định dạng function-calling của OpenAI. */
export function toolsForModel(tools: Map<string, ToolDefinition>, allowedCodes: string[]) {
  return allowedCodes
    .map((code) => tools.get(code))
    .filter((tool): tool is ToolDefinition => Boolean(tool))
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.code,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
}
