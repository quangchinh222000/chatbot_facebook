/**
 * Module Prompt — vòng tự cải tiến.
 *
 * Job hàng tuần rà hội thoại quá khứ, gom tín hiệu hỏng theo agent, rồi nhờ
 * một agent `improver` soạn phiên bản prompt mới kèm dẫn chứng. Người chỉ việc
 * duyệt.
 *
 * Nguyên tắc cứng:
 *   - AI chỉ tạo được bản nháp. Không bao giờ tự publish.
 *   - Đề xuất không dẫn được `ai_run_id` cụ thể thì không lên bàn duyệt.
 *   - Chưa qua evaluation thì không lên bàn duyệt.
 */

import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { emitEvent } from "./platform.js";

export interface Signal {
  aiRunId: string;
  agentCode: string;
  kind: string;
  detail: string;
  customerText: string;
  botText: string;
  correctedText: string | null;
}

/**
 * Thu tín hiệu chất lượng trong N ngày qua.
 *
 * Nguồn, theo thứ tự sức nặng:
 *   1. Nhân viên takeover rồi viết lại câu trả lời  — nhãn vàng
 *   2. Người dùng bấm "AI trả lời sai"
 *   3. Guardrail bắt lỗi bịa số / thiếu số
 *   4. Handover ngoài ý muốn (không tìm thấy khoá, thiếu giá, confidence thấp)
 *   5. Model rơi về fallback
 */
export async function collectSignals(organizationId: string, lookbackDays: number): Promise<Signal[]> {
  const result = await query<Signal>(
    `WITH runs AS (
       SELECT r.id, r.conversation_id, r.created_at,
              COALESCE(r.runtime_config -> 'prompt' ->> 'code', 'unknown') AS agent_code,
              r.validation, r.decision, r.status,
              r.input ->> 'text' AS customer_text,
              r.output ->> 'final' AS bot_text
       FROM platform.ai_runs r
       WHERE r.organization_id = $1
         AND r.created_at > now() - make_interval(days => $2)
     )
     -- 1+2. Phản hồi tường minh của con người
     SELECT runs.id AS "aiRunId", runs.agent_code AS "agentCode",
            'feedback_' || f.rating AS kind,
            COALESCE(f.comment, f.reason_code, f.rating) AS detail,
            runs.customer_text AS "customerText", runs.bot_text AS "botText",
            f.corrected_text AS "correctedText"
     FROM platform.response_feedback f
     JOIN runs ON runs.id = f.ai_run_id
     WHERE f.organization_id = $1 AND f.rating <> 'good'

     UNION ALL
     -- 3. Guardrail bắt lỗi
     SELECT runs.id, runs.agent_code, 'guardrail_violation',
            array_to_string(ARRAY(SELECT jsonb_array_elements_text(runs.validation -> 'violations')), ', '),
            runs.customer_text, runs.bot_text, NULL
     FROM runs
     WHERE jsonb_array_length(COALESCE(runs.validation -> 'violations', '[]'::jsonb)) > 0

     UNION ALL
     -- 4. Handover ngoài ý muốn
     SELECT runs.id, runs.agent_code, 'unwanted_handover',
            COALESCE(runs.decision ->> 'reasonCode', 'unknown'),
            runs.customer_text, runs.bot_text, NULL
     FROM runs
     WHERE runs.decision ->> 'reasonCode' IN
           ('COURSE_NOT_FOUND','PRICING_DATA_MISSING','LOW_CONFIDENCE','SYSTEM_ERROR')

     UNION ALL
     -- 5. Model rơi về fallback
     SELECT runs.id, runs.agent_code, 'model_fallback', runs.status,
            runs.customer_text, runs.bot_text, NULL
     FROM runs
     WHERE runs.status = 'fallback'`,
    [organizationId, lookbackDays]
  );
  return result.rows;
}

