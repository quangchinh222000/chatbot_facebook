import { randomUUID } from "node:crypto";
import { query, withTransaction } from "./db.js";
import { previewConversationResponse } from "./orchestrator.js";
import { emitEvent } from "./platform.js";
import { ORGANIZATION_ID } from "./types.js";

/**
 * Trước đây evaluation chạy trên `simulateDecision` — một bản sao rút gọn của
 * pipeline, chỉ gồm hard rules + classifier. Nghĩa là pass evaluation không
 * chứng minh được gì về pipeline chạy thật.
 *
 * Nay mọi test case đều đi qua previewConversationResponse, tức là qua
 * executeTurn() — cùng một hàm mà Live dùng.
 */
export async function simulateDecision(input: {
  message: string;
  state?: string;
  botMode?: string;
  organizationId?: string;
  releaseId?: string | null;
  language?: string | null;
}) {
  const result = await previewConversationResponse({
    organizationId: input.organizationId ?? ORGANIZATION_ID,
    message: input.message,
    state: input.state,
    botMode: input.botMode,
    releaseId: input.releaseId ?? null,
    language: input.language ?? null,
    mode: "eval"
  });
  return {
    ...result.decision,
    course: result.course,
    requiredTool: result.requiredTool,
    language: result.language,
    preview: result
  };
}

interface ExpectedCase {
  stage?: string;
  route?: string;
  reason?: string;
  required_tool?: string;
  response_grounded?: boolean;
  required_phrases?: string[];
  forbidden_phrases?: string[];
  model_required?: boolean;
  /** Ngôn ngữ trả lời mong đợi — kiểm tra được từ Đợt 1 (yêu cầu 5.1). */
  language?: string;
}

export async function runEvaluation(runId: string, correlationId: string = randomUUID()) {
  const runResult = await query<{ id: string; organization_id: string; suite_id: string; candidate_release_id: string | null }>(
    "UPDATE studio.evaluation_runs SET status = 'running', started_at = now() WHERE id = $1 RETURNING id, organization_id, suite_id, candidate_release_id",
    [runId]
  );
  const run = runResult.rows[0];
  if (!run) throw new Error("Evaluation run not found");

  const cases = await query<{
    id: string;
    code: string;
    input: { message: string; state?: string; botMode?: string; language?: string };
    expected: ExpectedCase;
    severity: string;
  }>("SELECT id, code, input, expected, severity FROM studio.evaluation_cases WHERE suite_id = $1 ORDER BY code", [run.suite_id]);

  let passed = 0;
  let criticalViolations = 0;

  for (const testCase of cases.rows) {
    const started = Date.now();
    const violations: string[] = [];
    let actual: Awaited<ReturnType<typeof simulateDecision>> | null = null;

    try {
      actual = await simulateDecision({
        message: testCase.input.message,
        state: testCase.input.state,
        botMode: testCase.input.botMode,
        organizationId: run.organization_id,
        releaseId: run.candidate_release_id,
        language: testCase.input.language ?? null
      });

      const expected = testCase.expected;
      if (expected.stage && actual.stage !== expected.stage) violations.push(`stage:${actual.stage}!=${expected.stage}`);
      if (expected.route && actual.route !== expected.route) violations.push(`route:${actual.route}!=${expected.route}`);
      if (expected.reason && actual.reasonCode !== expected.reason) violations.push(`reason:${actual.reasonCode}!=${expected.reason}`);
      if (expected.required_tool && actual.requiredTool !== expected.required_tool) {
        violations.push(`tool:${actual.requiredTool}!=${expected.required_tool}`);
      }
      if (expected.language && actual.preview.language.language !== expected.language) {
        violations.push(`language:${actual.preview.language.language}!=${expected.language}`);
      }

      if (expected.response_grounded) {
        const preview = actual.preview;
        if (!preview.validation.valid) violations.push(...preview.validation.violations.map((violation) => `response:${violation}`));
        if (!preview.validation.tool_policy) violations.push("response:tool_policy");
        if (expected.model_required && preview.provider !== "openai-compatible") {
          violations.push(`response:model_fallback:${preview.error ?? "unknown"}`);
        }
        for (const phrase of expected.required_phrases ?? []) {
          if (!preview.final.toLocaleLowerCase().includes(phrase.toLocaleLowerCase())) {
            violations.push(`response:missing_phrase:${phrase}`);
          }
        }
        for (const phrase of expected.forbidden_phrases ?? []) {
          if (preview.final.toLocaleLowerCase().includes(phrase.toLocaleLowerCase())) {
            violations.push(`response:forbidden_phrase:${phrase}`);
          }
        }
      }
    } catch (error) {
      // Một case lỗi không được làm hỏng cả suite — ghi nhận rồi chạy tiếp.
      violations.push(`error:${error instanceof Error ? error.message : String(error)}`);
    }

    const status = violations.length ? "failed" : "passed";
    if (status === "passed") passed += 1;
    if (violations.length && testCase.severity === "critical") criticalViolations += 1;

    await query(
      `INSERT INTO studio.evaluation_results(run_id, case_id, status, actual, violations, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (run_id, case_id) DO UPDATE
       SET status = EXCLUDED.status, actual = EXCLUDED.actual, violations = EXCLUDED.violations, latency_ms = EXCLUDED.latency_ms`,
      [runId, testCase.id, status, JSON.stringify(actual ?? {}), JSON.stringify(violations), Date.now() - started]
    );
  }

  const total = cases.rowCount ?? 0;
  const passRate = total ? passed / total : 0;
  const finalStatus = passRate === 1 && criticalViolations === 0 ? "passed" : "failed";
  const metrics = { total, passed, failed: total - passed, pass_rate: passRate, critical_violations: criticalViolations };

  await withTransaction(async (client) => {
    await client.query("UPDATE studio.evaluation_runs SET status = $2, metrics = $3, completed_at = now() WHERE id = $1", [
      runId,
      finalStatus,
      JSON.stringify(metrics)
    ]);
    await emitEvent(client, {
      eventType: "evaluation.run.completed",
      organizationId: run.organization_id,
      correlationId,
      aggregate: { type: "evaluation_run", id: runId },
      payload: { status: finalStatus, metrics }
    });
  });
  return { runId, status: finalStatus, metrics };
}
