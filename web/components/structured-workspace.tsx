"use client";

import {
  AlertTriangle, ArrowDownAZ, ArrowLeft, ArrowUpAZ, Check, ChevronDown, ChevronLeft, ChevronRight,
  Columns3, Download, Filter, Grid3X3, History, ListFilter, LoaderCircle, Pencil, Plus, Save,
  Search, Settings2, Table2, Trash2, Upload, X
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, API_URL, ApiError, patch, post, remove } from "@/lib/api";

type Row = Record<string, any>;
type ColumnType = "text" | "long_text" | "number" | "currency" | "boolean" | "date" | "list" | "status";
type Column = { key: string; label: string; type: ColumnType; required?: boolean; options?: string[] };
type FilterState = { column: string; operator: "contains" | "equals" | "not_equals" | "empty" | "not_empty"; value: string };
type SortState = { column: string; direction: "asc" | "desc" };

const emptyFilter: FilterState = { column: "", operator: "contains", value: "" };
const emptySort: SortState = { column: "", direction: "asc" };

function cx(...classes: Array<string | false | null | undefined>) { return classes.filter(Boolean).join(" "); }
function money(value: unknown) { return value == null || value === "" ? "—" : `${new Intl.NumberFormat("en-US").format(Number(value))} VND`; }
function showValue(column: Column, value: unknown) {
  if (value == null || value === "") return <span className="grid-empty">—</span>;
  if (column.type === "boolean") return <span className={cx("grid-boolean", Boolean(value) && "true")}>{value ? <Check size={13} /> : null}{value ? "Yes" : "No"}</span>;
  if (column.type === "currency") return <span className="grid-money">{money(value)}</span>;
  if (column.type === "status") return <span className={`grid-status ${String(value).toLowerCase()}`}>{String(value).replaceAll("_", " ")}</span>;
  if (Array.isArray(value)) return <span className="grid-tags">{value.slice(0, 3).map((item) => <i key={item}>{item}</i>)}{value.length > 3 && <i>+{value.length - 3}</i>}</span>;
  return String(value);
}

function coerceEditorValue(column: Column, value: string | boolean) {
  if (column.type === "boolean") return Boolean(value);
  if (column.type === "number" || column.type === "currency") return value === "" ? null : Number(value);
  if (column.type === "list") return String(value).split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);
  return value === "" ? null : value;
}

