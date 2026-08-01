import type { PolicyDecision } from "./types.js";

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("vi-VN").replace(/\s+/g, " ").trim();

const paymentSignals = ["chuyển khoản", "đã thanh toán", "thanh toán rồi", "payment", "bank transfer"];
const humanSignals = ["người thật", "tư vấn viên", "chuyên viên", "không muốn nói với bot", "đừng gửi tin tự động", "gặp người", "human", "advisor", "agent", "real person"];
const botSuspicionSignals = ["bạn là bot", "đây là bot", "tin nhắn tự động", "bạn là ai", "ai trả lời", "are you a bot", "automated message", "who is replying"];
const closingSignals = ["đăng ký", "giữ chỗ", "chốt khóa", "ghi danh", "register", "enroll", "reserve a seat", "sign up"];
const negativeSignals = ["không hỏi nữa", "đừng nhắn nữa", "bực", "khó chịu", "không cần", "stop messaging", "do not contact", "not interested"];
const priceSignals = ["học phí", "bao nhiêu tiền", "giá", "early bird", "ưu đãi", "trả góp", "chi phí", "price", "tuition", "fee", "cost", "installment", "discount"];

export function containsAny(text: string, signals: string[]) {
  const normalized = normalize(text);
  return signals.find((signal) => normalized.includes(signal));
}

export function containsPhoneNumber(text: string) {
  return /(?:\+?84|0)(?:\s|\.|-)?\d{2,3}(?:(?:\s|\.|-)?\d){6,8}\b/.test(text);
}

export function evaluateHardRules(text: string, botMode: string): PolicyDecision | null {
  if (botMode === "human") {
    return { route: "stop", stage: "HUMAN", reasonCode: "EXISTING_HUMAN_MODE", signals: ["existing_human_mode"], confidence: 1 };
  }
  const payment = containsAny(text, paymentSignals);
  if (payment) {
    return { route: "human", stage: "HUMAN", reasonCode: "PAYMENT_NOTIFICATION", signals: [payment], confidence: 1 };
  }
  const human = containsAny(text, humanSignals);
  const botSuspicion = containsAny(text, botSuspicionSignals);
  if (human || (botSuspicion && /người|tư vấn|chuyên viên|không muốn|human|advisor|agent|real person/i.test(text))) {
    return { route: "human", stage: "HUMAN", reasonCode: "HUMAN_REQUEST", signals: [human ?? botSuspicion ?? "human_request"], confidence: 1 };
  }
  if (containsPhoneNumber(text)) {
    return { route: "human", stage: "HUMAN", reasonCode: "CONTACT_CAPTURE", signals: ["phone_number"], confidence: 0.99 };
  }
  const negative = containsAny(text, negativeSignals);
  if (negative) {
    return { route: "human", stage: "HUMAN", reasonCode: "CUSTOMER_DISSATISFIED", signals: [negative], confidence: 0.98 };
  }
  const closing = containsAny(text, closingSignals);
  if (closing) {
    return { route: "human", stage: "HUMAN", reasonCode: "CLOSING", signals: [closing], confidence: 0.98 };
  }
  return null;
}

export function classifyConversation(text: string, currentState: string, hasCourse: boolean, historyCount: number): PolicyDecision {
  const price = containsAny(text, priceSignals);
  if (price && hasCourse) {
    return { route: "bot", stage: "QNA_PRICE", signals: [price, "course_match"], confidence: 0.96 };
  }
  if (hasCourse) {
    return { route: "bot", stage: "QNA_COURSE", signals: ["course_match"], confidence: 0.92 };
  }
  if (/\b(khóa|course|lớp)\b/i.test(text)) {
    return { route: "human", stage: "HUMAN", reasonCode: "COURSE_NOT_FOUND", signals: ["unknown_course"], confidence: 0.85 };
  }
  if (currentState === "NEW" && historyCount <= 1) {
    return { route: "bot", stage: "ICE_BREAK", signals: ["new_conversation"], confidence: 0.88 };
  }
  return { route: "bot", stage: "QUALIFICATION", signals: ["context_available"], confidence: 0.82 };
}

export const policySignals = { paymentSignals, humanSignals, priceSignals, closingSignals };
