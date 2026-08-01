import { randomUUID } from "node:crypto";
import { query, withTransaction } from "./db.js";
import { findCourseByText } from "./knowledge.js";
import { previewConversationResponse } from "./orchestrator.js";
import { emitEvent } from "./platform.js";
import { classifyConversation, evaluateHardRules } from "./policy.js";
import { ORGANIZATION_ID } from "./types.js";

export async function simulateDecision(input: { message: string; state?: string; botMode?: string; organizationId?: string }) {
  const organizationId = input.organizationId ?? ORGANIZATION_ID;
  const hard = evaluateHardRules(input.message, input.botMode ?? "bot");
  const course = await findCourseByText(organizationId, input.message);
  const decision = hard ?? classifyConversation(input.message, input.state ?? "NEW", Boolean(course), 1);
  return {
    ...decision,
    course,
    requiredTool: decision.stage === "QNA_PRICE" ? "pricing_quote" : decision.stage === "QNA_COURSE" ? "course_lookup" : null
  };
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
    input: { message: string; state?: string };
    expected: { stage?: string; route?: string; reason?: string; required_tool?: string; response_grounded?: boolean; required_phrases?: string[]; model_required?: boolean };
    severity: string;
  }>("SELECT id, code, input, expected, severity FROM studio.evaluation_cases WHERE suite_id = $1 ORDER BY code", [run.suite_id]);
  let passed = 0;
  let criticalViolations = 0;
  for (const testCase of cases.rows) {
    const started = Date.now();
    const actual = await simulateDecision({ ...testCase.input, organizationId: run.organization_id });
    const violations: string[] = [];
    if (testCase.expected.stage && actual.stage !== testCase.expected.stage) violations.push(`stage:${actual.stage}!=${testCase.expected.stage}`);
    if (testCase.expected.route && actual.route !== testCase.expected.route) violations.push(`route:${actual.route}!=${testCase.expected.route}`);
    if (testCase.expected.reason && actual.reasonCode !== testCase.expected.reason) violations.push(`reason:${actual.reasonCode}!=${testCase.expected.reason}`);
    if (testCase.expected.required_tool && actual.requiredTool !== testCase.expected.required_tool) violations.push(`tool:${actual.requiredTool}!=${testCase.expected.required_tool}`);
    let responsePreview: Awaited<ReturnType<typeof previewConversationResponse>> | null = null;
    if (testCase.expected.response_grounded) {
      responsePreview = await previewConversationResponse({
        organizationId: run.organization_id,
        message: testCase.input.message,
        state: testCase.input.state,
        releaseId: run.candidate_release_id
      });
      if (!responsePreview.validation.valid) violations.push(...responsePreview.validation.violations.map((violation) => `response:${violation}`));
      if (!responsePreview.validation.tool_policy) violations.push("response:tool_policy");
      if (testCase.expected.model_required && responsePreview.provider !== "openai-compatible") violations.push(`response:model_fallback:${responsePreview.error ?? "unknown"}`);
      for (const phrase of testCase.expected.required_phrases ?? []) {
        if (!responsePreview.final.toLocaleLowerCase().includes(phrase.toLocaleLowerCase())) violations.push(`response:missing_phrase:${phrase}`);
      }
    }
    const status = violations.length ? "failed" : "passed";
    if (status === "passed") passed += 1;
    if (violations.length && testCase.severity === "critical") criticalViolations += 1;
    await query(
      `INSERT INTO studio.evaluation_results(run_id, case_id, status, actual, violations, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (run_id, case_id) DO UPDATE
       SET status = EXCLUDED.status, actual = EXCLUDED.actual, violations = EXCLUDED.violations, latency_ms = EXCLUDED.latency_ms`,
      [runId, testCase.id, status, JSON.stringify({ ...actual, response: responsePreview }), JSON.stringify(violations), Date.now() - started]
    );
  }
  const total = cases.rowCount ?? 0;
  const passRate = total ? passed / total : 0;
  const finalStatus = passRate === 1 && criticalViolations === 0 ? "passed" : "failed";
  const metrics = { total, passed, failed: total - passed, pass_rate: passRate, critical_violations: criticalViolations };
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE studio.evaluation_runs SET status = $2, metrics = $3, completed_at = now() WHERE id = $1",
      [runId, finalStatus, JSON.stringify(metrics)]
    );
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
