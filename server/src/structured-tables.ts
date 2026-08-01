import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { SessionUser } from "./types.js";
import { CsvValidationError } from "./structured-data.js";
import { writeAudit } from "./platform.js";

export const columnSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
  label: z.string().min(1).max(120),
  type: z.enum(["text", "long_text", "number", "currency", "boolean", "date", "list", "status"]),
  required: z.boolean().default(false),
  options: z.array(z.string().max(120)).max(100).optional()
});

export const tableDefinitionSchema = z.object({
  primaryKey: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80),
  columns: z.array(columnSchema).min(1).max(100)
}).superRefine((definition, context) => {
  const keys = definition.columns.map((column) => column.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Column keys must be unique." });
  if (!keys.includes(definition.primaryKey)) context.addIssue({ code: "custom", message: "The primary key must reference a defined column." });
});

export type TableDefinition = z.infer<typeof tableDefinitionSchema>;

type CsvRow = Record<string, string>;

function stableKey(value: unknown) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 48);
}

function parseCsv(buffer: Buffer) {
  try {
    return parse(buffer, { bom: true, columns: true, skip_empty_lines: true, relax_column_count: false, trim: true }) as CsvRow[];
  } catch (reason) {
    throw new CsvValidationError("The CSV file could not be parsed.", [reason instanceof Error ? reason.message : String(reason)]);
  }
}

function coerceValue(raw: unknown, type: TableDefinition["columns"][number]["type"]) {
  if (raw == null || String(raw).trim() === "") return null;
  const value = String(raw).trim();
  if (type === "number" || type === "currency") {
    const numeric = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(numeric) ? numeric : Number.NaN;
  }
  if (type === "boolean") {
    const lowered = value.toLowerCase();
    if (["true", "1", "yes", "y"].includes(lowered)) return true;
    if (["false", "0", "no", "n"].includes(lowered)) return false;
    return value;
  }
  if (type === "list") return value.split(/[;,\r\n]+/).map((item) => item.trim()).filter(Boolean);
  return value;
}

export function validateRecordData(definitionInput: unknown, input: unknown) {
  const definition = tableDefinitionSchema.parse(definitionInput);
  const source = z.record(z.string(), z.unknown()).parse(input);
  const data: Record<string, unknown> = {};
  const errors: Array<{ field: string; message: string }> = [];
  for (const column of definition.columns) {
    const value = coerceValue(source[column.key], column.type);
    if (column.required && (value == null || value === "" || (Array.isArray(value) && !value.length))) {
      errors.push({ field: column.key, message: `${column.label} is required.` });
    }
    if ((column.type === "number" || column.type === "currency") && typeof value === "number" && !Number.isFinite(value)) {
      errors.push({ field: column.key, message: `${column.label} must be a number.` });
    }
    if (column.type === "boolean" && value != null && typeof value !== "boolean") {
      errors.push({ field: column.key, message: `${column.label} must be true or false.` });
    }
    if (column.type === "date" && value != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      errors.push({ field: column.key, message: `${column.label} must use YYYY-MM-DD.` });
    }
    if (column.options?.length && value != null && !column.options.includes(String(value))) {
      errors.push({ field: column.key, message: `${column.label} must be one of: ${column.options.join(", ")}.` });
    }
    data[column.key] = value;
  }
  return { definition, data, errors };
}

export async function importGenericTableCsv(input: {
  client: PoolClient;
  organizationId: string;
  table: { id: string; code: string; schema_definition: unknown };
  user: SessionUser;
  filename: string;
  buffer: Buffer;
  correlationId: string;
  sourceIp?: string;
}) {
  const rows = parseCsv(input.buffer);
  if (!rows.length) throw new CsvValidationError("The CSV file contains no data rows.", []);
  const definition = tableDefinitionSchema.parse(input.table.schema_definition);
  const headers = Object.keys(rows[0]!);
  const requiredHeaders = definition.columns.filter((column) => column.required).map((column) => column.key);
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
  if (missingHeaders.length) throw new CsvValidationError("The CSV file is missing required columns.", { missingHeaders });

  const prepared: Array<{ recordKey: string; data: Record<string, unknown>; rowNumber: number }> = [];
  const validationErrors: Array<{ row: number; field: string; message: string }> = [];
  for (const [index, row] of rows.entries()) {
    const checked = validateRecordData(definition, row);
    validationErrors.push(...checked.errors.map((error) => ({ row: index + 2, ...error })));
    const primaryValue = checked.data[definition.primaryKey];
    if (primaryValue != null && String(primaryValue).trim()) {
      prepared.push({ recordKey: stableKey(primaryValue), data: checked.data, rowNumber: index + 2 });
    }
  }
  if (validationErrors.length) throw new CsvValidationError("Structured table import validation failed. No records were changed.", validationErrors);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const record of prepared) {
    if (seen.has(record.recordKey)) { skipped += 1; continue; }
    seen.add(record.recordKey);
    const saved = await input.client.query<{ inserted: boolean }>(
      `INSERT INTO structured.records(organization_id,table_id,record_key,data,source_metadata,created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(table_id,record_key) DO UPDATE SET
         data=EXCLUDED.data,status='active',validation_errors='[]',source_metadata=EXCLUDED.source_metadata,
         version=structured.records.version+1,updated_at=now()
       RETURNING (xmax = 0) AS inserted`,
      [input.organizationId, input.table.id, record.recordKey, JSON.stringify(record.data), JSON.stringify({ source: "csv", filename: input.filename, row: record.rowNumber }), input.user.id]
    );
    saved.rows[0]?.inserted ? inserted += 1 : updated += 1;
  }
  const summary = { rows: rows.length, inserted, updated, skipped, errors: 0 };
  const run = await input.client.query<{ id: string }>(
    `INSERT INTO platform.import_runs(organization_id,table_id,import_type,filename,status,summary,created_by)
     VALUES ($1,$2,$3,$4,'completed',$5,$6) RETURNING id`,
    [input.organizationId, input.table.id, `table:${input.table.code}`, input.filename, JSON.stringify(summary), input.user.id]
  );
  await writeAudit(input.client, input.user, "structured_table.import", "structured_table", input.table.id, null, { filename: input.filename, summary }, input.correlationId, input.sourceIp);
  return { importRunId: run.rows[0]!.id, tableId: input.table.id, filename: input.filename, summary };
}

export function genericRecordKey(definitionInput: unknown, data: Record<string, unknown>) {
  const definition = tableDefinitionSchema.parse(definitionInput);
  const value = data[definition.primaryKey];
  if (value == null || !String(value).trim()) throw new CsvValidationError("The primary key value is required.", [{ field: definition.primaryKey, message: "Primary key is required." }]);
  return stableKey(value);
}
