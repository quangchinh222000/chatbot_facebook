"use client";

/**
 * Các màn còn thiếu giao diện, tuy API đã chạy:
 *   - Chunk preview + test truy hồi
 *   - Trace từng bước + báo "AI trả lời sai"
 *   - Duyệt đề xuất tối ưu prompt do AI sinh
 *   - Danh sách và tạo Agent
 *   - Tình trạng hệ thống + lịch định kỳ
 */

import {
  Activity, AlertTriangle, Bot, Check, ChevronRight, Clock3, Database, FileSearch,
  FlaskConical, Layers, Play, RefreshCw, Rocket, Search, Send, ShieldCheck, Sparkles,
  ThumbsDown, ThumbsUp, X, Zap
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import { api, patch, post } from "@/lib/api";

type Row = Record<string, any>;

function useLoad<T>(path: string | null, refresh = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(path));
  const load = useCallback(async () => {
    if (!path) { setData(null); setLoading(false); return; }
    setLoading(true);
    try { setData(await api<T>(path)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Không tải được dữ liệu."); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void load(); }, [load, refresh]);
  return { data, error, loading, reload: load };
}

function Header({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}
function Empty({ icon: Icon = Database, title, body }: { icon?: any; title: string; body: string }) {
  return <div className="empty"><Icon size={30} /><strong>{title}</strong><p>{body}</p></div>;
}
function State({ loading, error, children }: { loading: boolean; error: string; children: ReactNode }) {
  if (loading) return <div className="loading"><span /><span /><span /></div>;
  if (error) return <div className="error-box"><AlertTriangle size={18} />{error}</div>;
  return <>{children}</>;
}
function Badge({ value, tone }: { value: string; tone?: string }) {
  const v = String(value ?? "").toLowerCase();
  const color = tone ?? (/(embedded|published|ok|healthy|approved|active|good|completed)/.test(v) ? "green"
    : /(failed|down|rejected|wrong|unsafe)/.test(v) ? "red"
    : /(pending|draft|degraded|awaiting|not_configured|embedding)/.test(v) ? "amber" : "slate");
  return <span className={`badge ${color}`}><span className="badge-dot" />{String(value).replaceAll("_", " ")}</span>;
}
const fmt = (v?: string) => (v ? new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(new Date(v)) : "—");

// ===========================================================================
// 1. Chunk preview + test truy hồi
// ===========================================================================
export function ChunkStudio() {
  const [refresh, setRefresh] = useState(0);
  const docs = useLoad<Row>("/knowledge/documents", refresh);
  const list: Row[] = Array.isArray(docs.data) ? docs.data : (docs.data?.documents ?? docs.data?.rows ?? []);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const detail = useLoad<Row>(docId ? `/knowledge/documents/${docId}` : null, refresh);

  useEffect(() => { if (!docId && list.length) setDocId(list[0]!.id); }, [list, docId]);
  useEffect(() => {
    const revs = detail.data?.revisions ?? [];
    if (revs.length) setRevisionId(revs[0].id);
  }, [detail.data]);

  const chunks = useLoad<Row>(revisionId ? `/knowledge/revisions/${revisionId}/chunks` : null, refresh);
  const [question, setQuestion] = useState("Khách hỏi chính sách hoàn phí thì trả lời thế nào?");
  const [testResult, setTestResult] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  async function runTest() {
    setBusy(true); setActionError("");
    try { setTestResult(await post<Row>("/knowledge/retrieval-test", { question, topK: 5, documentRevisionId: revisionId })); }
    catch (e) { setActionError(e instanceof Error ? e.message : "Không chạy được test."); }
    finally { setBusy(false); }
  }
  async function reembed() {
    setBusy(true); setActionError("");
    try { await post("/knowledge/reembed", { reason: "Nhúng lại từ màn chunk preview" }); setTimeout(() => setRefresh((v) => v + 1), 4000); }
    catch (e) { setActionError(e instanceof Error ? e.message : "Không nhúng lại được."); }
    finally { setBusy(false); }
  }

  const warn = chunks.data?.warnings ?? { tooLong: [], tooShort: [], notEmbedded: [] };
  return <>
    <Header eyebrow="TÀI LIỆU" title="Xem trước chunk & Test truy hồi"
      description="Kiểm tra tài liệu được chia đoạn ra sao và AI có tìm đúng không, trước khi phát hành."
      actions={<><button className="button" disabled={busy} onClick={reembed}><RefreshCw size={16} />Nhúng lại toàn bộ</button>
        <button className="button primary" disabled={busy || !revisionId} onClick={runTest}><Play size={16} />Chạy test</button></>} />
    {actionError && <div className="error-box page-error"><AlertTriangle size={17} />{actionError}</div>}

    <div className="form-grid" style={{ marginBottom: 16 }}>
      <label>Tài liệu
        <select value={docId ?? ""} onChange={(e) => { setDocId(e.target.value); setTestResult(null); }}>
          {list.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
        </select>
      </label>
      <label>Phiên bản
        <select value={revisionId ?? ""} onChange={(e) => setRevisionId(e.target.value)}>
          {(detail.data?.revisions ?? []).map((r: Row) => <option key={r.id} value={r.id}>v{r.revision_no} · {r.status}</option>)}
        </select>
      </label>
    </div>

    <div className="metric-grid">
      <section className="metric card"><span className="metric-icon violet"><Layers /></span><div>
        <span>Tổng số đoạn</span><strong>{chunks.data?.total ?? 0}</strong><small>đã chia từ tài liệu</small></div></section>
      <section className="metric card"><span className="metric-icon blue"><Sparkles /></span><div>
        <span>Đã nhúng</span><strong>{(chunks.data?.chunks ?? []).filter((c: Row) => c.embedding_status === "embedded").length}</strong>
        <small>{chunks.data?.embeddingProfile?.model ?? "—"}</small></div></section>
      <section className="metric card"><span className="metric-icon amber"><AlertTriangle /></span><div>
        <span>Đoạn quá dài</span><strong>{warn.tooLong.length}</strong><small>trên 1.200 token</small></div></section>
      <section className="metric card"><span className="metric-icon red"><AlertTriangle /></span><div>
        <span>Chưa nhúng được</span><strong>{warn.notEmbedded.length}</strong><small>cần nhúng lại</small></div></section>
    </div>

    <div className="dashboard-grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
      <section className="card" style={{ padding: 18 }}>
        <div className="card-title"><div><Layers /><span><strong>Danh sách đoạn</strong><small>Đoạn quá dài khó truy hồi chính xác</small></span></div></div>
        <State loading={chunks.loading} error={chunks.error}>
          {(chunks.data?.chunks ?? []).length ? <div className="table-card" style={{ maxHeight: 420, overflow: "auto" }}>
            <table><thead><tr><th>#</th><th>Nội dung</th><th>Token</th><th>Trạng thái</th></tr></thead><tbody>
              {(chunks.data?.chunks ?? []).map((c: Row) => <tr key={c.id}>
                <td>{c.chunk_index + 1}</td>
                <td><small>{String(c.content).slice(0, 110)}…</small></td>
                <td>{c.token_estimate ?? "—"}</td>
                <td><Badge value={warn.tooLong.includes(c.chunk_index) ? "cần chia nhỏ" : c.embedding_status} /></td>
              </tr>)}
            </tbody></table>
          </div> : <Empty icon={Layers} title="Chưa có đoạn nào" body="Tài liệu chưa được chia đoạn hoặc chưa nhúng xong." />}
        </State>
      </section>

      <section className="card" style={{ padding: 18 }}>
        <div className="card-title"><div><FileSearch /><span><strong>Test truy hồi</strong><small>Hỏi thử xem AI có tìm đúng đoạn không</small></span></div></div>
        <label>Câu hỏi mẫu<textarea value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
        <button className="button primary full" disabled={busy} onClick={runTest} style={{ marginTop: 10 }}>
          <Search size={16} />{busy ? "Đang tìm…" : "Chạy test truy hồi"}</button>

        {testResult && <>
          <div className="metric-grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))", marginTop: 16 }}>
            <section className="metric card"><div><span>Điểm cao nhất</span><strong>{testResult.metrics.topScore}</strong>
              <small>{testResult.metrics.topScore >= 0.35 ? "tìm đúng" : "cần xem lại tài liệu"}</small></div></section>
            <section className="metric card"><div><span>Điểm trung bình</span><strong>{testResult.metrics.averageScore}</strong>
              <small>{testResult.metrics.returned} đoạn · {testResult.metrics.latencyMs}ms</small></div></section>
          </div>
          <div style={{ marginTop: 12 }}>
            {testResult.results.map((r: Row, i: number) => <div key={r.id} className="rule-preview" style={{ marginBottom: 8 }}>
              <span><strong>#{i + 1}</strong> · {r.document_title} · điểm {Number(r.score).toFixed(3)} (ngữ nghĩa {Number(r.vector_score).toFixed(3)})</span>
              <small style={{ display: "block", marginTop: 4 }}>{String(r.content).slice(0, 180)}…</small>
            </div>)}
          </div>
        </>}
      </section>
    </div>
  </>;
}

// ===========================================================================
// 2. Trace từng bước + báo AI trả lời sai
// ===========================================================================
export function TraceExplorer() {
  const [refresh, setRefresh] = useState(0);
  const runs = useLoad<Row[]>("/traces?limit=50", refresh);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useLoad<Row>(selected ? `/traces/${selected}` : null, refresh);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");

  useEffect(() => { if (!selected && runs.data?.length) setSelected(runs.data[0]!.id); }, [runs.data, selected]);

  async function sendFeedback(rating: string, correctedText?: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await post("/feedback", { aiRunId: selected, rating, correctedText: correctedText || undefined,
        conversationId: detail.data?.conversation_id ?? undefined });
      setSent(rating === "good" ? "Đã ghi nhận là trả lời tốt." : "Đã báo sai. Job hàng tuần sẽ dùng để đề xuất sửa prompt.");
      setTimeout(() => setSent(""), 4000);
    } finally { setBusy(false); }
  }

  const steps: Row[] = detail.data?.steps ?? [];
  return <>
    <Header eyebrow="HỘP THƯ TEST" title="Trace từng bước"
      description="Xem AI đã đi qua những bước nào, gọi tool gì, lấy dữ liệu từ bản ghi nào."
      actions={<button className="button ghost" onClick={() => setRefresh((v) => v + 1)}><RefreshCw size={16} />Làm mới</button>} />
    {sent && <div className="success-box"><Check size={18} />{sent}</div>}

    <div className="inbox-layout" style={{ gridTemplateColumns: "340px minmax(0,1fr)" }}>
      <section className="card thread-list">
        <State loading={runs.loading} error={runs.error}>
          {runs.data?.length ? runs.data.map((r) => <button key={r.id} onClick={() => setSelected(r.id)}
            className={`thread ${selected === r.id ? "selected" : ""}`}>
            <span className="thread-main">
              <span><strong>{r.decision?.stage ?? "—"}</strong><time>{fmt(r.created_at)}</time></span>
              <small>{String(r.input?.text ?? "").slice(0, 60)}</small>
              <span className="thread-tags"><Badge value={r.status} />{r.language && <em>{r.language}</em>}</span>
            </span>
          </button>) : <Empty icon={Activity} title="Chưa có lượt AI nào" body="Gửi một tin nhắn thử ở Hộp thư test." />}
        </State>
      </section>

      <section className="card" style={{ padding: 18, overflow: "auto" }}>
        <State loading={detail.loading} error={detail.error}>
          {detail.data ? <>
            <div className="card-title"><div><Zap /><span>
              <strong>Lượt AI · {detail.data.decision?.stage}</strong>
              <small>{detail.data.provider} · {detail.data.model} · {detail.data.latency_ms}ms · ngôn ngữ {detail.data.language}</small>
            </span></div></div>

            <div className="facts"><dl>
              <dt>Môi trường</dt><dd><Badge value={detail.data.environment} /></dd>
              <dt>Chế độ chạy</dt><dd>{detail.data.run_mode}</dd>
              <dt>Release</dt><dd>{detail.data.runtime_config?.release?.code ?? "—"}</dd>
              <dt>Prompt</dt><dd>{detail.data.runtime_config?.prompt?.code ?? "—"} ({detail.data.runtime_config?.prompt?.source})</dd>
            </dl></div>

            <div className="section-toolbar"><div><h2>Các bước thực thi</h2>
              <p>{steps.length ? `${steps.length} bước` : "Lượt này chạy bằng engine tuyến tính, chưa có bước chi tiết."}</p></div></div>

            {steps.length ? steps.map((s) => <div key={s.step_index} className="rule-preview" style={{ marginBottom: 10 }}>
              <span><strong>{s.step_index + 1}. {s.node_label}</strong> · {s.node_type} · <Badge value={s.status} /> · {s.latency_ms}ms</span>
              {s.branch_reason && <small style={{ display: "block" }}>Đi tiếp vì: {s.branch_reason}</small>}
              <small style={{ display: "block", marginTop: 4 }}>{JSON.stringify(s.output).slice(0, 220)}</small>
            </div>) : null}

            <div className="section-toolbar"><div><h2>Công cụ đã gọi</h2></div></div>
            {(detail.data.toolCalls ?? []).length ? (detail.data.toolCalls ?? []).map((t: Row, i: number) =>
              <div key={i} className="rule-preview" style={{ marginBottom: 8 }}>
                <span><strong>{t.tool_code}</strong> · <Badge value={t.status} /> · {t.latency_ms}ms</span>
                <small style={{ display: "block" }}>Vào: {JSON.stringify(t.input).slice(0, 140)}</small>
                <small style={{ display: "block" }}>Ra: {JSON.stringify(t.output).slice(0, 200)}</small>
              </div>) : <p className="context-copy">Lượt này không gọi tool nào.</p>}

            <div className="section-toolbar"><div><h2>Câu trả lời cuối</h2></div></div>
            <div className="prompt-preview">{detail.data.output?.final ?? "—"}</div>

            <div className="artifact-actions" style={{ marginTop: 14 }}>
              <button className="button" disabled={busy} onClick={() => sendFeedback("good")}><ThumbsUp size={15} />Trả lời tốt</button>
              <button className="button danger-button" disabled={busy} onClick={() => sendFeedback("wrong")}><ThumbsDown size={15} />AI trả lời sai</button>
              <button className="button" disabled={busy} onClick={() => sendFeedback("incomplete")}>Thiếu thông tin</button>
            </div>
          </> : <Empty icon={Activity} title="Chọn một lượt AI" body="Danh sách bên trái là các lượt AI gần nhất." />}
        </State>
      </section>
    </div>
  </>;
}

// ===========================================================================
// 3. Duyệt đề xuất tối ưu prompt
// ===========================================================================
export function Proposals() {
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useLoad<Row[]>("/improvement-proposals", refresh);
  const schedules = useLoad<Row[]>("/schedules", refresh);
  const [selected, setSelected] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function review(decision: "approved" | "rejected") {
    if (!selected) return;
    setBusy(true);
    try { await post(`/improvement-proposals/${selected.id}/review`, { decision, comment: note }); setSelected(null); setNote(""); setRefresh((v) => v + 1); }
    finally { setBusy(false); }
  }
  async function runNow() {
    setBusy(true);
    try { await post("/schedules/weekly-prompt-review/run-now"); setTimeout(() => setRefresh((v) => v + 1), 8000); }
    finally { setBusy(false); }
  }

  const weekly = schedules.data?.find((s) => s.code === "weekly-prompt-review");
  return <>
    <Header eyebrow="PROMPT" title="Đề xuất tối ưu Prompt"
      description="AI rà hội thoại quá khứ mỗi tuần và đề xuất sửa prompt. Con người duyệt trước khi áp dụng."
      actions={<button className="button primary" disabled={busy} onClick={runNow}><Play size={16} />Chạy rà soát ngay</button>} />

    <div className="info-banner"><ShieldCheck size={18} /><span>
      <strong>AI chỉ đề xuất, không tự áp dụng.</strong>
      Mỗi đề xuất phải dẫn được cuộc hội thoại cụ thể đã hỏng thì mới hiện ở đây.
    </span></div>

    <div className="metric-grid">
      <section className="metric card"><span className="metric-icon violet"><Sparkles /></span><div>
        <span>Chờ duyệt</span><strong>{(data ?? []).filter((p) => p.status === "awaiting_review").length}</strong><small>đề xuất mới</small></div></section>
      <section className="metric card"><span className="metric-icon green"><Check /></span><div>
        <span>Đã duyệt</span><strong>{(data ?? []).filter((p) => p.status === "approved").length}</strong><small>đã áp dụng</small></div></section>
      <section className="metric card"><span className="metric-icon amber"><Clock3 /></span><div>
        <span>Lịch chạy</span><strong>{weekly?.enabled ? "Bật" : "Tắt"}</strong>
        <small>{weekly?.next_run_at ? `Lần tới ${fmt(weekly.next_run_at)}` : "chưa xếp lịch"}</small></div></section>
      <section className="metric card"><span className="metric-icon blue"><Activity /></span><div>
        <span>Tín hiệu đã dùng</span><strong>{(data ?? []).reduce((n, p) => n + Number(p.signal_count ?? 0), 0)}</strong><small>trường hợp hỏng</small></div></section>
    </div>

    <section className="card table-card">
      <State loading={loading} error={error}>
        {data?.length ? <table><thead><tr><th>Chủ đề</th><th>Agent</th><th>Số tín hiệu</th><th>Trạng thái</th><th>Tạo lúc</th><th /></tr></thead><tbody>
          {data.map((p) => <tr key={p.id}>
            <td><strong>{p.title}</strong><small>{String(p.rationale ?? "").slice(0, 70)}…</small></td>
            <td>{p.agent_name}</td><td>{p.signal_count}</td>
            <td><Badge value={p.status} /></td><td>{fmt(p.created_at)}</td>
            <td>{p.status === "awaiting_review" && <button className="button small" onClick={() => setSelected(p)}>Xem & duyệt</button>}</td>
          </tr>)}
        </tbody></table> : <Empty icon={Sparkles} title="Chưa có đề xuất nào"
          body="Bấm Chạy rà soát ngay, hoặc đợi lịch hàng tuần. Cần đủ tín hiệu hỏng thì AI mới đề xuất." />}
      </State>
    </section>

    {selected && <div className="modal-wrap"><button aria-label="Đóng" className="modal-scrim" onClick={() => setSelected(null)} />
      <div className="modal wide-modal">
        <div className="modal-head"><div><h2>{selected.title}</h2><p>{selected.agent_name} · {selected.signal_count} tín hiệu</p></div>
          <button className="icon" onClick={() => setSelected(null)}><X /></button></div>

        <div className="section-toolbar"><div><h2>Vì sao AI đề xuất</h2></div></div>
        <div className="prompt-preview">{selected.rationale}</div>

        <div className="section-toolbar"><div><h2>Dẫn chứng</h2><p>Các cuộc hội thoại đã hỏng</p></div></div>
        {(selected.evidence_summary?.examples ?? []).map((e: Row, i: number) => <div key={i} className="rule-preview" style={{ marginBottom: 8 }}>
          <small style={{ display: "block" }}><strong>Khách:</strong> {e.customer}</small>
          <small style={{ display: "block" }}><strong>Bot:</strong> {e.bot}</small>
          {e.corrected && <small style={{ display: "block", color: "var(--green)" }}><strong>Nhân viên sửa thành:</strong> {e.corrected}</small>}
        </div>)}

        <div className="dashboard-grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))", marginTop: 14 }}>
          <div><h4>Prompt đang chạy (v{selected.base_version_no})</h4>
            <div className="prompt-preview" style={{ maxHeight: 240, overflow: "auto" }}>{selected.base_prompt}</div></div>
          <div><h4>Prompt AI đề xuất (v{selected.proposed_version_no})</h4>
            <div className="prompt-preview" style={{ maxHeight: 240, overflow: "auto" }}>{selected.proposed_prompt}</div></div>
        </div>

        <label style={{ marginTop: 12 }}>Ghi chú khi duyệt<textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="modal-actions">
          <button className="button ghost" disabled={busy} onClick={() => review("rejected")}>Từ chối</button>
          <button className="button primary" disabled={busy} onClick={() => review("approved")}><Check size={16} />Duyệt áp dụng</button>
        </div>
      </div>
    </div>}
  </>;
}

// ===========================================================================
// 4. Agent
// ===========================================================================
export function AgentsScreen() {
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useLoad<Row[]>("/agents", refresh);
  const tools = useLoad<Row[]>("/tools", refresh);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  async function publish(versionId: string) {
    setBusy(true); setActionError("");
    try { await post(`/agent-versions/${versionId}/publish`); setRefresh((v) => v + 1); }
    catch (e) { setActionError(e instanceof Error ? e.message : "Không publish được."); }
    finally { setBusy(false); }
  }

  return <>
    <Header eyebrow="LUỒNG AGENT" title="Agent"
      description="Mỗi Agent có prompt, model, bộ công cụ và tri thức riêng. Thêm Agent để bot xử lý thêm tình huống."
      actions={<button className="button primary" onClick={() => setCreating(true)}><Bot size={16} />Thêm Agent</button>} />
    {actionError && <div className="error-box page-error"><AlertTriangle size={17} />{actionError}</div>}

    <State loading={loading} error={error}>
      <div className="studio-grid">
        {(data ?? []).map((a) => <section className="card artifact" key={a.id}>
          <div><span className="artifact-icon"><Bot /></span><div className="artifact-badges">
            <Badge value={a.kind} /><Badge value={a.version_status} />
          </div></div>
          <h3>{a.name}</h3>
          <code>{a.code} · v{a.version_no} · {a.version_count} phiên bản</code>
          <p>{a.description}</p>
          <div className="prompt-preview">{String(a.system_prompt ?? "").slice(0, 160)}…</div>
          <div className="artifact-meta">
            <span><Sparkles size={15} />{(a.tool_codes ?? []).length} công cụ</span>
            <span><Database size={15} />{(a.knowledge_codes ?? []).length} nguồn tri thức</span>
          </div>
          {(a.tool_codes ?? []).length > 0 && <div className="rule-preview">
            {(a.tool_codes ?? []).map((t: string) => <span key={t}><Check size={12} />{t}</span>)}
          </div>}
          {a.version_status !== "published" && <div className="artifact-actions">
            <button className="button primary" disabled={busy} onClick={() => publish(a.version_id)}>Publish v{a.version_no}</button>
          </div>}
        </section>)}
      </div>
    </State>

    {creating && <CreateAgent tools={tools.data ?? []} close={() => setCreating(false)}
      done={() => { setCreating(false); setRefresh((v) => v + 1); }} />}
  </>;
}

function CreateAgent({ tools, close, done }: { tools: Row[]; close: () => void; done: () => void }) {
  const [form, setForm] = useState({ code: "", name: "", description: "", systemPrompt: "" });
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await post("/agents", { ...form, kind: "conversational", toolCodes: picked }); done(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Không tạo được Agent."); }
    finally { setBusy(false); }
  }

  return <div className="modal-wrap"><button aria-label="Đóng" className="modal-scrim" onClick={close} />
    <form className="modal wide-modal" onSubmit={submit}>
      <div className="modal-head"><div><h2>Thêm Agent</h2>
        <p>Agent mới mặc định không có công cụ nào. Cấp đúng thứ nó cần, không cấp thừa.</p></div>
        <button type="button" className="icon" onClick={close}><X /></button></div>

      <div className="form-grid">
        <label>Tên hiển thị<input required value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value, code: form.code || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })}
          placeholder="Tư vấn lộ trình học" /></label>
        <label>Mã ổn định<input required pattern="[a-z][a-z0-9-]*" value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value.toLowerCase() })} placeholder="tu-van-lo-trinh" /></label>
        <label className="wide">Vai trò<textarea value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Agent này xử lý tình huống nào?" /></label>
        <label className="wide">Prompt hệ thống<textarea required style={{ minHeight: 180 }} value={form.systemPrompt}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          placeholder="Bạn là chuyên viên tư vấn của TM Academy. Nhiệm vụ của bạn là…" /></label>
      </div>

      <div className="schema-builder-head"><div><strong>Công cụ được phép</strong>
        <small>Agent chỉ gọi được công cụ chọn ở đây. Ngoài danh sách này là bị chặn.</small></div></div>
      <div className="rule-preview">
        {tools.map((t) => <label key={t.code} className="check-label" style={{ marginRight: 14 }}>
          <input type="checkbox" checked={picked.includes(t.code)}
            onChange={(e) => setPicked(e.target.checked ? [...picked, t.code] : picked.filter((c) => c !== t.code))} />
          <span>{t.code}</span>
        </label>)}
      </div>

      <div className="info-banner" style={{ marginTop: 14 }}><ShieldCheck size={18} /><span>
        <strong>Ràng buộc an toàn luôn bật.</strong>
        Agent nào cũng bị chặn bịa số tiền, bịa ngày khai giảng và xác nhận thanh toán. Không tắt được.
      </span></div>

      {error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}
      <div className="modal-actions">
        <button type="button" className="button ghost" onClick={close}>Huỷ</button>
        <button disabled={busy} className="button primary">{busy ? "Đang tạo…" : "Tạo Agent"}</button>
      </div>
    </form>
  </div>;
}

