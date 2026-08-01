/**
 * Phát hiện và quyết định ngôn ngữ phản hồi.
 *
 * Trước đây orchestrator ép "Write in natural English" trong khối runtime
 * invariants, ghi đè mọi prompt người dùng cấu hình. Toàn bộ quyết định ngôn
 * ngữ nay tập trung ở đây và luôn resolve từ dữ liệu, không hard-code.
 *
 * Thứ tự ưu tiên (yêu cầu 5.1):
 *   1. Ngôn ngữ của tin nhắn hiện tại
 *   2. Ngôn ngữ chính của cuộc hội thoại
 *   3. Cấu hình channel
 *   4. Cấu hình release / prompt
 *   5. Ngôn ngữ mặc định của tổ chức
 */

export type DetectedLanguage = "vi" | "vi-latin" | "en" | "mixed" | "unknown";
export type ReplyLanguage = string;

export interface LanguagePolicy {
  /** Ngôn ngữ mặc định của tổ chức. Mặc định của TM Academy là tiếng Việt. */
  defaultLanguage: ReplyLanguage;
  supportedLanguages: ReplyLanguage[];
  /** follow_customer = bám theo khách. force_default = luôn dùng defaultLanguage. */
  mode: "follow_customer" | "force_default";
  /** Ghi đè ở cấp channel, release hoặc prompt. "inherit" = không ghi đè. */
  channelLanguage?: ReplyLanguage | "inherit" | null;
  releaseLanguage?: ReplyLanguage | "inherit" | null;
}

export const DEFAULT_LANGUAGE_POLICY: LanguagePolicy = {
  defaultLanguage: "vi",
  supportedLanguages: ["vi", "en"],
  mode: "follow_customer"
};

const VIETNAMESE_DIACRITICS =
  /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

/**
 * Từ tiếng Việt phổ biến khi gõ không dấu. Chọn các từ mà chuỗi ký tự của nó
 * hiếm khi là một từ tiếng Anh, để tránh nhận nhầm.
 */
const VIETNAMESE_LATIN_MARKERS = [
  "khoa hoc", "hoc phi", "bao nhieu", "hoc vien", "giang vien", "khai giang",
  "lich hoc", "dang ky", "chuyen khoan", "thanh toan", "tu van", "trung tam",
  "cho minh", "cho em", "cho hoi", "minh muon", "em muon", "ban oi",
  "khong", "duoc", "nhung", "nguoi", "nhieu", "the nao", "o dau", "khi nao",
  "hoc onl", "hoc offline", "co lop", "con slot", "uu dai", "giam gia",
  "chung chi", "tra gop", "hoan phi", "buoi hoc", "thoi gian", "dia diem"
];

/** Từ chức năng tiếng Anh — dấu hiệu mạnh hơn danh từ chuyên ngành. */
const ENGLISH_MARKERS = [
  "the", "is", "are", "what", "how", "when", "where", "which", "does", "do",
  "can", "could", "would", "please", "thanks", "thank", "your", "you", "i",
  "me", "my", "for", "about", "with", "have", "has", "want", "need", "tell",
  "much", "many", "there", "any", "and", "or", "but", "not", "this", "that"
];

function tokenize(text: string) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("vi-VN")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Bỏ dấu tiếng Việt để so khớp marker không dấu.
 * NFD tách dấu thành ký tự tổ hợp, sau đó loại bỏ.
 */
export function stripDiacritics(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export function detectLanguage(text: string): DetectedLanguage {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length < 2) return "unknown";

  const hasDiacritics = VIETNAMESE_DIACRITICS.test(trimmed);
  const flattened = ` ${stripDiacritics(trimmed).toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim()} `;
  const tokens = tokenize(trimmed);
  if (!tokens.length) return "unknown";

  const vietnameseHits = VIETNAMESE_LATIN_MARKERS.filter((marker) => flattened.includes(` ${marker} `) || flattened.includes(`${marker} `)).length;
  const englishHits = ENGLISH_MARKERS.filter((marker) => flattened.includes(` ${marker} `)).length;

  if (hasDiacritics) {
    // Có dấu tiếng Việt là tín hiệu gần như chắc chắn. Chỉ coi là mixed khi
    // phần tiếng Anh cũng đủ mạnh (câu ghép hai thứ tiếng).
    return englishHits >= 4 ? "mixed" : "vi";
  }
  if (vietnameseHits && englishHits && Math.abs(vietnameseHits - englishHits) <= 1) return "mixed";
  if (vietnameseHits > englishHits) return "vi-latin";
  if (englishHits > vietnameseHits) return "en";
  return "unknown";
}

