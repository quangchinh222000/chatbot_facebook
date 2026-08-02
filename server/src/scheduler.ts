/**
 * Bộ lập lịch định kỳ.
 *
 * `platform.jobs` chỉ chạy một lần. Module Prompt cần job hàng tuần rà hội
 * thoại quá khứ, nên cần lịch lặp. Worker gọi `tickSchedules()` mỗi vòng; lịch
 * nào tới hạn thì đẩy một job vào hàng đợi rồi tính lần chạy kế tiếp.
 */

import { randomUUID } from "node:crypto";
import { query, withTransaction } from "./db.js";
import { enqueueJob } from "./platform.js";

interface CronField { min: number; max: number; }
const FIELDS: CronField[] = [
  { min: 0, max: 59 },  // phút
  { min: 0, max: 23 },  // giờ
  { min: 1, max: 31 },  // ngày
  { min: 1, max: 12 },  // tháng
  { min: 0, max: 6 }    // thứ, 0 = Chủ nhật
];

// Bung một trường cron thành tập giá trị.
// Hỗ trợ: dấu sao, "a,b", "a-b", và bước nhảy dạng "a-b/n".
export function parseCronField(token: string, field: CronField): Set<number> {
  const values = new Set<number>();
  for (const part of token.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`Bước cron không hợp lệ: ${part}`);
    let start = field.min;
    let end = field.max;
    if (range && range !== "*") {
      const bounds = range.split("-").map(Number);
      if (bounds.some((n) => !Number.isFinite(n))) throw new Error(`Giá trị cron không hợp lệ: ${part}`);
      start = bounds[0]!;
      end = bounds.length > 1 ? bounds[1]! : bounds[0]!;
    }
    if (start < field.min || end > field.max || start > end) throw new Error(`Cron ngoài phạm vi: ${part}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string) {
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) throw new Error(`Cron phải có 5 trường, nhận được ${tokens.length}`);
  return tokens.map((token, index) => parseCronField(token, FIELDS[index]!));
}

/**
 * Lần chạy kế tiếp sau `from`, tính theo múi giờ `timeZone`.
 *
 * Quét từng phút tối đa 366 ngày. Đơn giản và đủ nhanh cho vài chục lịch, tránh
 * kéo thêm thư viện cron chỉ để làm một việc.
 */
export function nextRunAt(expression: string, from: Date, timeZone = "Asia/Ho_Chi_Minh"): Date | null {
  const [minutes, hours, days, months, weekdays] = parseCron(expression);
  const cursor = new Date(Math.ceil((from.getTime() + 1000) / 60000) * 60000);
  const limit = 366 * 24 * 60;

  for (let i = 0; i < limit; i += 1) {
    const parts = zonedParts(cursor, timeZone);
    if (
      minutes!.has(parts.minute) && hours!.has(parts.hour) &&
      days!.has(parts.day) && months!.has(parts.month) && weekdays!.has(parts.weekday)
    ) {
      return cursor;
    }
    cursor.setTime(cursor.getTime() + 60000);
  }
  return null;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    minute: "2-digit", hour: "2-digit", day: "2-digit", month: "2-digit", weekday: "short"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    minute: Number(parts.minute),
    // Intl trả "24" cho nửa đêm ở một số môi trường.
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAY_INDEX[String(parts.weekday)] ?? 0
  };
}

export interface ScheduleRow {
  id: string;
  organization_id: string;
  code: string;
  job_type: string;
  payload: Record<string, unknown>;
  cron_expression: string;
  timezone: string;
  next_run_at: Date | null;
}

/**
 * Một vòng quét lịch. Trả về số job đã đẩy.
 * Dùng `FOR UPDATE SKIP LOCKED` để nhiều worker chạy song song không đẩy trùng.
 */
export async function tickSchedules(now = new Date()) {
  return withTransaction(async (client) => {
    const due = await client.query<ScheduleRow>(
      `SELECT id, organization_id, code, job_type, payload, cron_expression, timezone, next_run_at
       FROM platform.schedules
       WHERE enabled AND (next_run_at IS NULL OR next_run_at <= $1)
       ORDER BY next_run_at NULLS FIRST
       FOR UPDATE SKIP LOCKED
       LIMIT 20`,
      [now]
    );

    let queued = 0;
    for (const schedule of due.rows) {
      let next: Date | null = null;
      try {
        next = nextRunAt(schedule.cron_expression, now, schedule.timezone);
      } catch (error) {
        await client.query(
          "UPDATE platform.schedules SET enabled = false, last_status = $2 WHERE id = $1",
          [schedule.id, `Cron sai: ${error instanceof Error ? error.message : String(error)}`]
        );
        continue;
      }

      // Lần đầu (next_run_at NULL) chỉ tính giờ kế tiếp, không chạy ngay —
      // tránh bật lịch lên là job chạy tức thì ngoài ý muốn.
      const shouldRun = schedule.next_run_at !== null;
      if (shouldRun) {
        await enqueueJob(
          client,
          schedule.organization_id,
          schedule.job_type,
          { ...schedule.payload, scheduleCode: schedule.code, correlationId: randomUUID() },
          `schedule:${schedule.code}:${now.toISOString().slice(0, 16)}`,
          now,
          60
        );
        queued += 1;
      }

      await client.query(
        `UPDATE platform.schedules
         SET next_run_at = $2, last_run_at = CASE WHEN $3 THEN $4 ELSE last_run_at END,
             last_status = CASE WHEN $3 THEN 'queued' ELSE 'scheduled' END
         WHERE id = $1`,
        [schedule.id, next, shouldRun, now]
      );
    }
    return queued;
  });
}

export async function listSchedules(organizationId: string) {
  const result = await query(
    `SELECT id, code, name, job_type, cron_expression, timezone, enabled,
            last_run_at, last_status, next_run_at
     FROM platform.schedules WHERE organization_id = $1 ORDER BY code`,
    [organizationId]
  );
  return result.rows;
}
