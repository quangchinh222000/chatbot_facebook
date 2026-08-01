import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import type { PoolClient } from "pg";
import type { SessionUser } from "./types.js";
import { writeAudit } from "./platform.js";

export type StructuredImportType = "courses" | "pricing";

type CsvRow = Record<string, string>;

export class CsvValidationError extends Error {
  statusCode = 400;
  code = "CSV_VALIDATION_ERROR";
  details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

function value(row: CsvRow, key: string) {
  return String(row[key] ?? "").trim();
}

function normalized(valueToNormalize: string) {
  return valueToNormalize.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sourceKey(prefix: string, parts: string[]) {
  const stable = parts.map(normalized).join("|");
  return `${prefix}:${createHash("sha256").update(stable).digest("hex").slice(0, 24)}`;
}

function courseCode(name: string) {
  const readable = normalized(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24).toUpperCase() || "COURSE";
  const suffix = createHash("sha256").update(normalized(name)).digest("hex").slice(0, 6).toUpperCase();
  return `${readable}-${suffix}`.slice(0, 40);
}

function list(raw: string) {
  return [...new Set(raw.split(/[\r\n;,]+/).map((item) => item.trim()).filter(Boolean))];
}

function deliveryMode(raw: string): "online" | "offline" | "hybrid" | null {
  const lowered = normalized(raw);
  const online = lowered.includes("online");
  const offline = lowered.includes("offline");
  if (online && offline) return "hybrid";
  if (offline) return "offline";
  if (online) return "online";
  return null;
}

function audienceSegment(raw: string) {
  return raw
    .replace(/NGƯỜI ĐI LÀM/giu, "Working professionals")
    .replace(/SINH VIÊN/giu, "Students")
    .trim();
}

function courseType(raw: string) {
  const lowered = normalized(raw);
  if (lowered === "khoa le") return "Single course";
  if (lowered === "combo") return "Bundle";
  if (lowered.includes("chuong trinh")) return "Program";
  return raw || null;
}

function price(raw: string) {
  if (!raw.trim()) return null;
  const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function date(raw: string) {
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  return iso && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? iso : null;
}

function parseRows(buffer: Buffer) {
  try {
    return parse(buffer, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true
    }) as CsvRow[];
  } catch (reason) {
    throw new CsvValidationError("The CSV file could not be parsed.", [reason instanceof Error ? reason.message : String(reason)]);
  }
}

function validateHeaders(rows: CsvRow[], required: string[]) {
  if (!rows.length) throw new CsvValidationError("The CSV file contains no data rows.", []);
  const headers = Object.keys(rows[0]!);
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new CsvValidationError("The CSV template does not match the selected import type.", { missingHeaders: missing });
}

async function findOrCreateCourse(
  client: PoolClient,
  organizationId: string,
  name: string,
  category: string,
  description: string
) {
  const existing = await client.query<{ id: string }>(
    `SELECT c.id FROM catalog.courses c
     LEFT JOIN catalog.course_facts f ON f.course_id = c.id
     WHERE c.organization_id = $1
       AND (lower(c.name) = lower($2) OR lower(COALESCE(f.source_name, '')) = lower($2))
     ORDER BY c.created_at LIMIT 1`,
    [organizationId, name]
  );
  if (existing.rows[0]) {
    await client.query(
      `UPDATE catalog.courses
       SET name=$2, category=COALESCE(NULLIF($3,''),category), description=COALESCE(NULLIF($4,''),description),
           status='active', version=version+1, updated_at=now()
       WHERE id=$1`,
      [existing.rows[0].id, name, category, description]
    );
    return { id: existing.rows[0].id, inserted: false };
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO catalog.courses(organization_id,code,name,category,description,status)
     VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),'active') RETURNING id`,
    [organizationId, courseCode(name), name, category, description]
  );
  return { id: inserted.rows[0]!.id, inserted: true };
}

async function importCourses(client: PoolClient, organizationId: string, rows: CsvRow[]) {
  validateHeaders(rows, ["cousera", "Nhóm khóa học", "Nội dung khóa học (text)"]);
  const errors: Array<{ row: number; field: string; message: string }> = [];
  const prepared = rows.map((row, index) => {
    const name = value(row, "cousera");
    const startDateRaw = value(row, "Ngày khai giảng gần nhất");
    if (!name && Object.values(row).every((item) => !String(item ?? "").trim())) return null;
    if (!name) errors.push({ row: index + 2, field: "cousera", message: "Course name is required." });
    if (startDateRaw && !date(startDateRaw)) errors.push({ row: index + 2, field: "Ngày khai giảng gần nhất", message: "Use the YYYY-MM-DD date format." });
    return { row, name, startDate: date(startDateRaw) };
  }).filter(Boolean) as Array<{ row: CsvRow; name: string; startDate: string | null }>;
  if (errors.length) throw new CsvValidationError("Course import validation failed. No records were changed.", errors);

  let inserted = 0;
  let updated = 0;
  let skipped = rows.length - prepared.length;
  const seen = new Set<string>();

  for (const item of prepared) {
    const key = sourceKey("course", [item.name]);
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    const row = item.row;
    const curriculum = value(row, "Nội dung khóa học (text)");
    const audienceProfile = value(row, "Profile đối tượng");
    const course = await findOrCreateCourse(
      client,
      organizationId,
      item.name,
      value(row, "Nhóm khóa học"),
      audienceProfile || curriculum.slice(0, 2500)
    );
    course.inserted ? inserted += 1 : updated += 1;

    const aliases = list(value(row, "Cách gọi khác của tên khóa"));
    for (const alias of [item.name, ...aliases]) {
      await client.query("INSERT INTO catalog.course_aliases(course_id,alias) VALUES ($1,$2) ON CONFLICT DO NOTHING", [course.id, alias]);
    }

    const learningModes = list(value(row, "Hình thức học"));
    const offlineRegions = list(value(row, "Khu vực tổ chức học offline"));
    await client.query(
      `INSERT INTO catalog.course_facts(
         course_id,organization_id,source_name,course_type,combo_name,learning_modes,offline_regions,
         next_start_date,schedule_detail,early_bird_slots,course_url,audience_profile,experience_sharing,
         certificate_condition,curriculum_text,curriculum_image,assignment_info,installment_info,
         retake_policy,trainer_info,has_record,source_metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (course_id) DO UPDATE SET
         source_name=EXCLUDED.source_name,course_type=EXCLUDED.course_type,combo_name=EXCLUDED.combo_name,
         learning_modes=EXCLUDED.learning_modes,offline_regions=EXCLUDED.offline_regions,next_start_date=EXCLUDED.next_start_date,
         schedule_detail=EXCLUDED.schedule_detail,early_bird_slots=EXCLUDED.early_bird_slots,course_url=EXCLUDED.course_url,
         audience_profile=EXCLUDED.audience_profile,experience_sharing=EXCLUDED.experience_sharing,
         certificate_condition=EXCLUDED.certificate_condition,curriculum_text=EXCLUDED.curriculum_text,
         curriculum_image=EXCLUDED.curriculum_image,assignment_info=EXCLUDED.assignment_info,
         installment_info=EXCLUDED.installment_info,retake_policy=EXCLUDED.retake_policy,
         trainer_info=EXCLUDED.trainer_info,has_record=EXCLUDED.has_record,source_metadata=EXCLUDED.source_metadata`,
      [
        course.id, organizationId, item.name, courseType(value(row, "Loại khóa học")), value(row, "Tên Combo") || null,
        learningModes, offlineRegions, item.startDate, value(row, "Lịch học chi tiết") || null,
        value(row, "Số slot còn lại / Tổng số slot được ưu đãi đăng ký sớm") || null,
        value(row, "Link khóa học") || null, audienceProfile || null,
        value(row, "Chia sẻ trải nghiệm từng đối tượng với khóa học") || null,
        value(row, "Điều kiện nhận chứng nhận") || null, curriculum || null,
        value(row, "Nội dung khóa học (image)") || null, value(row, "Nội dung bài tập") || null,
        value(row, "Thông tin trả góp") || null, value(row, "Chính sách học lại") || null,
        value(row, "Thông tin Trainer") || null, value(row, "Có record không?") || null,
        JSON.stringify({ source: "structured_csv", source_key: key })
      ]
    );

    const mode = deliveryMode(value(row, "Hình thức học"));
    if (mode) {
      await client.query(
        `INSERT INTO catalog.offerings(
           organization_id,course_id,delivery_mode,schedule_text,start_at,certificate,status,source_key
         ) VALUES ($1,$2,$3,$4,$5::date,$6,'active',$7)
         ON CONFLICT (organization_id,source_key) WHERE source_key IS NOT NULL DO UPDATE SET
           course_id=EXCLUDED.course_id,delivery_mode=EXCLUDED.delivery_mode,schedule_text=EXCLUDED.schedule_text,
           start_at=EXCLUDED.start_at,certificate=EXCLUDED.certificate,status='active',updated_at=now()`,
        [organizationId, course.id, mode, value(row, "Lịch học chi tiết") || null, item.startDate, value(row, "Điều kiện nhận chứng nhận") || null, key]
      );
    }
  }
  return { rows: rows.length, inserted, updated, skipped, errors: 0 };
}

async function importPricing(client: PoolClient, organizationId: string, rows: CsvRow[]) {
  validateHeaders(rows, ["cousera", "Đối tượng", "Giá Standard"]);
  const errors: Array<{ row: number; field: string; message: string }> = [];
  const prepared = rows.map((row, index) => {
    const name = value(row, "cousera");
    const audience = audienceSegment(value(row, "Đối tượng"));
    const standardPrice = price(value(row, "Giá Standard"));
    if (!name && Object.values(row).every((item) => !String(item ?? "").trim())) return null;
    if (!name) errors.push({ row: index + 2, field: "cousera", message: "Course name is required." });
    if (!audience) errors.push({ row: index + 2, field: "Đối tượng", message: "Audience segment is required." });
    if (standardPrice == null) errors.push({ row: index + 2, field: "Giá Standard", message: "Standard price must be a non-negative number." });
    return { row, name, audience, standardPrice };
  }).filter(Boolean) as Array<{ row: CsvRow; name: string; audience: string; standardPrice: number }>;
  if (errors.length) throw new CsvValidationError("Pricing import validation failed. No records were changed.", errors);

  let inserted = 0;
  let updated = 0;
  let skipped = rows.length - prepared.length;
  const seen = new Set<string>();
  for (const item of prepared) {
    const row = item.row;
    const modeRaw = value(row, "Hình thức học");
    const regions = list(value(row, "Khu vực tổ chức học offline"));
    const key = sourceKey("price", [item.name, item.audience, modeRaw, regions.join(",")]);
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    const course = await findOrCreateCourse(client, organizationId, item.name, value(row, "Nhóm khóa học"), "");
    const upserted = await client.query<{ inserted: boolean }>(
      `INSERT INTO pricing.rules(
         organization_id,course_id,audience_segment,delivery_mode,standard_price,early_bird_price,
         group_price,alumni_price,installment_info,note,offline_regions,course_type,combo_name,
         promotion_name,priority,effective_from,status,source_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Structured CSV import',100,current_date,'published',$14)
       ON CONFLICT (organization_id,source_key) WHERE source_key IS NOT NULL DO UPDATE SET
         course_id=EXCLUDED.course_id,audience_segment=EXCLUDED.audience_segment,delivery_mode=EXCLUDED.delivery_mode,
         standard_price=EXCLUDED.standard_price,early_bird_price=EXCLUDED.early_bird_price,
         group_price=EXCLUDED.group_price,alumni_price=EXCLUDED.alumni_price,installment_info=EXCLUDED.installment_info,
         note=EXCLUDED.note,offline_regions=EXCLUDED.offline_regions,course_type=EXCLUDED.course_type,
         combo_name=EXCLUDED.combo_name,status='published',version=pricing.rules.version+1,updated_at=now()
       RETURNING (xmax = 0) AS inserted`,
      [
        organizationId, course.id, item.audience, deliveryMode(modeRaw), item.standardPrice,
        price(value(row, "Giá Early Bird")), price(value(row, "Giá Nhóm")), price(value(row, "Giá Cựu học viên")),
        value(row, "Thông tin trả góp") || null, value(row, "Note") || null, regions,
        courseType(value(row, "Loại khóa học")), value(row, "Tên Combo") || null, key
      ]
    );
    upserted.rows[0]?.inserted ? inserted += 1 : updated += 1;
  }
  return { rows: rows.length, inserted, updated, skipped, errors: 0 };
}

export async function importStructuredCsv(input: {
  client: PoolClient;
  organizationId: string;
  user: SessionUser;
  type: StructuredImportType;
  tableId?: string;
  filename: string;
  buffer: Buffer;
  correlationId: string;
  sourceIp?: string;
}) {
  const rows = parseRows(input.buffer);
  const summary = input.type === "courses"
    ? await importCourses(input.client, input.organizationId, rows)
    : await importPricing(input.client, input.organizationId, rows);
  const run = await input.client.query<{ id: string }>(
    `INSERT INTO platform.import_runs(organization_id,table_id,import_type,filename,status,summary,created_by)
     VALUES ($1,$2,$3,$4,'completed',$5,$6) RETURNING id`,
    [input.organizationId, input.tableId ?? null, input.type, input.filename, JSON.stringify(summary), input.user.id]
  );
  await writeAudit(input.client, input.user, "structured_data.import", "import_run", run.rows[0]!.id, null, { type: input.type, filename: input.filename, summary }, input.correlationId, input.sourceIp);
  return { importRunId: run.rows[0]!.id, type: input.type, filename: input.filename, summary };
}