/** Quy ngôn ngữ phát hiện được về ngôn ngữ dùng để trả lời. */
function toReplyLanguage(detected: DetectedLanguage): ReplyLanguage | null {
  switch (detected) {
    // Khách gõ không dấu thì vẫn trả lời tiếng Việt chuẩn có dấu.
    case "vi":
    case "vi-latin":
    case "mixed":
      return "vi";
    case "en":
      return "en";
    default:
      return null;
  }
}

export interface LanguageResolution {
  /** Ngôn ngữ dùng để trả lời. */
  language: ReplyLanguage;
  /** Ngôn ngữ phát hiện được từ tin nhắn hiện tại. */
  detected: DetectedLanguage;
  /** Nguồn quyết định — hiển thị trong trace để debug. */
  source:
    | "current_message"
    | "conversation_primary"
    | "channel_config"
    | "release_config"
    | "organization_default";
}

export function resolveLanguage(input: {
  currentMessage: string;
  conversationLanguage?: ReplyLanguage | null;
  policy?: LanguagePolicy;
}): LanguageResolution {
  const policy = input.policy ?? DEFAULT_LANGUAGE_POLICY;
  const detected = detectLanguage(input.currentMessage);
  const supported = policy.supportedLanguages.length ? policy.supportedLanguages : ["vi"];
  const fallback = supported.includes(policy.defaultLanguage) ? policy.defaultLanguage : supported[0]!;

  if (policy.mode === "force_default") {
    return { language: fallback, detected, source: "organization_default" };
  }

  const fromMessage = toReplyLanguage(detected);
  if (fromMessage && supported.includes(fromMessage)) {
    return { language: fromMessage, detected, source: "current_message" };
  }
  if (input.conversationLanguage && supported.includes(input.conversationLanguage)) {
    return { language: input.conversationLanguage, detected, source: "conversation_primary" };
  }
  const channel = normalizeOverride(policy.channelLanguage);
  if (channel && supported.includes(channel)) {
    return { language: channel, detected, source: "channel_config" };
  }
  const release = normalizeOverride(policy.releaseLanguage);
  if (release && supported.includes(release)) {
    return { language: release, detected, source: "release_config" };
  }
  return { language: fallback, detected, source: "organization_default" };
}

function normalizeOverride(value: ReplyLanguage | "inherit" | null | undefined) {
  return !value || value === "inherit" ? null : value;
}

const LANGUAGE_NAMES: Record<string, string> = {
  vi: "Vietnamese (tiếng Việt, có dấu đầy đủ)",
  en: "English"
};

/**
 * Chỉ thị ngôn ngữ chèn vào system prompt. Đây là thứ THAY THẾ dòng
 * "Write in natural English for Facebook Messenger." hard-code trước đây —
 * nội dung của nó nay phụ thuộc hoàn toàn vào cấu hình đã resolve.
 */
export function languageInstruction(resolution: LanguageResolution) {
  const name = LANGUAGE_NAMES[resolution.language] ?? resolution.language;
  const lines = [`- Reply in ${name}.`];
  if (resolution.detected === "vi-latin") {
    lines.push("- The customer typed Vietnamese without diacritics. Understand it normally and reply in correctly accented Vietnamese.");
  }
  if (resolution.detected === "mixed") {
    lines.push("- The customer mixed Vietnamese and English. Reply in the language above; keep widely used English technical terms as they are.");
  }
  return lines.join("\n");
}
