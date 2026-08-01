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

export function formatVnd(value: number | string) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value))} VND`;
}

function englishSchedule(value: string) {
  return value
    .replace(/Chủ\s*nhật/giu, "Sunday")
    .replace(/Thứ\s*2/giu, "Monday")
    .replace(/Thứ\s*3/giu, "Tuesday")
    .replace(/Thứ\s*4/giu, "Wednesday")
    .replace(/Thứ\s*5/giu, "Thursday")
    .replace(/Thứ\s*6/giu, "Friday")
    .replace(/Thứ\s*7/giu, "Saturday");
}

export interface ComposeInput {
  decision: PolicyDecision;
  contactName?: string;
  course?: { name: string; description?: string | null } | null;
  offerings?: Array<{ delivery_mode: string; schedule_text: string | null; start_at: string | null; certificate: string | null }>;
  pricing?: { standard_price: string; early_bird_price: string | null; currency: string; audience_segment: string; promotion_name: string | null } | null;
  knowledge?: Array<{ content: string }>;
}

export function composeResponse(input: ComposeInput) {
  const name = input.contactName ? ` ${input.contactName}` : "";
  switch (input.decision.stage) {
    case "QNA_PRICE": {
      if (!input.course || !input.pricing) return "The tuition for this course is being updated. I will ask an advisor to verify the exact amount for you.";
      const standard = formatVnd(input.pricing.standard_price);
      const earlyBird = input.pricing.early_bird_price ? formatVnd(input.pricing.early_bird_price) : null;
      const promotion = earlyBird ? ` The current Early Bird price is ${earlyBird}.` : "";
      return `${input.course.name} has a Standard tuition of ${standard}.${promotion} This rule applies to the ${input.pricing.audience_segment} segment. Would you like me to check the nearest schedule as well?`;
    }
    case "QNA_COURSE": {
      if (!input.course) return "I could not find that course in the current catalog, so I will ask an advisor to verify it for you.";
      const offering = input.offerings?.[0];
      const description = (input.course.description ?? "This course focuses on practical skills and workplace application").trim().replace(/[.!?]+$/u, "");
      const schedule = offering?.schedule_text ? ` The expected schedule is ${englishSchedule(offering.schedule_text)}` : "";
      const mode = offering?.delivery_mode ? ` in ${offering.delivery_mode} mode` : "";
      const availability = `${schedule}${mode}`.trim();
      return availability
        ? `For ${input.course.name}: ${description}. ${availability}. Would you like more detail about the curriculum or the next start date?`
        : `For ${input.course.name}: ${description}. Would you like more detail about the curriculum or the next start date?`;
    }
    case "QUALIFICATION":
      return `Different goals benefit from different learning paths. Which skill would you most like to improve in the next three to six months${name}?`;
    case "ICE_BREAK":
      return `Hello${name}, I can help you find a suitable learning path. What field are you currently studying or working in?`;
    case "HUMAN":
      return "I have recorded the information and will ask an advisor to review it carefully and assist you.";
    default:
      return "I have recorded your message and am checking the relevant information.";
  }
}