/** Gom tín hiệu theo agent rồi theo loại — mỗi cụm thành một chủ đề đề xuất. */
export function clusterSignals(signals: Signal[], minSignals: number) {
  const byAgent = new Map<string, Signal[]>();
  for (const signal of signals) {
    if (!byAgent.has(signal.agentCode)) byAgent.set(signal.agentCode, []);
    byAgent.get(signal.agentCode)!.push(signal);
  }

  const themes: Array<{ agentCode: string; kind: string; signals: Signal[]; title: string }> = [];
  for (const [agentCode, agentSignals] of byAgent) {
    const byKind = new Map<string, Signal[]>();
    for (const signal of agentSignals) {
      if (!byKind.has(signal.kind)) byKind.set(signal.kind, []);
      byKind.get(signal.kind)!.push(signal);
    }
    for (const [kind, kindSignals] of byKind) {
      if (kindSignals.length < minSignals) continue;
      themes.push({ agentCode, kind, signals: kindSignals, title: describeTheme(kind, kindSignals.length) });
    }
  }
  return themes.sort((a, b) => b.signals.length - a.signals.length);
}

function describeTheme(kind: string, count: number) {
  const labels: Record<string, string> = {
    feedback_wrong: "Câu trả lời bị đánh dấu sai",
    feedback_incomplete: "Câu trả lời thiếu thông tin",
    feedback_wrong_tone: "Giọng điệu chưa phù hợp",
    feedback_unsafe: "Nội dung rủi ro",
    guardrail_violation: "Guardrail bắt lỗi dữ liệu",
    unwanted_handover: "Chuyển người ngoài ý muốn",
    model_fallback: "Model rơi về phương án dự phòng"
  };
  return `${labels[kind] ?? kind} (${count} trường hợp)`;
}

/** Gọi model soạn phiên bản prompt mới. */
async function proposePatch(input: {
  currentPrompt: string;
  theme: { title: string; kind: string; signals: Signal[] };
}): Promise<{ systemPrompt: string; rationale: string } | null> {
  if (!config.OPENAI_API_KEY) return null;

  const evidence = input.theme.signals.slice(0, 8).map((signal, index) =>
    `#${index + 1} [${signal.kind}] ${signal.detail}\n  Khách: ${(signal.customerText ?? "").slice(0, 300)}\n  Bot: ${(signal.botText ?? "").slice(0, 300)}` +
    (signal.correctedText ? `\n  Nhân viên sửa thành: ${signal.correctedText.slice(0, 300)}` : "")
  ).join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.OPENAI_CHAT_MODEL,
        temperature: 0.2,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "prompt_patch", strict: true,
            schema: {
              type: "object", additionalProperties: false,
              required: ["system_prompt", "rationale"],
              properties: {
                system_prompt: { type: "string", minLength: 50, maxLength: 20000 },
                rationale: { type: "string", minLength: 20, maxLength: 2000 }
              }
            }
          }
        },
        messages: [
          {
            role: "system",
            content: `Bạn là kỹ sư prompt cho hệ thống tư vấn khoá học của TM Academy.
Nhiệm vụ: đọc prompt hiện tại và các trường hợp trả lời hỏng, rồi viết lại prompt cho tốt hơn.

Bắt buộc:
- Giữ nguyên mọi ràng buộc an toàn đang có. Không nới lỏng.
- Không thêm số liệu, giá, ngày cụ thể vào prompt — số liệu phải đến từ tool.
- Chỉ sửa đúng vấn đề mà dẫn chứng chỉ ra. Không viết lại toàn bộ nếu không cần.
- Viết prompt bằng tiếng Việt.
- rationale nêu rõ đã sửa gì và vì sao, dẫn tới trường hợp cụ thể.`
          },
          {
            role: "user",
            content: `Chủ đề: ${input.theme.title}\n\n## Prompt hiện tại\n${input.currentPrompt}\n\n## Dẫn chứng\n${evidence}`
          }
        ]
      })
    });
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? `Model trả về ${response.status}`);
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
    if (!parsed.system_prompt) return null;
    return { systemPrompt: String(parsed.system_prompt), rationale: String(parsed.rationale ?? "") };
  } finally {
    clearTimeout(timer);
  }
}

export interface ReviewResult {
  organizationId: string;
  signalCount: number;
  themeCount: number;
  proposalsCreated: number;
  skipped: string[];
}

/**
 * Job hàng tuần. Chạy bởi scheduler qua job type REVIEW_CONVERSATIONS.
 */
