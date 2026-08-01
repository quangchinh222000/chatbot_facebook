import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "./auth.js";
import { pool, query, withTransaction } from "./db.js";
import { createHttpError, sendData } from "./http.js";
import { writeAudit } from "./platform.js";
import { CsvValidationError, importStructuredCsv, type StructuredImportType } from "./structured-data.js";
import { genericRecordKey, importGenericTableCsv, tableDefinitionSchema, validateRecordData } from "./structured-tables.js";

const tableCreateSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9-]*$/).min(2).max(80),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(80).default("table"),
  definition: tableDefinitionSchema
});

const viewConfigSchema = z.object({
  filters: z.array(z.object({
    column: z.string().max(80),
    operator: z.enum(["contains", "equals", "not_equals", "empty", "not_empty"]),
    value: z.string().max(500).default("")
  })).max(20).default([]),
  sorts: z.array(z.object({ column: z.string().max(80), direction: z.enum(["asc", "desc"]) })).max(10).default([]),
  hiddenColumns: z.array(z.string().max(80)).max(100).default([])
});

function recordBaseSql(adapter: string) {
  if (adapter === "course_catalog") return `
    SELECT c.id,c.version,c.status,c.updated_at,
      (to_jsonb(c)-'id'-'organization_id'-'version'-'created_at'-'updated_at') ||
      COALESCE(to_jsonb(f)-'course_id'-'organization_id','{}'::jsonb) ||
      jsonb_build_object('aliases',COALESCE((SELECT jsonb_agg(a.alias ORDER BY a.alias) FROM catalog.course_aliases a WHERE a.course_id=c.id),'[]'::jsonb)) AS data
    FROM catalog.courses c LEFT JOIN catalog.course_facts f ON f.course_id=c.id
    WHERE c.organization_id=$1 AND c.status<>'archived' AND $2::uuid IS NOT NULL`;
  if (adapter === "pricing_rules") return `
    SELECT p.id,p.version,p.status,p.updated_at,
      (to_jsonb(p)-'id'-'organization_id'-'version'-'created_at'-'updated_at') || jsonb_build_object('course_name',c.name) AS data
    FROM pricing.rules p JOIN catalog.courses c ON c.id=p.course_id
    WHERE p.organization_id=$1 AND p.status<>'archived' AND $2::uuid IS NOT NULL`;
  return `SELECT id,record_key,data,status,version,source_metadata,updated_at
    FROM structured.records WHERE organization_id=$1 AND table_id=$2 AND status='active'`;
}

