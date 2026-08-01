import type { PolicyDecision } from "./types.js";

export const MESSENGER_LIMIT = 1900;

export function splitMessengerText(value: string, limit = MESSENGER_LIMIT) {
  const text = value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`{1,3}([\s\S]*?)`{1,3}/g, "$1")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return [];
  const output: string[] = [];
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    if (paragraph.length <= limit) { output.push(paragraph); continue; }
    const sentences = paragraph.split(/(?<=[.!?;])\s+|\n+/g);
    let buffer = "";
    for (const sentence of sentences) {
      const candidate = buffer ? `${buffer} ${sentence}` : sentence;
      if (candidate.length <= limit) { buffer = candidate; continue; }
      if (buffer) output.push(buffer.trim());
      if (sentence.length <= limit) buffer = sentence;
      else {
        for (let index = 0; index < sentence.length; index += limit) output.push(sentence.slice(index, index + limit));
        buffer = "";
      }
    }
    if (buffer) output.push(buffer.trim());
  }
  return output.filter(Boolean);
}

/**
 * Định dạng tiền theo ngôn ngữ trả lời. Trước đây hard-code locale "en-US"
 * nên số tiền tiếng Việt hiện ra dạng 9,800,000 thay vì 9.800.000.
 */
export function formatVnd(value: number | string, language = "vi") {
  const locale = language === "en" ? "en-US" : "vi-VN";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number(value))} VND`;
}

export interface ComposeInput {
  decision: PolicyDecision;
  contactName?: string;
  course?: { name: string; description?: string | null } | null;
  offerings?: Array<{ delivery_mode: string; schedule_text: string | null; start_at: string | null; certificate: string | null }>;
  pricing?: { standard_price: string; early_bird_price: string | null; currency: string; audience_segment: string; promotion_name: string | null } | null;
  knowledge?: Array<{ content: string }>;
  /** Ngôn ngữ đã resolve từ language.ts. Không tự suy đoán trong renderer. */
  language?: string;
}

interface Templates {
  priceMissing: string;
  price: (input: { course: string; standard: string; earlyBird: string | null; segment: string }) => string;
  courseMissing: string;
  course: (input: { course: string; description: string; availability: string }) => string;
  qualification: (name: string) => string;
  iceBreak: (name: string) => string;
  human: string;
  acknowledge: string;
  /** Mô tả mặc định khi khoá học chưa có description trong catalog. */
  defaultDescription: string;
  deliveryMode: (mode: string) => string;
  schedulePrefix: string;
}

const TEMPLATES: Record<string, Templates> = {
  vi: {
    priceMissing:
      "Học phí của khoá này đang được cập nhật. Em sẽ nhờ tư vấn viên xác nhận lại con số chính xác và phản hồi anh/chị sớm nhất.",
    price: ({ course, standard, earlyBird, segment }) => {
      const promotion = earlyBird ? ` Mức Early Bird hiện tại là ${earlyBird}.` : "";
      return `Khoá ${course} có học phí tiêu chuẩn là ${standard}.${promotion} Mức này áp dụng cho nhóm ${segment}. Anh/chị có muốn em kiểm tra thêm lịch khai giảng gần nhất không ạ?`;
    },
    courseMissing:
      "Em chưa tìm thấy khoá học này trong danh mục hiện tại, nên em sẽ nhờ tư vấn viên kiểm tra lại giúp anh/chị.",
    course: ({ course, description, availability }) =>
      availability
        ? `Về khoá ${course}: ${description}. ${availability}. Anh/chị muốn tìm hiểu thêm về nội dung chương trình hay lịch khai giảng gần nhất ạ?`
        : `Về khoá ${course}: ${description}. Anh/chị muốn tìm hiểu thêm về nội dung chương trình hay lịch khai giảng gần nhất ạ?`,
    qualification: (name) =>
      `Mỗi mục tiêu sẽ phù hợp với một lộ trình học khác nhau. Trong 3–6 tháng tới, anh/chị${name} muốn cải thiện kỹ năng nào nhất ạ?`,
    iceBreak: (name) =>
      `Em chào anh/chị${name}, em có thể hỗ trợ anh/chị tìm lộ trình học phù hợp. Hiện anh/chị đang học tập hoặc làm việc trong lĩnh vực nào ạ?`,
    human: "Em đã ghi nhận thông tin và sẽ nhờ tư vấn viên kiểm tra kỹ để hỗ trợ anh/chị ạ.",
    acknowledge: "Em đã ghi nhận tin nhắn của anh/chị và đang kiểm tra thông tin liên quan ạ.",
    defaultDescription: "khoá học tập trung vào kỹ năng thực hành và khả năng ứng dụng vào công việc",
    deliveryMode: (mode) => ` theo hình thức ${mode}`,
    schedulePrefix: "Lịch học dự kiến là "
  },
  en: {
    priceMissing:
      "The tuition for this course is being updated. I will ask an advisor to verify the exact amount for you.",
    price: ({ course, standard, earlyBird, segment }) => {
      const promotion = earlyBird ? ` The current Early Bird price is ${earlyBird}.` : "";
      return `${course} has a Standard tuition of ${standard}.${promotion} This rule applies to the ${segment} segment. Would you like me to check the nearest schedule as well?`;
    },
    courseMissing:
      "I could not find that course in the current catalog, so I will ask an advisor to verify it for you.",
    course: ({ course, description, availability }) =>
      availability
        ? `For ${course}: ${description}. ${availability}. Would you like more detail about the curriculum or the next start date?`
        : `For ${course}: ${description}. Would you like more detail about the curriculum or the next start date?`,
    qualification: (name) =>
      `Different goals benefit from different learning paths. Which skill would you most like to improve in the next three to six months${name}?`,
    iceBreak: (name) =>
      `Hello${name}, I can help you find a suitable learning path. What field are you currently studying or working in?`,
    human: "I have recorded the information and will ask an advisor to review it carefully and assist you.",
    acknowledge: "I have recorded your message and am checking the relevant information.",
    defaultDescription: "this course focuses on practical skills and workplace application",
    deliveryMode: (mode) => ` in ${mode} mode`,
    schedulePrefix: "The expected schedule is "
  }
};

export function templatesFor(language = "vi") {
  return TEMPLATES[language] ?? TEMPLATES.vi!;
}

/**
 * Draft bám dữ liệu từ tool. Model chỉ được viết lại draft này, không được
 * thêm dữ liệu mới — xem guardrail.ts.
 *
 * Lưu ý: schedule_text giữ nguyên như trong dữ liệu nguồn. Bản trước có hàm
 * englishSchedule() dịch "Thứ 2" -> "Monday", tức là chủ động sửa dữ liệu
 * nghiệp vụ ngay trong renderer.
 */
export function composeResponse(input: ComposeInput) {
  const language = input.language ?? "vi";
  const t = templatesFor(language);
  const name = input.contactName ? ` ${input.contactName}` : "";

  switch (input.decision.stage) {
    case "QNA_PRICE": {
      if (!input.course || !input.pricing) return t.priceMissing;
      return t.price({
        course: input.course.name,
        standard: formatVnd(input.pricing.standard_price, language),
        earlyBird: input.pricing.early_bird_price ? formatVnd(input.pricing.early_bird_price, language) : null,
        segment: input.pricing.audience_segment
      });
    }
    case "QNA_COURSE": {
      if (!input.course) return t.courseMissing;
      const offering = input.offerings?.[0];
      const description = (input.course.description ?? t.defaultDescription).trim().replace(/[.!?]+$/u, "");
      const schedule = offering?.schedule_text ? `${t.schedulePrefix}${offering.schedule_text}` : "";
      const mode = offering?.delivery_mode ? t.deliveryMode(offering.delivery_mode) : "";
      const availability = `${schedule}${mode}`.trim();
      return t.course({ course: input.course.name, description, availability });
    }
    case "QUALIFICATION":
      return t.qualification(name);
    case "ICE_BREAK":
      return t.iceBreak(name);
    case "HUMAN":
      return t.human;
    default:
      return t.acknowledge;
  }
}