async function uploadCsv(code: string, file: File) {
  const form = new FormData(); form.append("file", file);
  const response = await fetch(`${API_URL}/structured/tables/${encodeURIComponent(code)}/import`, { method: "POST", credentials: "include", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload?.error?.code ?? "IMPORT_FAILED", payload?.error?.message ?? "CSV import failed.", payload?.error?.details);
  return payload.data as Row;
}

export function StructuredWorkspace({ table, tables, onRegistryChanged, onCreateTable }: { table: Row; tables: Row[]; onRegistryChanged: () => void; onCreateTable: () => void }) {
  const columns = (table.schema_definition?.columns ?? []) as Column[];
  const [records, setRecords] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterState>(emptyFilter);
  const [sort, setSort] = useState<SortState>(emptySort);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([]);
  const [views, setViews] = useState<Row[]>([]);
  const [activeViewId, setActiveViewId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [drawerRecord, setDrawerRecord] = useState<Row | null | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panel, setPanel] = useState<"filter" | "sort" | "fields" | "views" | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const visibleColumns = columns.filter((column) => !hiddenColumns.includes(column.key));
  const params = useMemo(() => {
    const values = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (query) values.set("q", query);
    if (filter.column) { values.set("filterColumn", filter.column); values.set("filterOperator", filter.operator); values.set("filterValue", filter.value); }
    if (sort.column) { values.set("sortColumn", sort.column); values.set("sortDirection", sort.direction); }
    return values.toString();
  }, [page, pageSize, query, filter, sort]);

  const loadViews = useCallback(async () => {
    const next = await api<Row[]>(`/structured/tables/${encodeURIComponent(table.code)}/views`);
    setViews(next);
    if (!activeViewId && next[0]) setActiveViewId(next[0].id);
  }, [table.code, activeViewId]);

  useEffect(() => { void loadViews().catch((reason) => setError(reason instanceof Error ? reason.message : "Views could not be loaded.")); }, [table.code, refresh]);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    api<Row>(`/structured/tables/${encodeURIComponent(table.code)}/records?${params}`).then((result) => {
      if (!active) return; setRecords(result.records); setTotal(result.total); setPages(result.pages); setSelected([]);
    }).catch((reason) => active && setError(reason instanceof Error ? reason.message : "Records could not be loaded."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [table.code, params, refresh]);

  function chooseView(id: string) {
    setActiveViewId(id); const view = views.find((item) => item.id === id); if (!view) return;
    setFilter(view.config?.filters?.[0] ?? emptyFilter); setSort(view.config?.sorts?.[0] ?? emptySort); setHiddenColumns(view.config?.hiddenColumns ?? []); setPage(1); setPanel(null);
  }

  async function saveView() {
    const view = views.find((item) => item.id === activeViewId); if (!view) return;
    setBusy(true); setError("");
    try {
      await patch(`/structured/tables/${table.code}/views/${view.id}`, { config: { filters: filter.column ? [filter] : [], sorts: sort.column ? [sort] : [], hiddenColumns } });
      setNotice(`Saved “${view.name}”`); setRefresh((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The view could not be saved."); }
    finally { setBusy(false); }
  }

  async function createView(name: string) {
    if (!name.trim()) return;
    setBusy(true); setError("");
    try {
      const created = await post<Row>(`/structured/tables/${table.code}/views`, { name: name.trim(), config: { filters: filter.column ? [filter] : [], sorts: sort.column ? [sort] : [], hiddenColumns } });
      setActiveViewId(created.id); setRefresh((value) => value + 1); setPanel(null); setNotice(`Created “${created.name}”`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The view could not be created."); }
    finally { setBusy(false); }
  }

  async function importFile(file?: File) {
    if (!file) return; setBusy(true); setError(""); setNotice("");
    try { const result = await uploadCsv(table.code, file); setNotice(`${result.filename}: ${result.summary.inserted} inserted, ${result.summary.updated} updated`); setRefresh((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "CSV import failed."); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function exportCsv() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${API_URL}/structured/tables/${encodeURIComponent(table.code)}/export.csv`, { credentials: "include" });
      if (!response.ok) throw new Error("CSV export failed.");
      const blob = await response.blob(); const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = href; anchor.download = `${table.code}.csv`; anchor.click(); URL.revokeObjectURL(href);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "CSV export failed."); }
    finally { setBusy(false); }
  }

  async function bulkArchive() {
    if (!selected.length || table.adapter !== "generic_json" || !window.confirm(`Archive ${selected.length} selected records?`)) return;
    setBusy(true); setError("");
    try { await post(`/structured/tables/${table.code}/records/bulk-archive`, { recordIds: selected }); setNotice(`${selected.length} records archived`); setRefresh((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Records could not be archived."); }
    finally { setBusy(false); }
  }

  async function inlineSave(row: Row, column: Column, value: unknown) {
    if (table.adapter !== "generic_json" || row.data?.[column.key] === value) return;
    const before = records; setRecords((current) => current.map((item) => item.id === row.id ? { ...item, data: { ...item.data, [column.key]: value } } : item));
    try { await patch(`/structured/tables/${table.code}/records/${row.id}`, { ...row.data, [column.key]: value }); setNotice(`${column.label} saved`); }
    catch (reason) { setRecords(before); setError(reason instanceof Error ? reason.message : "Cell update failed."); }
  }

  return <div className="data-workspace">
    <aside className="data-sidebar">
      <div className="data-sidebar-head"><Link href="/knowledge/tables"><ArrowLeft size={15} />All bases</Link><button className="data-icon-button" title="Table settings" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /></button></div>
      <div className="data-sidebar-title"><span className="data-base-icon"><Table2 /></span><div><strong>TM Knowledge</strong><small>{tables.length} data tables</small></div></div>
      <nav className="data-table-nav">{tables.map((item) => <Link className={item.code === table.code ? "active" : ""} href={`/knowledge/tables/${encodeURIComponent(item.code)}`} key={item.id}><Table2 size={15} /><span>{item.name}</span><small>{item.record_count}</small></Link>)}</nav>
      <button className="data-add-table" onClick={onCreateTable}><Plus size={15} />New table</button>
    </aside>

    <section className="data-main">
      <header className="data-titlebar"><div><span className="data-base-icon large"><Table2 /></span><div><div className="data-title-line"><h1>{table.name}</h1><span>{table.adapter === "generic_json" ? "Custom table" : "System table"}</span></div><p>{table.description || "Structured operational data"}</p></div></div><div className="data-title-actions"><button onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={16} />Import</button><input ref={fileRef} hidden type="file" accept=".csv,text/csv" onChange={(event) => void importFile(event.target.files?.[0])} /><button onClick={() => void exportCsv()} disabled={busy}><Download size={16} />Export</button><button className="primary" onClick={() => setDrawerRecord(null)}><Plus size={16} />New record</button></div></header>

      <div className="data-viewbar">
        <div className="data-view-tabs"><button className="active" onClick={() => setPanel(panel === "views" ? null : "views")}><Grid3X3 size={15} />{views.find((item) => item.id === activeViewId)?.name ?? "All records"}<ChevronDown size={14} /></button>{views.length > 1 && <span>{views.length} views</span>}</div>
        <div className="data-view-actions"><button className={filter.column ? "active" : ""} onClick={() => setPanel(panel === "filter" ? null : "filter")}><Filter size={15} />Filter{filter.column && <i>1</i>}</button><button className={sort.column ? "active" : ""} onClick={() => setPanel(panel === "sort" ? null : "sort")}><ListFilter size={15} />Sort{sort.column && <i>1</i>}</button><button onClick={() => setPanel(panel === "fields" ? null : "fields")}><Columns3 size={15} />Fields</button><button onClick={() => void saveView()} disabled={busy || !activeViewId}><Save size={15} />Save view</button><div className="data-search"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search all fields" /></div></div>
      </div>

      {panel && <div className="data-popover-row">
        {panel === "filter" && <FilterPanel columns={columns} value={filter} change={(value) => { setFilter(value); setPage(1); }} clear={() => setFilter(emptyFilter)} />}
        {panel === "sort" && <SortPanel columns={columns} value={sort} change={(value) => { setSort(value); setPage(1); }} clear={() => setSort(emptySort)} />}
        {panel === "fields" && <FieldsPanel columns={columns} hidden={hiddenColumns} change={setHiddenColumns} />}
        {panel === "views" && <ViewsPanel views={views} active={activeViewId} choose={chooseView} create={createView} busy={busy} />}
        <button className="data-popover-close" aria-label="Close panel" onClick={() => setPanel(null)}><X size={15} /></button>
      </div>}
      {(error || notice) && <div className={cx("data-message", error ? "error" : "success")}><span>{error ? <AlertTriangle size={16} /> : <Check size={16} />}{error || notice}</span><button onClick={() => { setError(""); setNotice(""); }}><X size={14} /></button></div>}

      {selected.length > 0 && <div className="data-selection-bar"><strong>{selected.length} selected</strong><span />{table.adapter === "generic_json" && <button onClick={() => void bulkArchive()} disabled={busy}><Trash2 size={14} />Archive selected</button>}<button onClick={() => setSelected([])}>Clear</button></div>}

      <div className="data-grid-wrap">
        <table className="data-grid"><thead><tr><th className="data-check-cell"><input aria-label="Select all records" type="checkbox" checked={Boolean(records.length) && selected.length === records.length} onChange={(event) => setSelected(event.target.checked ? records.map((row) => row.id) : [])} /></th><th className="data-row-number">#</th>{visibleColumns.map((column, index) => <th className={index === 0 ? "data-primary-column" : ""} key={column.key}><span>{column.type === "currency" ? "₫" : column.type === "number" ? "#" : column.type === "date" ? "◷" : column.type === "boolean" ? "✓" : "A"}</span>{column.label}{column.required && <i title="Required">*</i>}</th>)}<th className="data-add-field"><button onClick={() => setSettingsOpen(true)} title="Configure fields"><Plus size={15} /></button></th></tr></thead>
          <tbody>{loading ? <tr><td colSpan={visibleColumns.length + 3}><div className="data-loading"><LoaderCircle className="spin" />Loading records</div></td></tr> : records.length ? records.map((row, rowIndex) => <tr key={row.id} className={selected.includes(row.id) ? "selected" : ""}><td className="data-check-cell"><input aria-label={`Select record ${rowIndex + 1}`} type="checkbox" checked={selected.includes(row.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} /></td><td className="data-row-number"><button onClick={() => setDrawerRecord(row)}>{(page - 1) * pageSize + rowIndex + 1}</button></td>{visibleColumns.map((column, columnIndex) => <EditableCell key={column.key} primary={columnIndex === 0} column={column} value={row.data?.[column.key]} editable={table.adapter === "generic_json"} open={() => setDrawerRecord(row)} save={(value) => void inlineSave(row, column, value)} />)}<td className="data-add-field" /></tr>) : <tr><td colSpan={visibleColumns.length + 3}><div className="data-empty"><Grid3X3 /><strong>No records in this view</strong><p>Clear the filters, import a CSV file, or create the first record.</p><button onClick={() => setDrawerRecord(null)}><Plus size={15} />New record</button></div></td></tr>}</tbody></table>
      </div>

      <footer className="data-footer"><span>{total.toLocaleString()} records</span><div><select aria-label="Rows per page" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="25">25 rows</option><option value="50">50 rows</option><option value="100">100 rows</option><option value="200">200 rows</option></select><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} /></button><span>Page {page} of {pages}</span><button disabled={page >= pages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button></div><span className="data-autosave"><Check size={13} />Changes are audited</span></footer>
    </section>

    {drawerRecord !== undefined && <RecordDrawer table={table} columns={columns} record={drawerRecord} close={() => setDrawerRecord(undefined)} done={() => { setDrawerRecord(undefined); setRefresh((value) => value + 1); setNotice("Record saved"); }} />}
    {settingsOpen && <TableSettings table={table} columns={columns} close={() => setSettingsOpen(false)} done={() => { setSettingsOpen(false); onRegistryChanged(); setRefresh((value) => value + 1); }} />}
  </div>;
}

function EditableCell({ column, value, editable, primary, open, save }: { column: Column; value: unknown; editable: boolean; primary: boolean; open: () => void; save: (value: unknown) => void }) {
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(Array.isArray(value) ? value.join(", ") : String(value ?? ""));
  useEffect(() => setDraft(Array.isArray(value) ? value.join(", ") : String(value ?? "")), [value]);
  if (editing && editable) {
    if (column.type === "boolean") return <td className={primary ? "data-primary-column" : ""}><select autoFocus value={String(value ?? false)} onBlur={() => setEditing(false)} onChange={(event) => { save(event.target.value === "true"); setEditing(false); }}><option value="true">Yes</option><option value="false">No</option></select></td>;
    if (column.options?.length || column.type === "status") return <td className={primary ? "data-primary-column" : ""}><select autoFocus value={draft} onBlur={() => setEditing(false)} onChange={(event) => { setDraft(event.target.value); save(event.target.value); setEditing(false); }}><option value="">Empty</option>{(column.options?.length ? column.options : ["active", "draft", "inactive", "published", "archived"]).map((option) => <option key={option}>{option}</option>)}</select></td>;
    return <td className={primary ? "data-primary-column" : ""}><input autoFocus type={column.type === "number" || column.type === "currency" ? "number" : column.type === "date" ? "date" : "text"} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(false); }} onBlur={() => { setEditing(false); save(coerceEditorValue(column, draft)); }} /></td>;
  }
  return <td className={primary ? "data-primary-column" : ""} onDoubleClick={() => editable && setEditing(true)}><button className="data-cell-button" onClick={editable ? undefined : open} title={editable ? "Double-click to edit" : "Open record"}>{showValue(column, value)}</button></td>;
}

function FilterPanel({ columns, value, change, clear }: { columns: Column[]; value: FilterState; change: (value: FilterState) => void; clear: () => void }) {
  return <div className="data-condition"><strong>Where</strong><select value={value.column} onChange={(event) => change({ ...value, column: event.target.value })}><option value="">Select field</option>{columns.map((column) => <option value={column.key} key={column.key}>{column.label}</option>)}</select><select value={value.operator} onChange={(event) => change({ ...value, operator: event.target.value as FilterState["operator"] })}><option value="contains">contains</option><option value="equals">is exactly</option><option value="not_equals">is not</option><option value="empty">is empty</option><option value="not_empty">is not empty</option></select>{!["empty", "not_empty"].includes(value.operator) && <input value={value.value} onChange={(event) => change({ ...value, value: event.target.value })} placeholder="Enter a value" />}<button onClick={clear}><Trash2 size={14} />Clear</button></div>;
}

function SortPanel({ columns, value, change, clear }: { columns: Column[]; value: SortState; change: (value: SortState) => void; clear: () => void }) {
  return <div className="data-condition"><strong>Sort by</strong><select value={value.column} onChange={(event) => change({ ...value, column: event.target.value })}><option value="">Select field</option>{columns.map((column) => <option value={column.key} key={column.key}>{column.label}</option>)}</select><button className={value.direction === "asc" ? "active" : ""} onClick={() => change({ ...value, direction: "asc" })}><ArrowDownAZ size={14} />Ascending</button><button className={value.direction === "desc" ? "active" : ""} onClick={() => change({ ...value, direction: "desc" })}><ArrowUpAZ size={14} />Descending</button><button onClick={clear}><Trash2 size={14} />Clear</button></div>;
}

function FieldsPanel({ columns, hidden, change }: { columns: Column[]; hidden: string[]; change: (value: string[]) => void }) {
  return <div className="data-fields-panel"><strong>Visible fields</strong>{columns.map((column) => <label key={column.key}><input type="checkbox" checked={!hidden.includes(column.key)} onChange={(event) => change(event.target.checked ? hidden.filter((key) => key !== column.key) : [...hidden, column.key])} /><span>{column.label}</span><small>{column.type.replace("_", " ")}</small></label>)}</div>;
}

function ViewsPanel({ views, active, choose, create, busy }: { views: Row[]; active: string; choose: (id: string) => void; create: (name: string) => Promise<void>; busy: boolean }) {
  const [name, setName] = useState("");
  return <div className="data-views-panel"><div><strong>Saved views</strong>{views.map((view) => <button className={view.id === active ? "active" : ""} onClick={() => choose(view.id)} key={view.id}><Grid3X3 size={14} />{view.name}{view.is_default && <small>Default</small>}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); void create(name); setName(""); }}><label>New view<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Published courses" /></label><button disabled={busy || !name.trim()}><Plus size={14} />Create</button></form></div>;
}

function FieldInput({ column, value, change }: { column: Column; value: any; change: (value: any) => void }) {
  if (column.type === "boolean") return <select value={String(value ?? false)} onChange={(event) => change(event.target.value === "true")}><option value="false">No</option><option value="true">Yes</option></select>;
  if (column.options?.length || column.type === "status") return <select value={value ?? ""} onChange={(event) => change(event.target.value)}><option value="">Select</option>{(column.options?.length ? column.options : ["active", "draft", "inactive", "published", "archived"]).map((option) => <option key={option}>{option}</option>)}</select>;
  if (column.type === "long_text") return <textarea value={value ?? ""} onChange={(event) => change(event.target.value)} />;
  return <input type={column.type === "number" || column.type === "currency" ? "number" : column.type === "date" ? "date" : "text"} value={Array.isArray(value) ? value.join(", ") : value ?? ""} onChange={(event) => change(event.target.value)} />;
}

function RecordDrawer({ table, columns, record, close, done }: { table: Row; columns: Column[]; record: Row | null; close: () => void; done: () => void }) {
  const [form, setForm] = useState<Record<string, any>>(() => Object.fromEntries(columns.map((column) => [column.key, record?.data?.[column.key] ?? (column.type === "boolean" ? false : "")])))
  const [courses, setCourses] = useState<Row[]>([]); const [courseId, setCourseId] = useState(record?.data?.course_id ?? "");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { if (table.adapter === "pricing_rules") void api<Row[]>("/courses").then((items) => { setCourses(items); if (!courseId) setCourseId(items.find((item) => item.name === form.course_name)?.id ?? items[0]?.id ?? ""); }); }, [table.adapter]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const typed = Object.fromEntries(columns.map((column) => [column.key, coerceEditorValue(column, form[column.key])]));
      if (table.adapter === "generic_json") record ? await patch(`/structured/tables/${table.code}/records/${record.id}`, typed) : await post(`/structured/tables/${table.code}/records`, typed);
      else if (table.adapter === "course_catalog") {
        const payload = { code: typed.code, name: typed.name, category: typed.category || null, courseType: typed.course_type || null, learningModes: typed.learning_modes ?? [], nextStartDate: typed.next_start_date || null, status: typed.status || "active" };
        if (record) await patch(`/courses/${record.id}`, payload); else { const created = await post<Row>("/courses", { code: payload.code, name: payload.name, category: payload.category ?? undefined }); await patch(`/courses/${created.id}`, payload); }
      } else {
        const payload = { courseId, audienceSegment: typed.audience_segment, deliveryMode: typed.delivery_mode || null, standardPrice: Number(typed.standard_price), earlyBirdPrice: typed.early_bird_price, groupPrice: typed.group_price, alumniPrice: typed.alumni_price, status: typed.status || "published", effectiveFrom: record?.data?.effective_from ?? new Date().toISOString() };
        record ? await patch(`/pricing-rules/${record.id}`, payload) : await post("/pricing-rules", payload);
      }
      done();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The record could not be saved."); }
    finally { setBusy(false); }
  }
  async function archive() {
    if (!record || !window.confirm("Archive this record?")) return; setBusy(true);
    try { if (table.adapter === "generic_json") await remove(`/structured/tables/${table.code}/records/${record.id}`); else if (table.adapter === "course_catalog") await remove(`/courses/${record.id}`); else await remove(`/pricing-rules/${record.id}`); done(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The record could not be archived."); setBusy(false); }
  }
  return <div className="record-drawer-wrap"><button className="record-drawer-scrim" aria-label="Close record" onClick={close} /><form className="record-drawer" onSubmit={submit}><header><div><span>{record ? `Record ${record.id.slice(0, 8)}` : "New record"}</span><h2>{record ? String(record.data?.[columns[0]?.key] ?? "Record details") : `Add to ${table.name}`}</h2></div><button type="button" onClick={close}><X /></button></header><div className="record-fields">{table.adapter === "pricing_rules" && <label><span>Course<strong>*</strong></span><select required value={courseId} onChange={(event) => setCourseId(event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>}{columns.filter((column) => !(table.adapter === "pricing_rules" && column.key === "course_name")).map((column) => <label className={column.type === "long_text" ? "tall" : ""} key={column.key}><span>{column.label}{column.required && <strong>*</strong>}<small>{column.type.replace("_", " ")}</small></span><FieldInput column={column} value={form[column.key]} change={(value) => setForm((current) => ({ ...current, [column.key]: value }))} /></label>)}</div>{error && <div className="record-error"><AlertTriangle size={15} />{error}</div>}<footer>{record && <button type="button" className="danger" onClick={() => void archive()} disabled={busy}><Trash2 size={15} />Archive</button>}<span /><button type="button" onClick={close}>Cancel</button><button className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{busy ? "Saving" : "Save record"}</button></footer></form></div>;
}

function TableSettings({ table, columns, close, done }: { table: Row; columns: Column[]; close: () => void; done: () => void }) {
  const [name, setName] = useState(table.name); const [description, setDescription] = useState(table.description ?? "");
  const [primaryKey, setPrimaryKey] = useState(table.schema_definition?.primaryKey ?? columns[0]?.key ?? "id");
  const [fields, setFields] = useState<Column[]>(columns); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  function update(index: number, key: keyof Column, value: any) { setFields((current) => current.map((field, position) => position === index ? { ...field, [key]: value } : field)); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await patch(`/structured/tables/${table.code}`, { name, description: description || null, ...(table.adapter === "generic_json" ? { definition: { primaryKey, columns: fields } } : {}) }); done(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Table settings could not be saved."); }
    finally { setBusy(false); }
  }
  return <div className="modal-wrap"><button className="modal-scrim" aria-label="Close settings" onClick={close} /><form className="modal schema-modal data-settings-modal" onSubmit={submit}><div className="modal-head"><div><span className="kicker">TABLE SETTINGS</span><h2>Configure {table.name}</h2><p>Labels and views can change safely. Machine keys remain the stable contract used by imports and AI tools.</p></div><button type="button" className="icon" onClick={close}><X /></button></div><div className="form-grid"><label>Table name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Stable code<input disabled value={table.code} /></label><label className="wide">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label></div><div className="schema-builder-head"><div><strong>Fields</strong><small>{table.adapter === "generic_json" ? "Add fields or refine validation." : "Built-in field keys are protected by the domain adapter."}</small></div>{table.adapter === "generic_json" && <button type="button" className="button small" onClick={() => setFields((current) => [...current, { key: `field_${current.length + 1}`, label: `Field ${current.length + 1}`, type: "text" }])}><Plus size={14} />Add field</button>}</div><div className="schema-builder"><div className="schema-row schema-labels"><span>Label</span><span>Machine key</span><span>Type</span><span>Required</span><span /></div>{fields.map((field, index) => <div className="schema-row" key={`${field.key}-${index}`}><input value={field.label} onChange={(event) => update(index, "label", event.target.value)} disabled={table.adapter !== "generic_json"} /><input value={field.key} disabled /><select value={field.type} onChange={(event) => update(index, "type", event.target.value)} disabled={table.adapter !== "generic_json"}>{["text", "long_text", "number", "currency", "boolean", "date", "list", "status"].map((type) => <option key={type}>{type}</option>)}</select><label className="check-label"><input type="checkbox" checked={Boolean(field.required)} onChange={(event) => update(index, "required", event.target.checked)} disabled={table.adapter !== "generic_json" || field.key === primaryKey} /><span>Required</span></label>{table.adapter === "generic_json" && <button type="button" className="icon table-action danger" disabled={field.key === primaryKey || fields.length <= 1} onClick={() => setFields((current) => current.filter((_, position) => position !== index))}><Trash2 size={14} /></button>}</div>)}</div>{table.adapter === "generic_json" && <label>Primary key<select value={primaryKey} onChange={(event) => { setPrimaryKey(event.target.value); setFields((current) => current.map((field) => field.key === event.target.value ? { ...field, required: true } : field)); }}>{fields.map((field) => <option value={field.key} key={field.key}>{field.label}</option>)}</select></label>}{error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button></div></form></div>;
}