function csvCell(value: unknown) {
  const text = Array.isArray(value) ? value.join("; ") : value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function getStructuredTable(organizationId: string, identifier: string, forUpdate = false) {
  const result = await query<any>(
    `SELECT * FROM structured.tables
     WHERE organization_id=$1 AND (id::text=$2 OR code=$2) ${forUpdate ? "FOR UPDATE" : ""}`,
    [organizationId, identifier]
  );
  return result.rows[0] ?? null;
}

const coursePatchSchema = z.object({
  code: z.string().min(2).max(40).optional(),
  name: z.string().min(2).max(200).optional(),
  category: z.string().max(100).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  status: z.enum(["draft", "active", "inactive", "archived"]).optional(),
  aliases: z.array(z.string().min(1).max(200)).optional(),
  courseType: z.string().max(200).nullable().optional(),
  comboName: z.string().max(300).nullable().optional(),
  learningModes: z.array(z.string().max(100)).optional(),
  offlineRegions: z.array(z.string().max(200)).optional(),
  nextStartDate: z.string().date().nullable().optional(),
  scheduleDetail: z.string().max(20_000).nullable().optional(),
  earlyBirdSlots: z.string().max(1000).nullable().optional(),
  courseUrl: z.string().max(2000).nullable().optional(),
  audienceProfile: z.string().max(30_000).nullable().optional(),
  experienceSharing: z.string().max(30_000).nullable().optional(),
  certificateCondition: z.string().max(10_000).nullable().optional(),
  curriculumText: z.string().max(100_000).nullable().optional(),
  curriculumImage: z.string().max(5000).nullable().optional(),
  assignmentInfo: z.string().max(30_000).nullable().optional(),
  installmentInfo: z.string().max(30_000).nullable().optional(),
  retakePolicy: z.string().max(30_000).nullable().optional(),
  trainerInfo: z.string().max(30_000).nullable().optional(),
  hasRecord: z.string().max(2000).nullable().optional()
});

const pricingPatchSchema = z.object({
  courseId: z.uuid().optional(),
  audienceSegment: z.string().min(1).max(500).optional(),
  deliveryMode: z.enum(["online", "offline", "hybrid"]).nullable().optional(),
  standardPrice: z.number().nonnegative().optional(),
  earlyBirdPrice: z.number().nonnegative().nullable().optional(),
  groupPrice: z.number().nonnegative().nullable().optional(),
  alumniPrice: z.number().nonnegative().nullable().optional(),
  installmentInfo: z.string().max(30_000).nullable().optional(),
  note: z.string().max(30_000).nullable().optional(),
  offlineRegions: z.array(z.string().max(200)).optional(),
  courseType: z.string().max(200).nullable().optional(),
  comboName: z.string().max(300).nullable().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  effectiveFrom: z.iso.datetime().optional(),
  effectiveTo: z.iso.datetime().nullable().optional(),
  status: z.enum(["draft", "review", "approved", "published", "archived"]).optional()
});

export async function registerStructuredRoutes(app: FastifyInstance) {
  app.get("/api/v1/structured/tables", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const includeArchived = (request.query as { includeArchived?: string }).includeArchived === "true";
    const result = await query(
      `SELECT t.*,
        CASE t.adapter
          WHEN 'course_catalog' THEN (SELECT count(*)::int FROM catalog.courses c WHERE c.organization_id=t.organization_id AND c.status<>'archived')
          WHEN 'pricing_rules' THEN (SELECT count(*)::int FROM pricing.rules p WHERE p.organization_id=t.organization_id AND p.status<>'archived')
          ELSE (SELECT count(*)::int FROM structured.records r WHERE r.table_id=t.id AND r.status='active')
        END AS record_count,
        (SELECT count(*)::int FROM platform.import_runs ir WHERE ir.table_id=t.id AND ir.status='completed') AS import_count,
        (SELECT max(ir.created_at) FROM platform.import_runs ir WHERE ir.table_id=t.id) AS last_import_at
       FROM structured.tables t
       WHERE t.organization_id=$1 AND ($2::boolean OR t.status<>'archived')
       ORDER BY CASE t.adapter WHEN 'course_catalog' THEN 0 WHEN 'pricing_rules' THEN 1 ELSE 2 END, t.name`,
      [user.organizationId, includeArchived]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/structured/tables", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const body = tableCreateSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const saved = await client.query<any>(
        `INSERT INTO structured.tables(organization_id,code,name,description,icon,adapter,schema_definition,import_config,status,created_by)
         VALUES ($1,$2,$3,$4,$5,'generic_json',$6,$7,'active',$8)
         ON CONFLICT(organization_id,code) DO NOTHING RETURNING *`,
        [user.organizationId, body.code, body.name, body.description ?? null, body.icon, JSON.stringify(body.definition), JSON.stringify({ format: "csv", primaryKey: body.definition.primaryKey }), user.id]
      );
      if (!saved.rows[0]) throw createHttpError(409, "STRUCTURED_TABLE_CODE_EXISTS", "A structured table already uses this stable code.");
      await client.query(
        `INSERT INTO structured.views(organization_id,table_id,name,is_default,config,created_by)
         VALUES ($1,$2,'All records',true,'{"filters":[],"sorts":[],"hiddenColumns":[]}'::jsonb,$3)`,
        [user.organizationId, saved.rows[0]!.id, user.id]
      );
      await writeAudit(client, user, "structured_table.create", "structured_table", saved.rows[0]!.id, null, saved.rows[0], request.correlationId, request.ip);
      return saved.rows[0];
    });
    return sendData(request, reply, result, 201);
  });

  app.get("/api/v1/structured/tables/:identifier", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const { identifier } = request.params as { identifier: string };
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    const imports = await query(
      `SELECT id,filename,status,summary,errors,created_at FROM platform.import_runs
       WHERE table_id=$1 ORDER BY created_at DESC LIMIT 20`, [table.id]
    );
    return sendData(request, reply, { ...table, import_runs: imports.rows });
  });

  app.get("/api/v1/structured/tables/:identifier/views", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const { identifier } = request.params as { identifier: string };
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    const result = await query(
      "SELECT * FROM structured.views WHERE table_id=$1 AND status='active' ORDER BY is_default DESC,created_at,name", [table.id]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/structured/tables/:identifier/views", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier } = request.params as { identifier: string };
    const body = z.object({ name: z.string().min(1).max(120), config: viewConfigSchema.default({ filters: [], sorts: [], hiddenColumns: [] }) }).parse(request.body);
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    const result = await query<any>(
      `INSERT INTO structured.views(organization_id,table_id,name,config,created_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(table_id,name) DO NOTHING RETURNING *`, [user.organizationId, table.id, body.name, JSON.stringify(body.config), user.id]
    );
    if (!result.rows[0]) throw createHttpError(409, "STRUCTURED_VIEW_NAME_EXISTS", "This table already has a view with that name.");
    await writeAudit(pool, user, "structured_view.create", "structured_view", result.rows[0].id, null, result.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, result.rows[0], 201);
  });

  app.patch("/api/v1/structured/tables/:identifier/views/:viewId", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier, viewId } = request.params as { identifier: string; viewId: string };
    const body = z.object({ name: z.string().min(1).max(120).optional(), config: viewConfigSchema.optional() }).parse(request.body);
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    const before = await query<any>("SELECT * FROM structured.views WHERE id=$1 AND table_id=$2 AND status='active'", [viewId, table.id]);
    if (!before.rows[0]) throw createHttpError(404, "STRUCTURED_VIEW_NOT_FOUND", "Structured view not found.");
    const updated = await query<any>(
      "UPDATE structured.views SET name=$3,config=$4,updated_at=now() WHERE id=$1 AND table_id=$2 RETURNING *",
      [viewId, table.id, body.name ?? before.rows[0].name, body.config ? JSON.stringify(body.config) : before.rows[0].config]
    );
    await writeAudit(pool, user, "structured_view.update", "structured_view", viewId, before.rows[0], updated.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, updated.rows[0]);
  });

  app.delete("/api/v1/structured/tables/:identifier/views/:viewId", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier, viewId } = request.params as { identifier: string; viewId: string };
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    const current = await query<any>("SELECT * FROM structured.views WHERE id=$1 AND table_id=$2 AND status='active'", [viewId, table.id]);
    if (!current.rows[0]) throw createHttpError(404, "STRUCTURED_VIEW_NOT_FOUND", "Structured view not found.");
    if (current.rows[0].is_default) throw createHttpError(409, "DEFAULT_VIEW_LOCKED", "The default view cannot be archived.");
    const updated = await query<any>("UPDATE structured.views SET status='archived',updated_at=now() WHERE id=$1 RETURNING *", [viewId]);
    await writeAudit(pool, user, "structured_view.archive", "structured_view", viewId, current.rows[0], updated.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, updated.rows[0]);
  });

  app.patch("/api/v1/structured/tables/:identifier", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier } = request.params as { identifier: string };
    const body = z.object({
      name: z.string().min(2).max(200).optional(),
      description: z.string().max(2000).nullable().optional(),
      icon: z.string().max(80).optional(),
      definition: tableDefinitionSchema.optional(),
      status: z.enum(["draft", "active", "archived"]).optional()
    }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const selected = await client.query<any>(
        "SELECT * FROM structured.tables WHERE organization_id=$1 AND (id::text=$2 OR code=$2) FOR UPDATE",
        [user.organizationId, identifier]
      );
      const before = selected.rows[0];
      if (!before) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
      if (body.definition && before.adapter !== "generic_json") throw createHttpError(409, "BUILT_IN_SCHEMA_LOCKED", "Built-in table schemas are managed by their domain adapter.");
      if (body.definition) {
        const existing = await client.query<{ id: string; data: Record<string, unknown> }>("SELECT id,data FROM structured.records WHERE table_id=$1 AND status='active'", [before.id]);
        const invalid = existing.rows.map((record) => ({ id: record.id, errors: validateRecordData(body.definition, record.data).errors })).filter((record) => record.errors.length);
        if (invalid.length) throw createHttpError(409, "SCHEMA_BREAKS_EXISTING_RECORDS", "The schema change would invalidate existing records.", invalid.slice(0, 50));
      }
      const updated = await client.query<any>(
        `UPDATE structured.tables SET name=$2,description=$3,icon=$4,schema_definition=$5,status=$6,version=version+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [before.id, body.name ?? before.name, body.description === undefined ? before.description : body.description,
          body.icon ?? before.icon, body.definition ? JSON.stringify(body.definition) : before.schema_definition, body.status ?? before.status]
      );
      await writeAudit(client, user, "structured_table.update", "structured_table", before.id, before, updated.rows[0], request.correlationId, request.ip);
      return updated.rows[0];
    });
    return sendData(request, reply, result);
  });

  app.delete("/api/v1/structured/tables/:identifier", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier } = request.params as { identifier: string };
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    if (table.adapter !== "generic_json") throw createHttpError(409, "BUILT_IN_TABLE_LOCKED", "Built-in tables cannot be archived.");
    const updated = await query("UPDATE structured.tables SET status='archived',version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [table.id]);
    await writeAudit(pool, user, "structured_table.archive", "structured_table", table.id, table, updated.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, updated.rows[0]);
  });

  app.get("/api/v1/structured/tables/:identifier/records", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const { identifier } = request.params as { identifier: string };
    const values = z.object({
      q: z.string().max(200).default(""),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
      filterColumn: z.string().max(80).default(""),
      filterOperator: z.enum(["contains", "equals", "not_equals", "empty", "not_empty"]).default("contains"),
      filterValue: z.string().max(500).default(""),
      sortColumn: z.string().max(80).default(""),
      sortDirection: z.enum(["asc", "desc"]).default("asc")
    }).parse(request.query);
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    const definition = tableDefinitionSchema.parse(table.schema_definition);
    const columnKeys = new Set(definition.columns.map((column) => column.key));
    if (values.filterColumn && !columnKeys.has(values.filterColumn)) throw createHttpError(400, "INVALID_FILTER_COLUMN", "The selected filter column does not belong to this table.");
    if (values.sortColumn && !columnKeys.has(values.sortColumn)) throw createHttpError(400, "INVALID_SORT_COLUMN", "The selected sort column does not belong to this table.");
    const offset = (values.page - 1) * values.pageSize;
    const base = recordBaseSql(table.adapter);
    const params = [user.organizationId, table.id, values.q, values.filterColumn, values.filterOperator, values.filterValue, values.sortColumn, values.pageSize, offset, values.sortDirection];
    const where = `
      ($3='' OR data::text ILIKE '%'||$3||'%') AND
      ($4='' OR
        ($5='contains' AND COALESCE(data->>$4,'') ILIKE '%'||$6||'%') OR
        ($5='equals' AND COALESCE(data->>$4,'')=$6) OR
        ($5='not_equals' AND COALESCE(data->>$4,'')<>$6) OR
        ($5='empty' AND COALESCE(data->>$4,'')='') OR
        ($5='not_empty' AND COALESCE(data->>$4,'')<>''))`;
    const [rows, count] = await Promise.all([
      query<any>(
        `WITH records_base AS (${base}) SELECT * FROM records_base WHERE ${where}
         ORDER BY
           CASE WHEN $7<>'' AND $10='asc' THEN lower(COALESCE(data->>$7,'')) END ASC,
           CASE WHEN $7<>'' AND $10='desc' THEN lower(COALESCE(data->>$7,'')) END DESC,
           updated_at DESC LIMIT $8 OFFSET $9`, params),
      query<{ count: number }>(`WITH records_base AS (${base}) SELECT count(*)::int AS count FROM records_base WHERE ${where}`, params.slice(0, 6))
    ]);
    const records = rows.rows;
    const total = count.rows[0]?.count ?? 0;
    return sendData(request, reply, { table, records, total, page: values.page, pageSize: values.pageSize, pages: Math.max(1, Math.ceil(total / values.pageSize)) });
  });

  app.get("/api/v1/structured/tables/:identifier/export.csv", async (request, reply) => {
    const user = requirePermission(request, "knowledge.read");
    const { identifier } = request.params as { identifier: string };
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    const definition = tableDefinitionSchema.parse(table.schema_definition);
    const result = await query<any>(
      `WITH records_base AS (${recordBaseSql(table.adapter)}) SELECT data FROM records_base ORDER BY updated_at DESC LIMIT 50000`,
      [user.organizationId, table.id]
    );
    const keys = definition.columns.map((column) => column.key);
    const csv = [keys.map(csvCell).join(","), ...result.rows.map((row) => keys.map((key) => csvCell(row.data?.[key])).join(","))].join("\r\n");
    return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="${table.code}.csv"`).send(`\uFEFF${csv}`);
  });

  app.post("/api/v1/structured/tables/:identifier/records/bulk-archive", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier } = request.params as { identifier: string };
    const body = z.object({ recordIds: z.array(z.uuid()).min(1).max(500) }).parse(request.body);
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    if (table.adapter !== "generic_json") throw createHttpError(409, "DOMAIN_ADAPTER_REQUIRED", "Bulk archive is only available for generic tables. Use the domain editor for built-in records.");
    const result = await query<any>(
      `UPDATE structured.records SET status='archived',version=version+1,updated_at=now()
       WHERE table_id=$1 AND id=ANY($2::uuid[]) AND status='active' RETURNING id`, [table.id, body.recordIds]
    );
    await writeAudit(pool, user, "structured_record.bulk_archive", "structured_table", table.id, null, { recordIds: result.rows.map((row) => row.id) }, request.correlationId, request.ip);
    return sendData(request, reply, { archived: result.rowCount, recordIds: result.rows.map((row) => row.id) });
  });

  app.post("/api/v1/structured/tables/:identifier/records", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier } = request.params as { identifier: string };
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    if (table.adapter !== "generic_json") throw createHttpError(409, "DOMAIN_ADAPTER_REQUIRED", "Use the built-in domain editor for this table.");
    const checked = validateRecordData(table.schema_definition, request.body);
    if (checked.errors.length) throw createHttpError(400, "RECORD_VALIDATION_ERROR", "Record validation failed.", checked.errors);
    const recordKey = genericRecordKey(table.schema_definition, checked.data);
    const result = await query<any>(
      `INSERT INTO structured.records(organization_id,table_id,record_key,data,created_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT(table_id,record_key) DO NOTHING RETURNING *`, [user.organizationId, table.id, recordKey, JSON.stringify(checked.data), user.id]
    );
    if (!result.rows[0]) throw createHttpError(409, "STRUCTURED_RECORD_KEY_EXISTS", "A record already uses this primary key value.");
    await writeAudit(pool, user, "structured_record.create", "structured_record", result.rows[0]!.id, null, result.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, result.rows[0], 201);
  });

  app.patch("/api/v1/structured/tables/:identifier/records/:recordId", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier, recordId } = request.params as { identifier: string; recordId: string };
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    if (table.adapter !== "generic_json") throw createHttpError(409, "DOMAIN_ADAPTER_REQUIRED", "Use the built-in domain editor for this table.");
    const before = await query<any>("SELECT * FROM structured.records WHERE id=$1 AND table_id=$2", [recordId, table.id]);
    if (!before.rows[0]) throw createHttpError(404, "STRUCTURED_RECORD_NOT_FOUND", "Structured record not found.");
    const checked = validateRecordData(table.schema_definition, request.body);
    if (checked.errors.length) throw createHttpError(400, "RECORD_VALIDATION_ERROR", "Record validation failed.", checked.errors);
    const recordKey = genericRecordKey(table.schema_definition, checked.data);
    const duplicate = await query("SELECT 1 FROM structured.records WHERE table_id=$1 AND record_key=$2 AND id<>$3 AND status='active'", [table.id, recordKey, recordId]);
    if (duplicate.rowCount) throw createHttpError(409, "STRUCTURED_RECORD_KEY_EXISTS", "Another record already uses this primary key value.");
    const updated = await query<any>("UPDATE structured.records SET record_key=$2,data=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [recordId, recordKey, JSON.stringify(checked.data)]);
    await writeAudit(pool, user, "structured_record.update", "structured_record", recordId, before.rows[0], updated.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, updated.rows[0]);
  });

  app.delete("/api/v1/structured/tables/:identifier/records/:recordId", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier, recordId } = request.params as { identifier: string; recordId: string };
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    if (table.adapter !== "generic_json") throw createHttpError(409, "DOMAIN_ADAPTER_REQUIRED", "Use the built-in domain editor for this table.");
    const updated = await query<any>("UPDATE structured.records SET status='archived',version=version+1,updated_at=now() WHERE id=$1 AND table_id=$2 RETURNING *", [recordId, table.id]);
    if (!updated.rows[0]) throw createHttpError(404, "STRUCTURED_RECORD_NOT_FOUND", "Structured record not found.");
    await writeAudit(pool, user, "structured_record.archive", "structured_record", recordId, null, updated.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, updated.rows[0]);
  });

  app.post("/api/v1/structured/tables/:identifier/import", async (request, reply) => {
    const user = requirePermission(request, "knowledge.write");
    const { identifier } = request.params as { identifier: string };
    const table = await getStructuredTable(user.organizationId, identifier);
    if (!table) throw createHttpError(404, "STRUCTURED_TABLE_NOT_FOUND", "Structured table not found.");
    const file = await request.file();
    if (!file || !file.filename.toLowerCase().endsWith(".csv")) throw createHttpError(400, "CSV_FILE_REQUIRED", "Select a .csv file to import.");
    const buffer = await file.toBuffer();
    try {
      const result: unknown = table.adapter === "course_catalog" || table.adapter === "pricing_rules"
        ? await withTransaction((client) => importStructuredCsv({ client, organizationId: user.organizationId, user, type: table.adapter === "course_catalog" ? "courses" : "pricing", tableId: table.id, filename: file.filename, buffer, correlationId: request.correlationId, sourceIp: request.ip }))
        : await withTransaction((client) => importGenericTableCsv({ client, organizationId: user.organizationId, table, user, filename: file.filename, buffer, correlationId: request.correlationId, sourceIp: request.ip }));
      return sendData(request, reply, result, 201);
    } catch (reason) {
      const details = reason instanceof CsvValidationError ? reason.details : [reason instanceof Error ? reason.message : String(reason)];
      await query(`INSERT INTO platform.import_runs(organization_id,table_id,import_type,filename,status,errors,created_by) VALUES ($1,$2,$3,$4,'failed',$5,$6)`, [user.organizationId, table.id, `table:${table.code}`, file.filename, JSON.stringify(details), user.id]);
      throw reason;
    }
  });

  app.get("/api/v1/structured-data/import-runs", async (request, reply) => {
    const user = requirePermission(request);
    const result = await query(
      `SELECT id,import_type,filename,status,summary,errors,created_at
       FROM platform.import_runs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [user.organizationId]
    );
    return sendData(request, reply, result.rows);
  });

  app.post("/api/v1/structured-data/import", async (request, reply) => {
    const user = requirePermission(request, "course.publish");
    const type = z.enum(["courses", "pricing"]).parse((request.query as { type?: string }).type) as StructuredImportType;
    const table = await getStructuredTable(user.organizationId, type === "courses" ? "course-catalog" : "pricing-rules");
    const file = await request.file();
    if (!file) throw createHttpError(400, "CSV_FILE_REQUIRED", "Select a CSV file to import.");
    if (!file.filename.toLowerCase().endsWith(".csv")) throw createHttpError(400, "CSV_FILE_REQUIRED", "Only .csv files are accepted.");
    const buffer = await file.toBuffer();
    try {
      const result = await withTransaction((client) => importStructuredCsv({
        client,
        organizationId: user.organizationId,
        user,
        type,
        tableId: table?.id,
        filename: file.filename,
        buffer,
        correlationId: request.correlationId,
        sourceIp: request.ip
      }));
      return sendData(request, reply, result, 201);
    } catch (reason) {
      const details = reason instanceof CsvValidationError ? reason.details : [reason instanceof Error ? reason.message : String(reason)];
      await query(
        `INSERT INTO platform.import_runs(organization_id,table_id,import_type,filename,status,errors,created_by)
         VALUES ($1,$2,$3,$4,'failed',$5,$6)`,
        [user.organizationId, table?.id ?? null, type, file.filename, JSON.stringify(details), user.id]
      );
      throw reason;
    }
  });

  app.patch("/api/v1/courses/:id", async (request, reply) => {
    const user = requirePermission(request, "course.publish");
    const { id } = request.params as { id: string };
    const body = coursePatchSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const current = await client.query<any>(
        `SELECT c.*,to_jsonb(f) AS facts,
                COALESCE((SELECT jsonb_agg(a.alias ORDER BY a.alias) FROM catalog.course_aliases a WHERE a.course_id=c.id),'[]') AS aliases
         FROM catalog.courses c LEFT JOIN catalog.course_facts f ON f.course_id=c.id
         WHERE c.id=$1 AND c.organization_id=$2 FOR UPDATE OF c`,
        [id, user.organizationId]
      );
      const before = current.rows[0];
      if (!before) throw createHttpError(404, "COURSE_NOT_FOUND", "Course not found.");
      const updated = await client.query<any>(
        `UPDATE catalog.courses SET
           code=$2,name=$3,category=$4,description=$5,status=$6,version=version+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, body.code ?? before.code, body.name ?? before.name, body.category === undefined ? before.category : body.category,
          body.description === undefined ? before.description : body.description, body.status ?? before.status]
      );
      if (body.aliases) {
        await client.query("DELETE FROM catalog.course_aliases WHERE course_id=$1", [id]);
        for (const alias of [body.name ?? before.name, ...body.aliases]) {
          await client.query("INSERT INTO catalog.course_aliases(course_id,alias) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, alias]);
        }
      }
      const facts = before.facts ?? {};
      const factValues = {
        sourceName: facts.source_name ?? before.name,
        courseType: body.courseType === undefined ? facts.course_type : body.courseType,
        comboName: body.comboName === undefined ? facts.combo_name : body.comboName,
        learningModes: body.learningModes ?? facts.learning_modes ?? [],
        offlineRegions: body.offlineRegions ?? facts.offline_regions ?? [],
        nextStartDate: body.nextStartDate === undefined ? facts.next_start_date : body.nextStartDate,
        scheduleDetail: body.scheduleDetail === undefined ? facts.schedule_detail : body.scheduleDetail,
        earlyBirdSlots: body.earlyBirdSlots === undefined ? facts.early_bird_slots : body.earlyBirdSlots,
        courseUrl: body.courseUrl === undefined ? facts.course_url : body.courseUrl,
        audienceProfile: body.audienceProfile === undefined ? facts.audience_profile : body.audienceProfile,
        experienceSharing: body.experienceSharing === undefined ? facts.experience_sharing : body.experienceSharing,
        certificateCondition: body.certificateCondition === undefined ? facts.certificate_condition : body.certificateCondition,
        curriculumText: body.curriculumText === undefined ? facts.curriculum_text : body.curriculumText,
        curriculumImage: body.curriculumImage === undefined ? facts.curriculum_image : body.curriculumImage,
        assignmentInfo: body.assignmentInfo === undefined ? facts.assignment_info : body.assignmentInfo,
        installmentInfo: body.installmentInfo === undefined ? facts.installment_info : body.installmentInfo,
        retakePolicy: body.retakePolicy === undefined ? facts.retake_policy : body.retakePolicy,
        trainerInfo: body.trainerInfo === undefined ? facts.trainer_info : body.trainerInfo,
        hasRecord: body.hasRecord === undefined ? facts.has_record : body.hasRecord
      };
      await client.query(
        `INSERT INTO catalog.course_facts(
           course_id,organization_id,source_name,course_type,combo_name,learning_modes,offline_regions,next_start_date,
           schedule_detail,early_bird_slots,course_url,audience_profile,experience_sharing,certificate_condition,
           curriculum_text,curriculum_image,assignment_info,installment_info,retake_policy,trainer_info,has_record
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT(course_id) DO UPDATE SET
           source_name=EXCLUDED.source_name,course_type=EXCLUDED.course_type,combo_name=EXCLUDED.combo_name,
           learning_modes=EXCLUDED.learning_modes,offline_regions=EXCLUDED.offline_regions,next_start_date=EXCLUDED.next_start_date,
           schedule_detail=EXCLUDED.schedule_detail,early_bird_slots=EXCLUDED.early_bird_slots,course_url=EXCLUDED.course_url,
           audience_profile=EXCLUDED.audience_profile,experience_sharing=EXCLUDED.experience_sharing,
           certificate_condition=EXCLUDED.certificate_condition,curriculum_text=EXCLUDED.curriculum_text,
           curriculum_image=EXCLUDED.curriculum_image,assignment_info=EXCLUDED.assignment_info,
           installment_info=EXCLUDED.installment_info,retake_policy=EXCLUDED.retake_policy,
           trainer_info=EXCLUDED.trainer_info,has_record=EXCLUDED.has_record`,
        [id, user.organizationId, factValues.sourceName, factValues.courseType, factValues.comboName, factValues.learningModes,
          factValues.offlineRegions, factValues.nextStartDate, factValues.scheduleDetail, factValues.earlyBirdSlots,
          factValues.courseUrl, factValues.audienceProfile, factValues.experienceSharing, factValues.certificateCondition,
          factValues.curriculumText, factValues.curriculumImage, factValues.assignmentInfo, factValues.installmentInfo,
          factValues.retakePolicy, factValues.trainerInfo, factValues.hasRecord]
      );
      await writeAudit(client, user, "course.update", "course", id, before, { ...updated.rows[0], ...factValues }, request.correlationId, request.ip);
      return updated.rows[0];
    });
    return sendData(request, reply, result);
  });

  app.delete("/api/v1/courses/:id", async (request, reply) => {
    const user = requirePermission(request, "course.publish");
    const { id } = request.params as { id: string };
    const result = await withTransaction(async (client) => {
      const before = await client.query<any>("SELECT * FROM catalog.courses WHERE id=$1 AND organization_id=$2 FOR UPDATE", [id, user.organizationId]);
      if (!before.rows[0]) throw createHttpError(404, "COURSE_NOT_FOUND", "Course not found.");
      await client.query("UPDATE catalog.courses SET status='archived',version=version+1,updated_at=now() WHERE id=$1", [id]);
      await client.query("UPDATE catalog.offerings SET status='archived',updated_at=now() WHERE course_id=$1", [id]);
      await client.query("UPDATE pricing.rules SET status='archived',version=version+1,updated_at=now() WHERE course_id=$1", [id]);
      await writeAudit(client, user, "course.archive", "course", id, before.rows[0], { status: "archived" }, request.correlationId, request.ip);
      return { id, status: "archived" };
    });
    return sendData(request, reply, result);
  });

  app.patch("/api/v1/pricing-rules/:id", async (request, reply) => {
    const user = requirePermission(request, "pricing.publish");
    const { id } = request.params as { id: string };
    const body = pricingPatchSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const selected = await client.query<any>("SELECT * FROM pricing.rules WHERE id=$1 AND organization_id=$2 FOR UPDATE", [id, user.organizationId]);
      const before = selected.rows[0];
      if (!before) throw createHttpError(404, "PRICING_RULE_NOT_FOUND", "Pricing rule not found.");
      const candidate = {
        courseId: body.courseId ?? before.course_id,
        audienceSegment: body.audienceSegment ?? before.audience_segment,
        deliveryMode: body.deliveryMode === undefined ? before.delivery_mode : body.deliveryMode,
        priority: body.priority ?? before.priority,
        effectiveFrom: body.effectiveFrom ?? before.effective_from,
        effectiveTo: body.effectiveTo === undefined ? before.effective_to : body.effectiveTo,
        status: body.status ?? before.status
      };
      if (candidate.status === "published") {
        const conflict = await client.query<{ id: string }>(
          `SELECT id FROM pricing.rules WHERE id<>$1 AND organization_id=$2 AND course_id=$3
             AND audience_segment=$4 AND COALESCE(delivery_mode,'')=COALESCE($5,'') AND status='published'
             AND tstzrange(effective_from,COALESCE(effective_to,'infinity'))
                 && tstzrange($6::timestamptz,COALESCE($7::timestamptz,'infinity'))
             AND priority=$8 LIMIT 1`,
          [id, user.organizationId, candidate.courseId, candidate.audienceSegment, candidate.deliveryMode,
            candidate.effectiveFrom, candidate.effectiveTo, candidate.priority]
        );
        if (conflict.rows[0]) throw createHttpError(409, "PRICING_CONFLICT", "A published pricing rule already has the same scope, effective period, and priority.", { conflictId: conflict.rows[0].id });
      }
      const updated = await client.query<any>(
        `UPDATE pricing.rules SET
           course_id=$2,audience_segment=$3,delivery_mode=$4,standard_price=$5,early_bird_price=$6,
           group_price=$7,alumni_price=$8,installment_info=$9,note=$10,offline_regions=$11,
           course_type=$12,combo_name=$13,priority=$14,effective_from=$15,effective_to=$16,status=$17,
           version=version+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, candidate.courseId, candidate.audienceSegment,
          candidate.deliveryMode, body.standardPrice ?? Number(before.standard_price),
          body.earlyBirdPrice === undefined ? before.early_bird_price : body.earlyBirdPrice,
          body.groupPrice === undefined ? before.group_price : body.groupPrice,
          body.alumniPrice === undefined ? before.alumni_price : body.alumniPrice,
          body.installmentInfo === undefined ? before.installment_info : body.installmentInfo,
          body.note === undefined ? before.note : body.note, body.offlineRegions ?? before.offline_regions,
          body.courseType === undefined ? before.course_type : body.courseType,
          body.comboName === undefined ? before.combo_name : body.comboName, candidate.priority,
          candidate.effectiveFrom, candidate.effectiveTo, candidate.status]
      );
      await writeAudit(client, user, "pricing_rule.update", "pricing_rule", id, before, updated.rows[0], request.correlationId, request.ip);
      return updated.rows[0];
    });
    return sendData(request, reply, result);
  });

  app.delete("/api/v1/pricing-rules/:id", async (request, reply) => {
    const user = requirePermission(request, "pricing.publish");
    const { id } = request.params as { id: string };
    const before = await query<any>("SELECT * FROM pricing.rules WHERE id=$1 AND organization_id=$2", [id, user.organizationId]);
    if (!before.rows[0]) throw createHttpError(404, "PRICING_RULE_NOT_FOUND", "Pricing rule not found.");
    const updated = await query("UPDATE pricing.rules SET status='archived',version=version+1,updated_at=now() WHERE id=$1 RETURNING id,status", [id]);
    await writeAudit(pool, user, "pricing_rule.archive", "pricing_rule", id, before.rows[0], updated.rows[0], request.correlationId, request.ip);
    return sendData(request, reply, updated.rows[0]);
  });
}