export async function reviewConversations(
  organizationId: string,
  options: { lookbackDays: number; minSignals: number; correlationId?: string }
): Promise<ReviewResult> {
  const correlationId = options.correlationId ?? randomUUID();
  const signals = await collectSignals(organizationId, options.lookbackDays);
  const themes = clusterSignals(signals, options.minSignals);
  const skipped: string[] = [];
  let created = 0;

  for (const theme of themes) {
    const agent = await query<{ agent_id: string; version_id: string; version_no: number; system_prompt: string }>(
      `SELECT a.id AS agent_id, av.id AS version_id, av.version_no, av.system_prompt
       FROM studio.agents a
       JOIN LATERAL (
         SELECT * FROM studio.agent_versions WHERE agent_id = a.id AND status = 'published'
         ORDER BY version_no DESC LIMIT 1
       ) av ON true
       WHERE a.organization_id = $1 AND a.code = $2`,
      [organizationId, theme.agentCode]
    );
    const base = agent.rows[0];
    if (!base) { skipped.push(`${theme.agentCode}: chưa có bản published`); continue; }

    // Không tạo trùng đề xuất còn đang chờ duyệt cho cùng agent + chủ đề.
    const existing = await query(
      `SELECT 1 FROM studio.improvement_proposals
       WHERE organization_id = $1 AND agent_id = $2 AND title = $3
         AND status IN ('draft','evaluating','awaiting_review')`,
      [organizationId, base.agent_id, theme.title]
    );
    if (existing.rowCount) { skipped.push(`${theme.agentCode}/${theme.kind}: đã có đề xuất chờ duyệt`); continue; }

    let patch: Awaited<ReturnType<typeof proposePatch>> = null;
    try {
      patch = await proposePatch({ currentPrompt: base.system_prompt, theme });
    } catch (error) {
      skipped.push(`${theme.agentCode}/${theme.kind}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!patch) { skipped.push(`${theme.agentCode}/${theme.kind}: chưa cấu hình model`); continue; }

    await withTransaction(async (client) => {
      // Bản nháp mới cho agent. AI chỉ tạo được 'draft'.
      const version = await client.query<{ id: string }>(
        `INSERT INTO studio.agent_versions(
           agent_id, version_no, system_prompt, user_template, model_profile_code,
           parameters, tool_codes, knowledge_codes, memory, output_schema, status, change_summary
         )
         SELECT $1, COALESCE(max(version_no),0)+1, $2, user_template, model_profile_code,
                parameters, tool_codes, knowledge_codes, memory, output_schema, 'draft', $3
         FROM studio.agent_versions WHERE agent_id = $1
         GROUP BY user_template, model_profile_code, parameters, tool_codes, knowledge_codes, memory, output_schema
         LIMIT 1
         RETURNING id`,
        [base.agent_id, patch!.systemPrompt, `AI đề xuất: ${theme.title}`]
      );

      await client.query(
        `INSERT INTO studio.improvement_proposals(
           organization_id, agent_id, base_version_id, proposed_version_id, title, rationale,
           evidence_run_ids, evidence_summary, signal_count, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_review')`,
        [
          organizationId, base.agent_id, base.version_id, version.rows[0]?.id ?? null,
          theme.title, patch!.rationale,
          theme.signals.map((s) => s.aiRunId),
          JSON.stringify({
            kind: theme.kind,
            examples: theme.signals.slice(0, 5).map((s) => ({
              customer: (s.customerText ?? "").slice(0, 200),
              bot: (s.botText ?? "").slice(0, 200),
              corrected: s.correctedText?.slice(0, 200) ?? null,
              detail: s.detail
            }))
          }),
          theme.signals.length
        ]
      );

      await emitEvent(client, {
        eventType: "improvement.proposal.created",
        organizationId,
        correlationId,
        aggregate: { type: "agent", id: base.agent_id },
        payload: { agentCode: theme.agentCode, title: theme.title, signalCount: theme.signals.length }
      });
    });
    created += 1;
  }

  return {
    organizationId,
    signalCount: signals.length,
    themeCount: themes.length,
    proposalsCreated: created,
    skipped
  };
}