// ===========================================================================
// 5. Tình trạng hệ thống + lịch
// ===========================================================================
export function SystemStatus() {
  const [refresh, setRefresh] = useState(0);
  const health = useLoad<Row>("/health/detailed", refresh);
  const schedules = useLoad<Row[]>("/schedules", refresh);
  const [busy, setBusy] = useState(false);

  async function toggle(code: string, enabled: boolean) {
    setBusy(true);
    try { await patch(`/schedules/${code}`, { enabled }); setRefresh((v) => v + 1); }
    finally { setBusy(false); }
  }

  return <>
    <Header eyebrow="CÀI ĐẶT" title="Tình trạng hệ thống"
      description="Từng thành phần có đang chạy không, và các việc chạy theo lịch."
      actions={<button className="button ghost" onClick={() => setRefresh((v) => v + 1)}><RefreshCw size={16} />Kiểm tra lại</button>} />

    <State loading={health.loading} error={health.error}>
      {health.data && <>
        <div className="info-banner"><Rocket size={18} /><span>
          <strong>Chế độ vận hành: {health.data.runtimeMode}</strong>
          {health.data.demoMode ? " Mọi lời gọi ra Facebook đang bị chặn." : " Hệ thống có thể gửi tin thật."}
        </span></div>

        <section className="card table-card">
          <table><thead><tr><th>Thành phần</th><th>Trạng thái</th><th>Chi tiết</th><th>Độ trễ</th></tr></thead><tbody>
            {(health.data.components ?? []).map((c: Row) => <tr key={c.component}>
              <td><strong>{c.component}</strong></td>
              <td><Badge value={c.status} /></td>
              <td><small>{c.detail}</small></td>
              <td>{c.latencyMs != null ? `${c.latencyMs}ms` : "—"}</td>
            </tr>)}
          </tbody></table>
        </section>
      </>}
    </State>

    <div className="section-toolbar"><div><h2>Việc chạy theo lịch</h2>
      <p>Bật lịch không chạy ngay, hệ thống chỉ tính giờ chạy kế tiếp.</p></div></div>
    <section className="card table-card">
      <State loading={schedules.loading} error={schedules.error}>
        {schedules.data?.length ? <table><thead><tr><th>Việc</th><th>Lịch</th><th>Lần chạy tới</th><th>Lần cuối</th><th /></tr></thead><tbody>
          {schedules.data.map((s) => <tr key={s.id}>
            <td><strong>{s.name}</strong><small>{s.code}</small></td>
            <td><code>{s.cron_expression}</code><small>{s.timezone}</small></td>
            <td>{fmt(s.next_run_at)}</td>
            <td>{s.last_run_at ? fmt(s.last_run_at) : "chưa chạy"}</td>
            <td><button className="button small" disabled={busy} onClick={() => toggle(s.code, !s.enabled)}>
              {s.enabled ? "Tắt" : "Bật"}</button></td>
          </tr>)}
        </tbody></table> : <Empty icon={Clock3} title="Chưa có lịch nào" body="Lịch định kỳ sẽ hiện ở đây." />}
      </State>
    </section>
  </>;
}
