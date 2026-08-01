/**
 * Hard guardrail cho câu trả lời của model.
 *
 * Bản trước coi MỌI con số xuất hiện trong câu trả lời mà không có trong draft
 * là "invented_fact". Hệ quả: model viết "3 tháng", đánh số danh sách "1." hay
 * đổi định dạng 9,800,000 -> 9.800.000 đều bị đánh trượt, rơi về fallback.
 *
 * Bản này phân biệt:
 *   - Fact CỨNG (tiền, ngày, giờ, phần trăm): bịa hoặc làm mất => vi phạm.
 *   - Số MỀM  (số đếm nhỏ, số thứ tự danh sách): chỉ ghi nhận vào trace.
 *
 * Theo yêu cầu 5.1, guardrail KHÔNG được dùng để ép ngôn ngữ phản hồi.
 */

export interface GuardrailResult {
  valid: boolean;
  checks: Record<string, boolean>;
  violations: string[];
  /** Số mềm model tự thêm — không chặn, nhưng hiển thị trong trace để review. */
  softFacts: string[];
}

const CURRENCY_HINT = /(?:đ|₫|vnd|vnđ|đồng|dong|triệu|trieu|nghìn|nghin|ngàn|ngan)/iu;

/** Bỏ dấu phân cách hàng nghìn để 9.800.000 và 9,800,000 so khớp được với nhau. */
function canonicalNumber(raw: string) {
  const trimmed = raw.replace(/[.,]+$/u, "");
  // Chỉ coi . hoặc , là phân cách hàng nghìn khi theo sau đúng 3 chữ số.
  const withoutSeparators = trimmed.replace(/[.,](?=\d{3}\b)/gu, "");
  return withoutSeparators.replace(/,(?=\d{1,2}\b)/u, ".");
}

interface ExtractedFact {
  canonical: string;
  kind: "money" | "date" | "time" | "percent" | "soft";
}

export function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  const push = (canonical: string, kind: ExtractedFact["kind"]) => {
    const key = `${kind}:${canonical}`;
    if (canonical && !seen.has(key)) {
      seen.add(key);
      facts.push({ canonical, kind });
    }
  };

  // Ngày: 15/09, 15-09-2026, ngày 15 tháng 9
  for (const match of text.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/gu)) {
    const [, day, month, year] = match;
    push(`${Number(day)}/${Number(month)}${year ? `/${year}` : ""}`, "date");
  }
  for (const match of text.matchAll(/ngày\s+(\d{1,2})\s*(?:tháng|\/)\s*(\d{1,2})/giu)) {
    push(`${Number(match[1])}/${Number(match[2])}`, "date");
  }

  // Giờ: 19:30, 19h30
  for (const match of text.matchAll(/\b(\d{1,2})[:h](\d{2})\b/gu)) {
    push(`${Number(match[1])}:${match[2]}`, "time");
  }

  // Phần trăm
  for (const match of text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*%/gu)) {
    push(canonicalNumber(match[1]!), "percent");
  }

  // Số còn lại: tiền nếu >= 1000 hoặc có đơn vị tiền tệ đi kèm, ngược lại là mềm.
  for (const match of text.matchAll(/\d[\d.,]*/gu)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const canonical = canonicalNumber(raw);
    if (!canonical) continue;

    // Bỏ qua nếu đoạn này đã được nhận là ngày/giờ/phần trăm.
    const around = text.slice(Math.max(0, index - 8), index + raw.length + 8);
    if (/[/:h]\s*\d/u.test(around) && /\d\s*[/:h]/u.test(around)) continue;
    if (/^\s*%/u.test(text.slice(index + raw.length))) continue;

    const numeric = Number(canonical.replace(/[^\d.]/gu, ""));
    const context = text.slice(Math.max(0, index - 12), index + raw.length + 12);
    const isMoney = (Number.isFinite(numeric) && numeric >= 1000) || CURRENCY_HINT.test(context);
    push(canonical, isMoney ? "money" : "soft");
  }

  return facts;
}

const PAYMENT_CONFIRMATION =
  /xác nhận.{0,30}(thanh toán|chuyển khoản)|(thanh toán|chuyển khoản).{0,30}(thành công|đã nhận|hoàn tất)|đã nhận được.{0,20}(tiền|thanh toán|chuyển khoản)|confirm(?:ed)?.{0,30}payment|payment.{0,30}(successful|received|confirmed)/iu;

export const MESSENGER_MAX_LENGTH = 6000;

export function validateGroundedResponse(
  original: string,
  candidate: string,
  protectedTerms: string[] = []
): GuardrailResult {
  const sourceFacts = extractFacts(original);
  const candidateFacts = extractFacts(candidate);

  const hardKinds = new Set(["money", "date", "time", "percent"]);
  const sourceHard = new Set(sourceFacts.filter((fact) => hardKinds.has(fact.kind)).map((fact) => fact.canonical));
  const candidateHard = candidateFacts.filter((fact) => hardKinds.has(fact.kind));

  const missingFacts = [...sourceHard].filter(
    (canonical) => !candidateHard.some((fact) => fact.canonical === canonical)
  );
  const inventedFacts = candidateHard
    .filter((fact) => !sourceHard.has(fact.canonical))
    .map((fact) => fact.canonical);

  const sourceSoft = new Set(sourceFacts.filter((fact) => fact.kind === "soft").map((fact) => fact.canonical));
  const softFacts = candidateFacts
    .filter((fact) => fact.kind === "soft" && !sourceSoft.has(fact.canonical))
    .map((fact) => fact.canonical);

  const missingTerms = protectedTerms.filter(
    (term) =>
      term &&
      original.toLocaleLowerCase().includes(term.toLocaleLowerCase()) &&
      !candidate.toLocaleLowerCase().includes(term.toLocaleLowerCase())
  );
  const paymentConfirmed = PAYMENT_CONFIRMATION.test(candidate);

  const checks = {
    has_output: candidate.trim().length > 0,
    all_grounded_numbers_preserved: missingFacts.length === 0,
    no_invented_numbers: inventedFacts.length === 0,
    protected_terms_preserved: missingTerms.length === 0,
    payment_not_confirmed: !paymentConfirmed,
    messenger_length: candidate.length <= MESSENGER_MAX_LENGTH
  };

  const violations = [
    ...(candidate.trim().length ? [] : ["empty_output"]),
    ...missingFacts.map((fact) => `missing_fact:${fact}`),
    ...inventedFacts.map((fact) => `invented_fact:${fact}`),
    ...missingTerms.map((term) => `missing_term:${term}`),
    ...(paymentConfirmed ? ["payment_confirmation"] : []),
    ...(candidate.length > MESSENGER_MAX_LENGTH ? ["messenger_length"] : [])
  ];

  return { valid: Object.values(checks).every(Boolean), checks, violations, softFacts };
}
