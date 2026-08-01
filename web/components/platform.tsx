"use client";

import {
  Activity, AlertTriangle, ArrowLeft, BadgeDollarSign, Bell, Bot, BrainCircuit, CheckCircle2, ChevronRight,
  Circle, Clock3, Copy, Database, FileText, FlaskConical, GraduationCap, Inbox, LayoutDashboard,
  LogOut, Menu, MessageSquareText, MessagesSquare, Pencil, Plus, RefreshCw, Rocket, Scale,
  Search, Send, ShieldCheck, Sparkles, Table2, Trash2, Upload, UserRound, Users, Webhook, Workflow, X
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, API_URL, ApiError, patch, post, remove } from "@/lib/api";
import { FlowStudio } from "@/components/flow-studio";
import { StructuredWorkspace } from "@/components/structured-workspace";

type Row = Record<string, any>;
type User = { id: string; displayName: string; email: string; permissions: string[]; roles: string[] };
type Environment = "live" | "test";

const nav = [
  { label: "Overview", items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }] },
  { label: "Operations", items: [
    { href: "/conversations", label: "Conversations", icon: MessagesSquare },
    { href: "/cases", label: "Handover Cases", icon: Inbox },
    { href: "/contacts", label: "Customers", icon: Users }
  ]},
  { label: "Knowledge", items: [
    { href: "/knowledge/documents", label: "Documents", icon: FileText },
    { href: "/knowledge/tables", label: "Structured Data", icon: Table2 }
  ] },
  { label: "AI Studio", items: [
    { href: "/studio/flows", label: "Conversation Flow", icon: Workflow },
    { href: "/studio/prompts", label: "Prompts", icon: Sparkles },
    { href: "/studio/rules", label: "Rules", icon: Scale },
    { href: "/studio/evaluations", label: "Evaluations", icon: FlaskConical },
    { href: "/studio/releases", label: "Releases", icon: Rocket }
  ]},
  { label: "System", items: [
    { href: "/system/integrations", label: "Integrations", icon: Webhook },
    { href: "/system/jobs", label: "Jobs & Runtime", icon: Workflow }
  ]}
];

function useLoad<T>(path: string | null, refresh = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(path));
  const load = useCallback(async () => {
    if (!path) { setData(null); setLoading(false); return; }
    setLoading(true);
    try { setData(await api<T>(path)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Data could not be loaded."); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void load(); }, [load, refresh]);
  return { data, error, loading, reload: load };
}

function fmtDate(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function fmtMoney(value?: number | string | null) {
  if (value == null || value === "") return "—";
  return new Intl.NumberFormat("en-US").format(Number(value)) + " VND";
}

function cx(...values: Array<string | false | null | undefined>) { return values.filter(Boolean).join(" "); }

function Badge({ value, tone }: { value: string; tone?: string }) {
  const normalized = String(value ?? "").toLowerCase();
  const color = tone ?? (/(active|ready|published|passed|bot|resolved|healthy|completed|live)/.test(normalized)
    ? "green" : /(failed|urgent|breached|human|rejected|archived)/.test(normalized)
      ? "red" : /(queued|draft|new|pending|review|test)/.test(normalized) ? "amber" : "slate");
  return <span className={`badge ${color}`}><span className="badge-dot" />{String(value).replaceAll("_", " ")}</span>;
}

function Empty({ icon: Icon = Database, title = "No data yet", body = "Records will appear here when the system receives them." }) {
  return <div className="empty"><Icon size={30} /><strong>{title}</strong><p>{body}</p></div>;
}

function LoadState({ loading, error, children }: { loading: boolean; error: string; children: ReactNode }) {
  if (loading) return <div className="loading"><span /><span /><span /></div>;
  if (error) return <div className="error-box"><AlertTriangle size={18} />{error}</div>;
  return <>{children}</>;
}

function Header({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

/**
 * Chế độ vận hành thật, đọc từ API. Trước đây chỗ này là chuỗi hard-code
 * "Local Docker stack" — không phản ánh môi trường và vi phạm yêu cầu 5.16
 * ("người dùng luôn biết mình đang ở môi trường nào").
 */
const MODE_LABEL: Record<string, { text: string; tone: string }> = {
  DEMO: { text: "DEMO · không gửi ra ngoài", tone: "amber" },
  TEST: { text: "TEST · không gửi ra ngoài", tone: "amber" },
  STAGING: { text: "STAGING", tone: "violet" },
  PRODUCTION: { text: "PRODUCTION · gửi thật", tone: "red" }
};

function EnvironmentBadge() {
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => {
    api<Row>("/health").then((data) => setMode(String(data.runtime_mode ?? ""))).catch(() => setMode(null));
  }, []);
  if (!mode) return null;
  const info = MODE_LABEL[mode] ?? { text: mode, tone: "slate" };
  return <div className={`environment env-${info.tone}`} title={`Chế độ vận hành: ${mode}`}><span className="env-dot" />{info.text}</div>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("admin@tm.local");
  const [password, setPassword] = useState("Admin@123");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { onLogin(await post<User>("/auth/login", { email, password })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }
  return <main className="login-page">
    <section className="login-story">
      <div className="brand large"><span className="brand-mark"><Sparkles size={22} /></span><span>TM Academy<small>AI Operations</small></span></div>
      <div className="story-copy"><div className="eyebrow light">AI OPERATIONS PLATFORM</div><h1>Every conversation.<br />One source of truth.</h1><p>Operate Messenger conversations, structured knowledge, documents, and controlled AI releases in one auditable workspace.</p></div>
      <div className="story-metrics"><div><strong>2</strong><span>isolated inbox environments</span></div><div><strong>100%</strong><span>traceable decisions</span></div><div><strong>0</strong><span>secrets in workflows</span></div></div>
    </section>
    <section className="login-panel"><form className="login-card" onSubmit={submit}>
      <div className="mobile-brand brand"><span className="brand-mark"><Sparkles size={19} /></span><span>TM Academy<small>AI Operations</small></span></div>
      <div><span className="kicker">INTERNAL WORKSPACE</span><h2>Welcome back</h2><p>Sign in to operate the platform.</p></div>
      <label>Email<input aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" /></label>
      <label>Password<input aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" /></label>
      {error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}
      <button className="button primary full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <div className="demo-note"><ShieldCheck size={18} /><span><strong>Local trial mode</strong><br />The workspace includes a seeded administrator account and sample data.</span></div>
    </form></section>
  </main>;
}

export function Platform() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [mobileNav, setMobileNav] = useState(false);
  const [live, setLive] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => { api<User | null>("/auth/me").then(setUser).catch(() => setUser(null)); }, []);
  useEffect(() => {
    if (!user) return;
    const source = new EventSource(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1"}/events`, { withCredentials: true });
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = () => window.dispatchEvent(new CustomEvent("tm-data-changed"));
    return () => source.close();
  }, [user]);
  if (user === undefined) return <div className="boot"><span className="brand-mark"><Sparkles /></span><p>Starting workspace…</p></div>;
  if (!user) return <Login onLogin={(value) => { setUser(value); router.push("/"); }} />;
  const active = pathname === "/login" ? "/" : pathname;
  async function logout() { await post("/auth/logout"); setUser(null); }
  const pageLabel = nav.flatMap((section) => section.items).find((item) => active === item.href || active.startsWith(`${item.href}/`) || (active === "/knowledge" && item.href === "/knowledge/tables"))?.label ?? "Workspace";
  return <div className="app-shell">
    <aside className={cx("sidebar", mobileNav && "open")}>
      <div className="brand"><span className="brand-mark"><Sparkles size={19} /></span><span>TM Academy<small>AI Operations</small></span><button className="icon mobile-close" onClick={() => setMobileNav(false)}><X /></button></div>
      <nav>{nav.map((section) => <section key={section.label}><h3>{section.label}</h3>{section.items.map(({ href, label, icon: Icon }) => <Link onClick={() => setMobileNav(false)} className={cx("nav-link", (active === href || active.startsWith(`${href}/`) || (active === "/knowledge" && href === "/knowledge/tables")) && "active")} href={href} key={href}><Icon size={18} /><span>{label}</span></Link>)}</section>)}</nav>
      <div className="sidebar-foot"><EnvironmentBadge /><div className="user-card"><span className="avatar">{user.displayName.slice(0, 2)}</span><span><strong>{user.displayName}</strong><small>{user.roles[0] ?? "platform-admin"}</small></span><button title="Sign out" className="icon" onClick={logout}><LogOut size={17} /></button></div></div>
    </aside>
    {mobileNav && <button aria-label="Close menu" className="scrim" onClick={() => setMobileNav(false)} />}
    <main className="main"><div className="topbar"><button aria-label="Open menu" className="icon menu" onClick={() => setMobileNav(true)}><Menu /></button><div className="breadcrumb"><span>TM Academy</span><ChevronRight size={14} /><strong>{pageLabel}</strong></div><div className="top-actions"><div className={cx("connection", live && "online")}><span />{live ? "Realtime connected" : "Connecting"}</div><button className="icon" aria-label="Search"><Search size={18} /></button><button className="icon notification" aria-label="Notifications"><Bell size={18} /><i /></button></div></div>
      <div className="content"><RouteView path={active} /></div>
    </main>
  </div>;
}

function RouteView({ path }: { path: string }) {
  if (path === "/" || path === "/dashboard") return <Dashboard />;
  if (path === "/conversations") return <Conversations />;
  if (path === "/cases") return <Cases />;
  if (path === "/contacts") return <Contacts />;
  if (path === "/knowledge" || path === "/knowledge/tables" || path === "/courses" || path === "/pricing") return <KnowledgeHub tableCode={path === "/pricing" ? "pricing-rules" : path === "/courses" ? "course-catalog" : undefined} />;
  if (path.startsWith("/knowledge/tables/")) return <KnowledgeHub tableCode={decodeURIComponent(path.slice("/knowledge/tables/".length))} />;
  if (path === "/knowledge/documents") return <DocumentsPage />;
  if (path === "/studio/flows") return <FlowStudio />;
  if (path === "/studio/prompts") return <StudioPrompts />;
  if (path === "/studio/rules") return <StudioRules />;
  if (path === "/studio/evaluations") return <Evaluations />;
  if (path === "/studio/releases") return <Releases />;
  if (path === "/system/integrations") return <Integrations />;
  if (path === "/system/jobs") return <Jobs />;
  return <Empty title="Page not found" body="This route does not belong to the current workspace." />;
}

function Dashboard() {
  const { data, loading, error } = useLoad<Row>("/dashboard/summary");
  return <><Header eyebrow="OPERATIONS CENTER" title="Good day, Admin" description="Monitor conversations, handovers, runtime health, and AI release quality from one place." actions={<Link href="/conversations" className="button primary"><MessagesSquare size={17} />Open inbox</Link>} />
    <LoadState loading={loading} error={error}>{data && <>
      <div className="metric-grid">
        <Metric label="Conversations" value={data.conversations.total} hint={`${data.conversations.unread} unread`} icon={<MessagesSquare />} tone="violet" />
        <Metric label="Bot active" value={data.conversations.bot_active} hint={`${data.conversations.human_active} in human mode`} icon={<Bot />} tone="blue" />
        <Metric label="Open cases" value={data.cases.open} hint={`${data.cases.unassigned} unassigned`} icon={<Inbox />} tone="amber" />
        <Metric label="SLA risk" value={Number(data.cases.breached) + Number(data.cases.due_soon)} hint={`${data.cases.breached} breached`} icon={<Clock3 />} tone="red" />
      </div>
      <div className="dashboard-grid"><section className="card health-card"><CardTitle title="System health" subtitle="Current runtime state" icon={<Activity />} />
        <div className="health-rows"><Health label="API & PostgreSQL" value="Healthy" ok /><Health label="Worker queue" value={`${data.jobs.queued} queued`} ok={!data.jobs.failed} /><Health label="Knowledge index" value={`${data.documents.total} documents`} ok={!data.documents.failed} /><Health label="Active release" value={data.release?.release_code ?? "Not activated"} ok={Boolean(data.release)} /></div>
      </section><section className="card"><CardTitle title="Attention needed" subtitle="Ordered by severity" icon={<AlertTriangle />} />{data.notifications?.length ? <div className="notification-list">{data.notifications.map((item: Row) => <div key={item.id}><span className={`severity ${item.severity}`}><AlertTriangle size={16} /></span><div><strong>{item.title}</strong><p>{item.body}</p></div><time>{fmtDate(item.created_at)}</time></div>)}</div> : <Empty icon={CheckCircle2} title="No alerts" body="All monitored flows are stable." />}</section></div>
      <section className="card quick"><CardTitle title="Quick actions" subtitle="Common operating tasks" /><div className="quick-grid"><Quick href="/conversations" icon={<MessagesSquare />} title="Test a conversation" body="Use the isolated AI workspace" /><Quick href="/knowledge/tables" icon={<Table2 />} title="Manage structured data" body="Tables, records, and CSV imports" /><Quick href="/knowledge/documents" icon={<FileText />} title="Manage documents" body="Upload, review, publish, and search" /><Quick href="/studio/evaluations" icon={<FlaskConical />} title="Run evaluation" body="Regression gate before release" /></div></section>
    </>}</LoadState></>;
}

function Metric({ label, value, hint, icon, tone }: { label: string; value: any; hint: string; icon: ReactNode; tone: string }) { return <section className="metric card"><span className={`metric-icon ${tone}`}>{icon}</span><div><span>{label}</span><strong>{value ?? 0}</strong><small>{hint}</small></div></section>; }
function CardTitle({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: ReactNode }) { return <div className="card-title"><div>{icon}<span><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span></div></div>; }
function Health({ label, value, ok }: { label: string; value: string; ok: boolean }) { return <div><span><i className={ok ? "ok" : "warn"} />{label}</span><strong>{value}</strong></div>; }
function Quick({ href, icon, title, body }: { href: string; icon: ReactNode; title: string; body: string }) { return <Link href={href}>{icon}<span><strong>{title}</strong><small>{body}</small></span><ChevronRight size={17} /></Link>; }

function Conversations() {
  const [environment, setEnvironment] = useState<Environment>("test");
  const [selected, setSelected] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const path = useMemo(() => `/conversations?environment=${environment}${search ? `&search=${encodeURIComponent(search)}` : ""}`, [environment, search]);
  const { data: list, loading, error } = useLoad<Row[]>(path, refresh);
  useEffect(() => { setSelected(null); }, [environment]);
  useEffect(() => { if (!selected && list?.[0]) setSelected(list[0].id); }, [list, selected]);
  useEffect(() => { const changed = () => setRefresh((value) => value + 1); window.addEventListener("tm-data-changed", changed); return () => window.removeEventListener("tm-data-changed", changed); }, []);
  const detail = useLoad<Row>(selected ? `/conversations/${selected}` : null, refresh);
  const [message, setMessage] = useState("");
  const [simText, setSimText] = useState("What is the tuition fee for Digital Performance?");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  async function act(actionPath: string, body?: unknown) {
    if (!selected) return;
    setBusy(true); setActionError("");
    try { await post(actionPath, body); setRefresh((value) => value + 1); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "The action failed."); }
    finally { setBusy(false); }
  }
  async function send(event: FormEvent) { event.preventDefault(); if (!message.trim() || !selected) return; await act(`/conversations/${selected}/messages`, { text: message }); setMessage(""); }
  async function simulate() {
    setBusy(true); setActionError("");
    try {
      const result = await post<Row>("/dev/simulate-message", { externalUserId: `demo-ui-${Date.now()}`, displayName: "UI Test Customer", text: simText });
      setSelected(result.conversationId); setRefresh((value) => value + 1);
      window.setTimeout(() => setRefresh((value) => value + 1), 3500);
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "The test message failed."); }
    finally { setBusy(false); }
  }
  return <><Header eyebrow="UNIFIED CONVERSATION OPERATIONS" title="Conversations" description="Review the combined customer and AI timeline without mixing test traffic into the live Messenger inbox." actions={<button className="button ghost" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} />Refresh</button>} />
    <div className="tabs button-tabs"><button className={environment === "live" ? "active" : ""} onClick={() => setEnvironment("live")}><span className="live-dot" />Live Inbox</button><button className={environment === "test" ? "active" : ""} onClick={() => setEnvironment("test")}><FlaskConical size={14} />Test Workspace</button></div>
    {actionError && <div className="error-box page-error"><AlertTriangle size={17} />{actionError}</div>}
    <div className="inbox-layout"><section className="card thread-list"><div className="inbox-tools"><div className="search"><Search size={16} /><input aria-label="Search conversations" placeholder="Search names or messages…" value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
      <LoadState loading={loading} error={error}>{list?.length ? list.map((row) => <button key={row.id} onClick={() => setSelected(row.id)} className={cx("thread", selected === row.id && "selected")}><span className="avatar contact">{(row.contact_name ?? "C").slice(0, 2).toUpperCase()}</span><span className="thread-main"><span><strong>{row.contact_name}</strong><time>{fmtDate(row.last_message_at)}</time></span><small>{row.last_message ?? "No message content"}</small><span className="thread-tags"><Badge value={row.bot_mode} />{row.course_name && <em>{row.course_name}</em>}</span></span>{row.unread_count > 0 && <b className="unread">{row.unread_count}</b>}</button>) : <Empty icon={MessagesSquare} title={environment === "test" ? "No test conversations" : "No live conversations"} body={environment === "test" ? "Send a test message from the panel on the right." : "Messages accepted by the n8n or Meta webhook will appear here."} />}</LoadState>
    </section><section className="card conversation-pane"><LoadState loading={detail.loading} error={detail.error}>{detail.data ? <><div className="conversation-head"><div><span className="avatar contact">{(detail.data.contact_name ?? "C").slice(0, 2).toUpperCase()}</span><span><strong>{detail.data.contact_name}</strong><small>{detail.data.channel_name} · {detail.data.current_state}</small></span></div><div><Badge value={detail.data.environment} /><Badge value={detail.data.bot_mode} /><button disabled={busy} className="button small" onClick={() => detail.data?.bot_mode === "bot" ? act(`/conversations/${selected}/takeover`, { reasonCode: "MANUAL_TAKEOVER", priority: "normal" }) : act(`/conversations/${selected}/release`, { targetState: "QUALIFICATION" })}>{detail.data.bot_mode === "bot" ? "Take over" : "Return to bot"}</button></div></div>
        <div className="messages">{detail.data.messages?.map((item: Row) => <div key={item.id} className={cx("message", item.direction === "outbound" && "outbound")}><span className="sender-icon">{item.sender_type === "bot" ? <Bot size={15} /> : item.sender_type === "customer" ? <UserRound size={15} /> : <MessageSquareText size={15} />}</span><div><p>{item.raw_text}</p><small>{item.sender_type} · {fmtDate(item.created_at)} · {item.status}</small></div></div>)}</div>
        <form className="composer" onSubmit={send}><textarea aria-label="Agent reply" value={message} onChange={(event) => setMessage(event.target.value)} placeholder={detail.data.bot_mode === "human" ? "Write an agent reply…" : "Take over before sending an agent reply…"} disabled={detail.data.bot_mode !== "human"} /><button aria-label="Send reply" className="button primary square" disabled={busy || detail.data.bot_mode !== "human"}><Send size={18} /></button></form>
      </> : <Empty icon={MessageSquareText} title="Select a conversation" body="The combined customer and AI timeline will appear here." />}</LoadState></section>
      <aside className="card context-pane">{environment === "test" ? <><CardTitle title="AI test message" subtitle="Uses the production processing pipeline" icon={<Bot />} /><label>Customer message<textarea aria-label="Test customer message" value={simText} onChange={(event) => setSimText(event.target.value)} /></label><button disabled={busy || !simText.trim()} onClick={simulate} className="button primary full"><Send size={16} />Send test inbound</button><div className="guardrails"><strong>Active safeguards</strong><span><ShieldCheck size={15} />Pricing is grounded in typed rules</span><span><ShieldCheck size={15} />Payment risks trigger handover</span><span><ShieldCheck size={15} />Messages are idempotent</span></div></> : <><CardTitle title="Live traffic" subtitle="n8n bridge or direct Meta webhook" icon={<Webhook />} /><p className="context-copy">This inbox only contains messages received from live webhook endpoints. Use the Integrations page to copy the URL and test the bridge.</p><Link href="/system/integrations" className="button full"><Webhook size={16} />Open integrations</Link></>}{detail.data && <div className="facts"><h4>Conversation context</h4><dl><dt>Segment</dt><dd>{detail.data.segment ?? "Unknown"}</dd><dt>Course interest</dt><dd>{detail.data.course_name ?? "Not identified"}</dd><dt>Open cases</dt><dd>{detail.data.cases?.filter((item: Row) => item.status !== "resolved").length ?? 0}</dd><dt>AI traces</dt><dd>{detail.data.traces?.length ?? 0}</dd></dl></div>}</aside></div></>;
}

function Cases() {
  const [status, setStatus] = useState("");
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useLoad<Row[]>(`/cases${status ? `?status=${status}` : ""}`, refresh);
  async function resolve(row: Row) { await patch(`/cases/${row.id}`, { status: "resolved", resolutionCode: "HANDLED", resolutionSummary: "Resolved in AI Operations", version: row.version }); setRefresh((value) => value + 1); }
  return <><Header eyebrow="HUMAN HANDOVER" title="Handover Cases" description="A centralized queue with SLA, assignment, reason codes, and optimistic locking." actions={<select aria-label="Case status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="new">New</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option></select>} />
    <section className="card table-card"><LoadState loading={loading} error={error}>{data?.length ? <table><thead><tr><th>Customer</th><th>Reason</th><th>Priority</th><th>Status</th><th>SLA remaining</th><th>Assignee</th><th /></tr></thead><tbody>{data.map((row) => <tr key={row.id}><td><strong>{row.contact_name}</strong><small>{row.current_state}</small></td><td>{row.reason_code}<small>{row.handover_note}</small></td><td><Badge value={row.priority} /></td><td><Badge value={row.status} /></td><td className={row.sla_seconds_remaining < 900 ? "danger-text" : ""}>{Math.floor((row.sla_seconds_remaining ?? 0) / 60)} minutes</td><td>{row.assignee_name ?? "Unassigned"}</td><td>{row.status !== "resolved" && <button className="button small" onClick={() => resolve(row)}>Resolve</button>}</td></tr>)}</tbody></table> : <Empty icon={CheckCircle2} title="Queue is clear" body="No cases match the current filter." />}</LoadState></section></>;
}

function Contacts() {
  const { data, loading, error } = useLoad<Row[]>("/contacts");
  return <><Header eyebrow="CUSTOMER 360" title="Customers" description="Unified profiles from Messenger identities, conversations, and handover history." /><section className="card table-card"><LoadState loading={loading} error={error}>{data?.length ? <table><thead><tr><th>Customer</th><th>Segment</th><th>Tags</th><th>Conversations</th><th>Cases</th><th>Last activity</th></tr></thead><tbody>{data.map((row) => <tr key={row.id}><td><div className="cell-person"><span className="avatar contact">{(row.display_name ?? "C").slice(0, 2)}</span><span><strong>{row.display_name}</strong><small>{row.phone ?? row.email ?? "Messenger identity"}</small></span></div></td><td>{row.segment ?? "Unclassified"}</td><td>{row.tags?.map((tag: string) => <span className="tag" key={tag}>{tag}</span>)}</td><td>{row.conversation_count}</td><td>{row.case_count}</td><td>{fmtDate(row.last_activity_at)}</td></tr>)}</tbody></table> : <Empty icon={Users} />}</LoadState></section></>;
}

type StructuredColumn = { key: string; label: string; type: "text" | "long_text" | "number" | "currency" | "boolean" | "date" | "list" | "status"; required?: boolean; options?: string[] };

function KnowledgeModuleNav({ active }: { active: "documents" | "tables" }) {
  return <div className="module-switch" aria-label="Knowledge modules">
    <Link className={active === "documents" ? "active" : ""} href="/knowledge/documents"><span className="module-icon"><FileText /></span><span><strong>Documents</strong><small>Files, revisions, extraction, and semantic search</small></span></Link>
    <Link className={active === "tables" ? "active" : ""} href="/knowledge/tables"><span className="module-icon"><Table2 /></span><span><strong>Structured Data</strong><small>Scalable typed tables, records, and CSV imports</small></span></Link>
  </div>;
}

function KnowledgeHub({ tableCode }: { tableCode?: string }) {
  const [refresh, setRefresh] = useState(0);
  const { data: tables, loading, error } = useLoad<Row[]>("/structured/tables", refresh);
  const [creating, setCreating] = useState(false);
  const table = tables?.find((item) => item.code === tableCode);
  if (tableCode) return <>
    <LoadState loading={loading} error={error}>{table ? <StructuredWorkspace table={table} tables={tables ?? []} onCreateTable={() => setCreating(true)} onRegistryChanged={() => setRefresh((value) => value + 1)} /> : !loading ? <Empty icon={Table2} title="Table not found" body="This table may have been archived or renamed." /> : null}</LoadState>
    {creating && <CreateTableModal close={() => setCreating(false)} done={() => { setCreating(false); setRefresh((value) => value + 1); }} />}
  </>;
  return <>
    <Header eyebrow="KNOWLEDGE / STRUCTURED DATA" title="Structured Data" description="Create independent typed tables, manage records, and import CSV sources without hard-coding future datasets." actions={<button className="button primary" onClick={() => setCreating(true)}><Plus size={17} />New table</button>} />
    <KnowledgeModuleNav active="tables" />
    <div className="section-heading"><div><h2>Data tables</h2><p>Each table owns its schema, primary key, import history, validation, and record lifecycle.</p></div><span>{tables?.length ?? 0} tables</span></div>
    <LoadState loading={loading} error={error}>{tables?.length ? <div className="dataset-grid">{tables.map((item) => <Link className="dataset-card card" href={`/knowledge/tables/${encodeURIComponent(item.code)}`} key={item.id}><div className="dataset-card-head"><span className={cx("dataset-icon", item.adapter !== "generic_json" && "built-in")}>{item.adapter === "course_catalog" ? <GraduationCap /> : item.adapter === "pricing_rules" ? <BadgeDollarSign /> : <Table2 />}</span><Badge value={item.adapter === "generic_json" ? item.status : "built in"} /></div><h3>{item.name}</h3><p>{item.description}</p><div className="dataset-metrics"><span><strong>{item.record_count}</strong>records</span><span><strong>{item.schema_definition?.columns?.length ?? 0}</strong>columns</span><span><strong>{item.import_count}</strong>imports</span></div><div className="dataset-footer"><small>{item.last_import_at ? `Last import ${fmtDate(item.last_import_at)}` : "No imports yet"}</small><ChevronRight /></div></Link>)}</div> : <Empty icon={Table2} title="No structured tables" body="Create a table with a typed schema, then add records or import a CSV file." />}</LoadState>
    {creating && <CreateTableModal close={() => setCreating(false)} done={() => { setCreating(false); setRefresh((value) => value + 1); }} />}
  </>;
}

function CreateTableModal({ close, done }: { close: () => void; done: () => void }) {
  const [name, setName] = useState(""); const [code, setCode] = useState(""); const [description, setDescription] = useState("");
  const [primaryKey, setPrimaryKey] = useState("record_id");
  const [columns, setColumns] = useState<StructuredColumn[]>([{ key: "record_id", label: "Record ID", type: "text", required: true }, { key: "name", label: "Name", type: "text", required: true }]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  function updateColumn(index: number, field: keyof StructuredColumn, value: any) { setColumns((current) => current.map((column, position) => position === index ? { ...column, [field]: value } : column)); }
  function syncName(value: string) { setName(value); if (!code) setCode(value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await post("/structured/tables", { name, code, description: description || null, definition: { primaryKey, columns } }); done(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The table could not be created."); }
    finally { setBusy(false); }
  }
  return <div className="modal-wrap"><button aria-label="Close" className="modal-scrim" onClick={close} /><form className="modal schema-modal" onSubmit={submit}><div className="modal-head"><div><h2>Create a structured table</h2><p>Define a reusable schema now. Records and future CSV files are validated against it.</p></div><button type="button" className="icon" onClick={close}><X /></button></div>
    <div className="form-grid"><label>Table name<input required value={name} onChange={(event) => syncName(event.target.value)} placeholder="Campus locations" /></label><label>Stable code<input required pattern="[a-z][a-z0-9-]+" value={code} onChange={(event) => setCode(event.target.value.toLowerCase())} placeholder="campus-locations" /></label><label className="wide">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this table controls and where the data comes from." /></label></div>
    <div className="schema-builder-head"><div><strong>Columns</strong><small>Use stable machine keys; labels can be changed later.</small></div><button type="button" className="button small" onClick={() => setColumns((current) => [...current, { key: `field_${current.length + 1}`, label: `Field ${current.length + 1}`, type: "text" }])}><Plus size={14} />Add column</button></div>
    <div className="schema-builder"><div className="schema-row schema-labels"><span>Label</span><span>Key</span><span>Type</span><span>Required</span><span /></div>{columns.map((column, index) => <div className="schema-row" key={`${column.key}-${index}`}><input aria-label={`Column ${index + 1} label`} required value={column.label} onChange={(event) => updateColumn(index, "label", event.target.value)} /><input aria-label={`Column ${index + 1} key`} required pattern="[a-z][a-z0-9_]*" value={column.key} onChange={(event) => { const nextKey = event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"); if (column.key === primaryKey) setPrimaryKey(nextKey); updateColumn(index, "key", nextKey); }} /><select aria-label={`Column ${index + 1} type`} value={column.type} onChange={(event) => updateColumn(index, "type", event.target.value)}><option value="text">Text</option><option value="long_text">Long text</option><option value="number">Number</option><option value="currency">Currency</option><option value="boolean">Boolean</option><option value="date">Date</option><option value="list">List</option><option value="status">Status</option></select><label className="check-label"><input type="checkbox" checked={Boolean(column.required)} onChange={(event) => updateColumn(index, "required", event.target.checked)} /><span>Required</span></label><button aria-label={`Remove ${column.label}`} type="button" className="icon table-action danger" disabled={columns.length <= 1 || column.key === primaryKey} onClick={() => setColumns((current) => current.filter((_, position) => position !== index))}><Trash2 size={15} /></button></div>)}</div>
    <label>Primary key<select value={primaryKey} onChange={(event) => { setPrimaryKey(event.target.value); setColumns((current) => current.map((column) => column.key === event.target.value ? { ...column, required: true } : column)); }}>{columns.map((column) => <option value={column.key} key={column.key}>{column.label} ({column.key})</option>)}</select></label>
    {error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button disabled={busy} className="button primary">{busy ? "Creating…" : "Create table"}</button></div></form></div>;
}

async function uploadTableCsv(code: string, file: File) {
  const form = new FormData(); form.append("file", file);
  const response = await fetch(`${API_URL}/structured/tables/${encodeURIComponent(code)}/import`, { method: "POST", credentials: "include", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload?.error?.code ?? "IMPORT_FAILED", payload?.error?.message ?? "CSV import failed.", payload?.error?.details);
  return payload.data as Row;
}

function GenericTable({ table, onChanged }: { table: Row; onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0); const [q, setQ] = useState(""); const [editing, setEditing] = useState<Row | null | undefined>(undefined);
  const { data, loading, error } = useLoad<Row>(`/structured/tables/${encodeURIComponent(table.code)}/records${q ? `?q=${encodeURIComponent(q)}` : ""}`, refresh);
  const [importResult, setImportResult] = useState<Row | null>(null); const [importError, setImportError] = useState(""); const [busy, setBusy] = useState(false);
  const columns = (table.schema_definition?.columns ?? []) as StructuredColumn[];
  async function archiveRecord(row: Row) { if (!window.confirm("Archive this record? It will no longer be returned by this table.")) return; await remove(`/structured/tables/${table.code}/records/${row.id}`); setRefresh((value) => value + 1); }
  async function archiveTable() { if (!window.confirm(`Archive ${table.name}? Records will remain in the audit history.`)) return; setBusy(true); try { await remove(`/structured/tables/${table.code}`); onChanged(); window.location.href = "/knowledge/tables"; } finally { setBusy(false); } }
  async function choose(event: React.ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; setBusy(true); setImportError(""); try { setImportResult(await uploadTableCsv(table.code, file)); setRefresh((value) => value + 1); } catch (reason) { setImportError(reason instanceof Error ? reason.message : "CSV import failed."); } finally { setBusy(false); event.target.value = ""; } }
  return <><div className="table-summary card"><div><span className="dataset-icon"><Table2 /></span><span><strong>{data?.total ?? table.record_count} active records</strong><small>{columns.length} typed columns · primary key {table.schema_definition?.primaryKey}</small></span></div><div className="page-actions"><label className="button primary upload-button"><Upload size={16} />{busy ? "Working…" : "Import CSV"}<input aria-label={`Import ${table.name} CSV`} type="file" accept=".csv,text/csv" disabled={busy} onChange={choose} /></label><button className="button" onClick={() => setEditing(null)}><Plus size={16} />Add record</button><button className="button danger-button" disabled={busy} onClick={archiveTable}><Trash2 size={15} />Archive table</button></div></div>
    <ImportResult result={importResult} error={importError} />
    <div className="section-toolbar"><div><h2>Records</h2><p>Changes are validated against the current schema and recorded in the audit log.</p></div><div className="search compact-search"><Search size={16} /><input aria-label="Search table records" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search records…" /></div></div>
    <section className="card table-card"><LoadState loading={loading} error={error}>{data?.records?.length ? <table><thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}<th>Updated</th><th>Actions</th></tr></thead><tbody>{data.records.map((row: Row) => <tr key={row.id}>{columns.map((column) => <td key={column.key}>{column.type === "currency" ? fmtMoney(row.data?.[column.key]) : column.type === "boolean" ? (row.data?.[column.key] ? "Yes" : "No") : Array.isArray(row.data?.[column.key]) ? row.data[column.key].join(", ") : String(row.data?.[column.key] ?? "—")}</td>)}<td>{fmtDate(row.updated_at)}</td><td><div className="row-actions"><button aria-label="Edit record" className="icon table-action" onClick={() => setEditing(row)}><Pencil size={15} /></button><button aria-label="Archive record" className="icon table-action danger" onClick={() => archiveRecord(row)}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table> : <Empty icon={Table2} title="No records" body="Add a record manually or import a CSV with column headers matching the schema keys." />}</LoadState></section>
    {editing !== undefined && <GenericRecordModal table={table} record={editing} close={() => setEditing(undefined)} done={() => { setEditing(undefined); setRefresh((value) => value + 1); }} />}
  </>;
}

function GenericRecordModal({ table, record, close, done }: { table: Row; record: Row | null; close: () => void; done: () => void }) {
  const columns = (table.schema_definition?.columns ?? []) as StructuredColumn[];
  const [form, setForm] = useState<Record<string, any>>(() => Object.fromEntries(columns.map((column) => [column.key, record?.data?.[column.key] ?? (column.type === "boolean" ? false : "")])));
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { record ? await patch(`/structured/tables/${table.code}/records/${record.id}`, form) : await post(`/structured/tables/${table.code}/records`, form); done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The record could not be saved."); } finally { setBusy(false); } }
  return <div className="modal-wrap"><button aria-label="Close" className="modal-scrim" onClick={close} /><form className="modal wide-modal" onSubmit={submit}><div className="modal-head"><div><h2>{record ? "Edit record" : "Add record"}</h2><p>{table.name} validates every value against its reusable table schema.</p></div><button type="button" className="icon" onClick={close}><X /></button></div><div className="form-grid">{columns.map((column) => <label className={column.type === "long_text" ? "wide" : ""} key={column.key}>{column.label}{column.type === "long_text" ? <textarea required={column.required} value={form[column.key]} onChange={(event) => setForm((current) => ({ ...current, [column.key]: event.target.value }))} /> : column.type === "boolean" ? <select value={String(form[column.key])} onChange={(event) => setForm((current) => ({ ...current, [column.key]: event.target.value === "true" }))}><option value="false">No</option><option value="true">Yes</option></select> : <input required={column.required} type={column.type === "number" || column.type === "currency" ? "number" : column.type === "date" ? "date" : "text"} value={Array.isArray(form[column.key]) ? form[column.key].join(", ") : form[column.key]} onChange={(event) => setForm((current) => ({ ...current, [column.key]: event.target.value }))} />}</label>)}</div>{error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button disabled={busy} className="button primary">{busy ? "Saving…" : "Save record"}</button></div></form></div>;
}

async function uploadCsv(type: "courses" | "pricing", file: File) {
  const form = new FormData(); form.append("file", file);
  const response = await fetch(`${API_URL}/structured-data/import?type=${type}`, { method: "POST", credentials: "include", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload?.error?.code ?? "IMPORT_FAILED", payload?.error?.message ?? "CSV import failed.", payload?.error?.details);
  return payload.data as Row;
}

function ImportControl({ type, onDone, onError }: { type: "courses" | "pricing"; onDone: (result: Row) => void; onError?: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true);
    try { onError?.(""); onDone(await uploadCsv(type, file)); }
    catch (reason) { onError?.(reason instanceof Error ? reason.message : "CSV import failed."); }
    finally { setBusy(false); event.target.value = ""; }
  }
  return <label className="button primary upload-button"><Upload size={16} />{busy ? "Importing…" : "Import CSV"}<input aria-label={`Import ${type} CSV`} type="file" accept=".csv,text/csv" disabled={busy} onChange={choose} /></label>;
}

function ImportResult({ result, error }: { result: Row | null; error: string }) {
  if (error) return <div className="error-box"><AlertTriangle size={17} />{error}</div>;
  if (!result) return null;
  const summary = result.summary ?? {};
  return <div className="success-box"><CheckCircle2 size={18} /><span><strong>{result.filename} imported successfully</strong>{summary.inserted} inserted · {summary.updated} updated · {summary.skipped} skipped · {summary.errors} errors</span></div>;
}

function Courses() {
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useLoad<Row[]>("/courses", refresh);
  const [editing, setEditing] = useState<Row | null | undefined>(undefined);
  const [importResult, setImportResult] = useState<Row | null>(null);
  const [importError, setImportError] = useState("");
  async function archive(row: Row) {
    if (!window.confirm(`Archive ${row.name}? Its offerings and pricing rules will also be archived.`)) return;
    await remove(`/courses/${row.id}`); setRefresh((value) => value + 1);
  }
  return <><div className="section-toolbar"><div><h2>Course facts</h2><p>Typed fields used by the AI pipeline, including aliases, schedules, audience, curriculum, and policies.</p></div><div><ImportControl type="courses" onError={setImportError} onDone={(result) => { setImportError(""); setImportResult(result); setRefresh((value) => value + 1); }} /><button className="button" onClick={() => setEditing(null)}><Plus size={16} />Add course</button></div></div>
    <ImportResult result={importResult} error={importError} />
    <section className="card table-card"><LoadState loading={loading} error={error}>{data?.length ? <table><thead><tr><th>Code</th><th>Course</th><th>Category / Type</th><th>Delivery</th><th>Next start</th><th>Aliases</th><th>Pricing</th><th>Status</th><th>Actions</th></tr></thead><tbody>{data.map((row) => <tr key={row.id}><td><code>{row.code}</code></td><td><strong>{row.name}</strong><small>{row.description}</small></td><td>{row.category ?? "—"}<small>{row.facts?.course_type ?? "—"}</small></td><td>{row.facts?.learning_modes?.join(", ") || "—"}<small>{row.facts?.offline_regions?.join(", ")}</small></td><td>{row.facts?.next_start_date ?? "—"}<small>{row.facts?.schedule_detail}</small></td><td>{row.aliases?.slice(0, 3).map((alias: string) => <span className="tag" key={alias}>{alias}</span>)}</td><td>{row.pricing_rule_count}</td><td><Badge value={row.status} /></td><td><div className="row-actions"><button aria-label={`Edit ${row.name}`} className="icon table-action" onClick={() => setEditing(row)}><Pencil size={15} /></button><button aria-label={`Delete ${row.name}`} className="icon table-action danger" onClick={() => archive(row)}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table> : <Empty icon={GraduationCap} title="No active courses" body="Import the provided course CSV or add a course manually." />}</LoadState></section>
    {editing !== undefined && <CourseModal course={editing} close={() => setEditing(undefined)} done={() => { setEditing(undefined); setRefresh((value) => value + 1); }} />}
  </>;
}

function CourseModal({ course, close, done }: { course: Row | null; close: () => void; done: () => void }) {
  const facts = course?.facts ?? {};
  const [form, setForm] = useState({
    code: course?.code ?? "", name: course?.name ?? "", category: course?.category ?? "", description: course?.description ?? "",
    aliases: course?.aliases?.join(", ") ?? "", courseType: facts.course_type ?? "", learningModes: facts.learning_modes?.join(", ") ?? "",
    offlineRegions: facts.offline_regions?.join(", ") ?? "", nextStartDate: facts.next_start_date ?? "", scheduleDetail: facts.schedule_detail ?? "",
    audienceProfile: facts.audience_profile ?? "", curriculumText: facts.curriculum_text ?? "", status: course?.status ?? "active"
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function change(name: string, value: string) { setForm((current) => ({ ...current, [name]: value })); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const payload = {
      code: form.code, name: form.name, category: form.category || null, description: form.description || null,
      aliases: String(form.aliases).split(",").map((item: string) => item.trim()).filter(Boolean), courseType: form.courseType || null,
      learningModes: String(form.learningModes).split(",").map((item: string) => item.trim()).filter(Boolean),
      offlineRegions: String(form.offlineRegions).split(",").map((item: string) => item.trim()).filter(Boolean),
      nextStartDate: form.nextStartDate || null, scheduleDetail: form.scheduleDetail || null,
      audienceProfile: form.audienceProfile || null, curriculumText: form.curriculumText || null, status: form.status
    };
    try {
      if (course) await patch(`/courses/${course.id}`, payload);
      else {
        const created = await post<Row>("/courses", { code: payload.code, name: payload.name, category: form.category || undefined, description: form.description || undefined, aliases: payload.aliases });
        await patch(`/courses/${created.id}`, payload);
      }
      done();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The course could not be saved."); }
    finally { setBusy(false); }
  }
  return <div className="modal-wrap"><button aria-label="Close" className="modal-scrim" onClick={close} /><form className="modal wide-modal" onSubmit={submit}><div className="modal-head"><div><h2>{course ? "Edit course" : "Add course"}</h2><p>Maintain the typed fields consumed by matching, retrieval, and response generation.</p></div><button type="button" className="icon" onClick={close}><X /></button></div><div className="form-grid">
    <label>Course code<input required value={form.code} onChange={(event) => change("code", event.target.value)} /></label><label>Status<select value={form.status} onChange={(event) => change("status", event.target.value)}><option value="active">Active</option><option value="draft">Draft</option><option value="inactive">Inactive</option></select></label>
    <label className="wide">Course name<input required value={form.name} onChange={(event) => change("name", event.target.value)} /></label><label>Category<input value={form.category} onChange={(event) => change("category", event.target.value)} /></label><label>Course type<input value={form.courseType} onChange={(event) => change("courseType", event.target.value)} /></label>
    <label className="wide">Aliases, comma-separated<input value={form.aliases} onChange={(event) => change("aliases", event.target.value)} /></label><label>Learning modes<input value={form.learningModes} placeholder="Online, Offline" onChange={(event) => change("learningModes", event.target.value)} /></label><label>Offline regions<input value={form.offlineRegions} onChange={(event) => change("offlineRegions", event.target.value)} /></label>
    <label>Next start date<input type="date" value={form.nextStartDate} onChange={(event) => change("nextStartDate", event.target.value)} /></label><label>Schedule<input value={form.scheduleDetail} onChange={(event) => change("scheduleDetail", event.target.value)} /></label>
    <label className="wide">Description<textarea value={form.description} onChange={(event) => change("description", event.target.value)} /></label><label className="wide">Audience profile<textarea value={form.audienceProfile} onChange={(event) => change("audienceProfile", event.target.value)} /></label><label className="wide">Curriculum facts<textarea className="editor compact" value={form.curriculumText} onChange={(event) => change("curriculumText", event.target.value)} /></label>
  </div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button disabled={busy} className="button primary">{busy ? "Saving…" : "Save course"}</button></div></form></div>;
}

function Pricing() {
  const [refresh, setRefresh] = useState(0);
  const prices = useLoad<Row[]>("/pricing-rules", refresh);
  const courses = useLoad<Row[]>("/courses", refresh);
  const [editing, setEditing] = useState<Row | null | undefined>(undefined);
  const [importResult, setImportResult] = useState<Row | null>(null);
  const [importError, setImportError] = useState("");
  async function archive(row: Row) { if (!window.confirm(`Archive the pricing rule for ${row.course_name}?`)) return; await remove(`/pricing-rules/${row.id}`); setRefresh((value) => value + 1); }
  return <><div className="section-toolbar"><div><h2>Pricing rules</h2><p>Grounded tuition by course, audience, delivery mode, and effective period.</p></div><div><ImportControl type="pricing" onError={setImportError} onDone={(result) => { setImportError(""); setImportResult(result); setRefresh((value) => value + 1); }} /><button className="button" onClick={() => setEditing(null)}><Plus size={16} />Add pricing rule</button></div></div>
    <ImportResult result={importResult} error={importError} />
    <div className="info-banner"><ShieldCheck /><span><strong>Grounded pricing</strong>The bot may only quote amounts returned by the pricing tool; a missing valid rule triggers handover.</span></div>
    <section className="card table-card"><LoadState loading={prices.loading} error={prices.error}>{prices.data?.length ? <table><thead><tr><th>Course</th><th>Audience</th><th>Mode</th><th>Standard</th><th>Early Bird</th><th>Group</th><th>Alumni</th><th>Status</th><th>Actions</th></tr></thead><tbody>{prices.data.map((row) => <tr key={row.id}><td><strong>{row.course_name}</strong><small>{row.course_type}</small></td><td>{row.audience_segment}</td><td>{row.delivery_mode ?? "Any"}</td><td>{fmtMoney(row.standard_price)}</td><td className="money-accent">{fmtMoney(row.early_bird_price)}</td><td>{fmtMoney(row.group_price)}</td><td>{fmtMoney(row.alumni_price)}</td><td><Badge value={row.status} /></td><td><div className="row-actions"><button aria-label={`Edit pricing for ${row.course_name}`} className="icon table-action" onClick={() => setEditing(row)}><Pencil size={15} /></button><button aria-label={`Delete pricing for ${row.course_name}`} className="icon table-action danger" onClick={() => archive(row)}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table> : <Empty icon={BadgeDollarSign} title="No active pricing rules" body="Import the provided tuition CSV or add a rule manually." />}</LoadState></section>
    {editing !== undefined && <PricingModal rule={editing} courses={courses.data ?? []} close={() => setEditing(undefined)} done={() => { setEditing(undefined); setRefresh((value) => value + 1); }} />}
  </>;
}

function PricingModal({ rule, courses, close, done }: { rule: Row | null; courses: Row[]; close: () => void; done: () => void }) {
  const [form, setForm] = useState({
    courseId: rule?.course_id ?? courses[0]?.id ?? "", audienceSegment: rule?.audience_segment ?? "Working professionals",
    deliveryMode: rule?.delivery_mode ?? "online", standardPrice: rule?.standard_price ?? "", earlyBirdPrice: rule?.early_bird_price ?? "",
    groupPrice: rule?.group_price ?? "", alumniPrice: rule?.alumni_price ?? "", effectiveFrom: rule?.effective_from?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    installmentInfo: rule?.installment_info ?? "", note: rule?.note ?? "", status: rule?.status ?? "published"
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function change(name: string, value: string) { setForm((current) => ({ ...current, [name]: value })); }
  const amount = (raw: string | number) => raw === "" ? null : Number(raw);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const payload = {
      courseId: form.courseId, audienceSegment: form.audienceSegment, deliveryMode: form.deliveryMode || null,
      standardPrice: Number(form.standardPrice), earlyBirdPrice: amount(form.earlyBirdPrice), groupPrice: amount(form.groupPrice), alumniPrice: amount(form.alumniPrice),
      installmentInfo: form.installmentInfo || null, note: form.note || null, effectiveFrom: `${form.effectiveFrom}T00:00:00.000Z`, status: form.status
    };
    try { rule ? await patch(`/pricing-rules/${rule.id}`, payload) : await post("/pricing-rules", payload); done(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The pricing rule could not be saved."); }
    finally { setBusy(false); }
  }
  return <div className="modal-wrap"><button aria-label="Close" className="modal-scrim" onClick={close} /><form className="modal wide-modal" onSubmit={submit}><div className="modal-head"><div><h2>{rule ? "Edit pricing rule" : "Add pricing rule"}</h2><p>Amounts are stored as typed numeric values and used directly by the pricing tool.</p></div><button type="button" className="icon" onClick={close}><X /></button></div><div className="form-grid">
    <label className="wide">Course<select required value={form.courseId} onChange={(event) => change("courseId", event.target.value)}>{courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>
    <label>Audience segment<input required value={form.audienceSegment} onChange={(event) => change("audienceSegment", event.target.value)} /></label><label>Delivery mode<select value={form.deliveryMode} onChange={(event) => change("deliveryMode", event.target.value)}><option value="online">Online</option><option value="offline">Offline</option><option value="hybrid">Hybrid</option></select></label>
    <label>Standard price<input required type="number" min="0" value={form.standardPrice} onChange={(event) => change("standardPrice", event.target.value)} /></label><label>Early Bird price<input type="number" min="0" value={form.earlyBirdPrice} onChange={(event) => change("earlyBirdPrice", event.target.value)} /></label><label>Group price<input type="number" min="0" value={form.groupPrice} onChange={(event) => change("groupPrice", event.target.value)} /></label><label>Alumni price<input type="number" min="0" value={form.alumniPrice} onChange={(event) => change("alumniPrice", event.target.value)} /></label>
    <label>Effective from<input type="date" required value={form.effectiveFrom} onChange={(event) => change("effectiveFrom", event.target.value)} /></label><label>Status<select value={form.status} onChange={(event) => change("status", event.target.value)}><option value="published">Published</option><option value="draft">Draft</option><option value="review">Review</option><option value="approved">Approved</option></select></label>
    <label className="wide">Installment information<textarea value={form.installmentInfo} onChange={(event) => change("installmentInfo", event.target.value)} /></label><label className="wide">Internal note<textarea value={form.note} onChange={(event) => change("note", event.target.value)} /></label>
  </div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button disabled={busy || !form.courseId} className="button primary">{busy ? "Saving…" : "Save pricing rule"}</button></div></form></div>;
}

function DocumentsPage() {
  const [refresh, setRefresh] = useState(0); const [listQ, setListQ] = useState(""); const [status, setStatus] = useState("");
  const listPath = `/knowledge/documents?q=${encodeURIComponent(listQ)}${status ? `&status=${status}` : ""}`;
  const { data, loading, error } = useLoad<Row>(listPath, refresh);
  const [searchQ, setSearchQ] = useState(""); const [results, setResults] = useState<Row[]>([]); const [searching, setSearching] = useState(false);
  const [show, setShow] = useState(false); const [selected, setSelected] = useState<string | null>(null); const [actionError, setActionError] = useState("");
  async function search(event: FormEvent) { event.preventDefault(); if (searchQ.length < 2) return; setSearching(true); setActionError(""); try { setResults(await api<Row[]>(`/knowledge/search?q=${encodeURIComponent(searchQ)}`)); } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Knowledge search failed."); } finally { setSearching(false); } }
  async function publish(row: Row) { setActionError(""); try { await post(`/knowledge/revisions/${row.latest_revision_id}/transition`, { status: "published" }); setRefresh((value) => value + 1); } catch (reason) { setActionError(reason instanceof Error ? reason.message : "The revision could not be published."); } }
  async function archive(row: Row) { if (!window.confirm(`Archive ${row.title}? Published chunks will no longer be available to the AI.`)) return; await remove(`/knowledge/documents/${row.id}`); setRefresh((value) => value + 1); }
  return <><Header eyebrow="KNOWLEDGE / DOCUMENTS" title="Documents" description="Upload source files, control revisions, publish verified content, and search the same knowledge available to the AI." actions={<button className="button primary" onClick={() => setShow(true)}><Plus size={17} />Add document</button>} />
    <KnowledgeModuleNav active="documents" />
    {actionError && <div className="error-box page-error"><AlertTriangle size={17} />{actionError}</div>}
    <section className="knowledge-search-panel card"><div><span className="dataset-icon"><Search /></span><span><strong>Search published knowledge</strong><small>Hybrid keyword and vector retrieval uses the same index as the conversation pipeline.</small></span></div><form onSubmit={search}><input aria-label="Search published knowledge" value={searchQ} onChange={(event) => setSearchQ(event.target.value)} placeholder="Ask a question or search for a verified fact…" /><button disabled={searching || searchQ.length < 2} className="button primary">{searching ? "Searching…" : "Search"}</button></form></section>
    {results.length > 0 && <section className="card search-results"><div className="search-results-head"><CardTitle title={`Results for “${searchQ}”`} subtitle={`${results.length} grounded passages`} /><button className="icon" aria-label="Clear search results" onClick={() => setResults([])}><X size={17} /></button></div><div>{results.map((row, index) => <article key={row.id ?? index}><span>{index + 1}</span><p>{row.content}</p><small>Hybrid score {Number(row.score ?? 0).toFixed(3)}</small></article>)}</div></section>}
    <div className="section-toolbar"><div><h2>Document library</h2><p>{data?.total ?? 0} active documents with immutable revision history.</p></div><div><div className="search compact-search"><Search size={16} /><input aria-label="Filter documents" value={listQ} onChange={(event) => setListQ(event.target.value)} placeholder="Filter documents…" /></div><select aria-label="Document status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="draft">Draft</option><option value="parsing">Parsing</option><option value="published">Published</option><option value="failed">Failed</option></select></div></div>
    <section className="card table-card"><LoadState loading={loading} error={error}>{data?.documents?.length ? <table><thead><tr><th>Document</th><th>Source</th><th>Revision</th><th>Chunks</th><th>Updated</th><th>Status</th><th>Actions</th></tr></thead><tbody>{data.documents.map((row: Row) => <tr key={row.id}><td><strong>{row.title}</strong><small>{row.tags?.join(" · ") || "No tags"}</small></td><td><span className="source-type"><FileText size={14} />{row.source_type}</span></td><td>v{row.revision_no ?? 0}</td><td>{row.chunk_count}</td><td>{fmtDate(row.revision_updated_at ?? row.updated_at)}</td><td><Badge value={row.revision_status ?? row.status} /></td><td><div className="row-actions">{row.revision_status === "draft" && <button className="button small primary" onClick={() => publish(row)}>Publish</button>}<button aria-label={`Edit ${row.title}`} className="icon table-action" onClick={() => setSelected(row.id)}><Pencil size={15} /></button><button aria-label={`Archive ${row.title}`} className="icon table-action danger" onClick={() => archive(row)}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table> : <Empty icon={FileText} title="No documents found" body="Upload a source file or create a verified text document." />}</LoadState></section>
    {show && <DocumentModal close={() => setShow(false)} done={() => { setShow(false); setRefresh((value) => value + 1); }} />}
    {selected && <DocumentDetailsModal id={selected} close={() => setSelected(null)} done={() => { setSelected(null); setRefresh((value) => value + 1); }} />}
  </>;
}

function DocumentDetailsModal({ id, close, done }: { id: string; close: () => void; done: () => void }) {
  const { data, loading, error: loadError } = useLoad<Row>(`/knowledge/documents/${id}`);
  const latest = data?.revisions?.[0]; const [form, setForm] = useState<Row | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (data && !form) setForm({ title: data.title, tags: data.tags?.join(", ") ?? "", content: latest?.clean_content ?? "", changeReason: "" }); }, [data, latest, form]);
  async function submit(event: FormEvent) { event.preventDefault(); if (!form || !data) return; setBusy(true); setError(""); try { await patch(`/knowledge/documents/${id}`, { title: form.title, tags: String(form.tags).split(",").map((item) => item.trim()).filter(Boolean) }); if (String(form.content) !== String(latest?.clean_content ?? "")) await post(`/knowledge/documents/${id}/revisions`, { content: form.content, changeReason: form.changeReason || "Edited in the document workspace" }); done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The document could not be updated."); } finally { setBusy(false); } }
  return <div className="modal-wrap"><button aria-label="Close" className="modal-scrim" onClick={close} /><div className="modal wide-modal"><div className="modal-head"><div><h2>Edit document</h2><p>Metadata updates immediately. Content changes create a new draft revision.</p></div><button className="icon" onClick={close}><X /></button></div><LoadState loading={loading} error={loadError}>{form && <form className="modal-form" onSubmit={submit}><div className="form-grid"><label className="wide">Title<input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label className="wide">Tags, comma-separated<input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></label><label className="wide">Verified content<textarea className="editor" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} /></label><label className="wide">Change reason<input value={form.changeReason} onChange={(event) => setForm({ ...form, changeReason: event.target.value })} placeholder="What changed and why?" /></label></div><div className="revision-strip"><span><strong>Current revision</strong>v{latest?.revision_no ?? 0} · {latest?.status ?? data?.status ?? "draft"}</span><span><strong>Revision history</strong>{data?.revisions?.length ?? 0} versions retained</span></div>{error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button disabled={busy} className="button primary">{busy ? "Saving…" : "Save changes"}</button></div></form>}</LoadState></div></div>;
}

function DocumentModal({ close, done }: { close: () => void; done: () => void }) {
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [file, setFile] = useState<File | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      if (file) {
        const form = new FormData(); form.append("title", title); form.append("tags", "manual,upload"); form.append("file", file);
        const response = await fetch(`${API_URL}/knowledge/documents/upload`, { method: "POST", credentials: "include", body: form });
        const payload = await response.json(); if (!response.ok) throw new ApiError(response.status, payload?.error?.code, payload?.error?.message ?? "Upload failed.");
      } else await post("/knowledge/documents", { title, content, sourceType: "text", tags: ["manual"] });
      done();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The document could not be created."); }
    finally { setBusy(false); }
  }
  return <div className="modal-wrap"><button aria-label="Close" className="modal-scrim" onClick={close} /><form className="modal wide-modal" onSubmit={submit}><div className="modal-head"><div><h2>Create knowledge document</h2><p>Enter verified text or upload PDF, DOCX, PPTX, image, HTML, Markdown, or text.</p></div><button type="button" className="icon" onClick={close}><X /></button></div><label>Title<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Source file (optional)<input className="file-input" type="file" accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.html,.htm,.md,.txt" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>{!file && <label>Verified content<textarea className="editor" required value={content} onChange={(event) => setContent(event.target.value)} placeholder="# Title\n\nVerified content…" /></label>}{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button disabled={busy} className="button primary">{busy ? "Saving…" : file ? "Upload & extract" : "Save draft"}</button></div></form></div>;
}

function Integrations() {
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useLoad<Row>("/integrations/status", refresh);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  async function copy(value: string) { await navigator.clipboard.writeText(value); setResult("Webhook URL copied to clipboard."); }
  async function testBridge() {
    if (!data?.endpoints?.n8n) return; setBusy(true); setResult("");
    try {
      const response = await fetch(data.endpoints.n8n, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender_id: `n8n-ui-${Date.now()}`, message_id: `n8n-msg-${Date.now()}`, text: "What is the tuition fee for Digital Performance?", timestamp: Date.now(), display_name: "n8n Bridge Test" }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "Bridge test failed.");
      setResult(`Accepted as a live conversation (${payload.data.status}). Open Live Inbox after processing completes.`);
    } catch (reason) { setResult(reason instanceof Error ? reason.message : "Bridge test failed."); }
    finally { setBusy(false); setRefresh((value) => value + 1); }
  }
  return <><Header eyebrow="CHANNEL INTEGRATIONS" title="Webhooks & n8n Bridge" description="Keep n8n connected to Meta during migration, then forward each message into the same pipeline used by the direct Meta webhook." actions={<button className="button ghost" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} />Refresh status</button>} />
    <LoadState loading={loading} error={error}>{data && <>
      <div className="integration-grid"><section className="card integration-card"><div className="integration-head"><span className="artifact-icon"><Webhook /></span><div><h2>n8n forwarding bridge</h2><p>Recommended for the migration and real-world trial.</p></div><Badge value={data.readiness.n8n ? "ready" : "not ready"} /></div><label>n8n running on the host<div className="copy-field"><code>{data.endpoints.n8n}</code><button aria-label="Copy n8n webhook URL" className="icon" onClick={() => copy(data.endpoints.n8n)}><Copy size={16} /></button></div></label><label>n8n running in Docker<div className="copy-field"><code>{data.endpoints.n8nDocker}</code><button aria-label="Copy Docker n8n webhook URL" className="icon" onClick={() => copy(data.endpoints.n8nDocker)}><Copy size={16} /></button></div></label><div className="readiness-list"><span><strong>Authentication</strong>{data.readiness.n8nSecretConfigured ? "Secret header configured" : "Demo-only: no secret configured"}</span><span><strong>Accepted input</strong>Normalized fields or raw Meta payload</span><span><strong>Destination</strong>Live Inbox</span></div><button disabled={busy || !data.readiness.n8n} className="button primary" onClick={testBridge}><Send size={16} />{busy ? "Sending…" : "Send bridge test"}</button></section>
        <section className="card integration-card"><div className="integration-head"><span className="artifact-icon orange"><MessagesSquare /></span><div><h2>Direct Meta Messenger</h2><p>Use after Meta credentials are configured.</p></div><Badge value={data.readiness.meta ? "ready" : "configuration required"} /></div><label>Callback URL<div className="copy-field"><code>{data.endpoints.meta}</code><button aria-label="Copy Meta webhook URL" className="icon" onClick={() => copy(data.endpoints.meta)}><Copy size={16} /></button></div></label><div className="readiness-list"><span><strong>Verification</strong>GET hub challenge supported</span><span><strong>Signature</strong>X-Hub-Signature-256 validated</span><span><strong>Current state</strong>{data.readiness.meta ? "All Meta credentials loaded" : "META_* values are missing from .env"}</span></div></section></div>
      {result && <div className="success-box"><Activity size={18} /><span>{result}</span></div>}
      <section className="card setup-card"><CardTitle title="n8n HTTP Request node" subtitle="Place this node after the existing Messenger trigger" icon={<Workflow />} /><div className="setup-columns"><div><h3>Request configuration</h3><ol><li>Method: <code>POST</code></li><li>URL: copy the n8n forwarding endpoint above.</li><li>Header: <code>x-tm-webhook-secret</code> = your <code>N8N_WEBHOOK_SECRET</code>.</li><li>Body content type: JSON.</li><li>Send the mapping shown on the right.</li></ol></div><pre>{`{
  "sender_id": "={{ $json.sender.id }}",
  "message_id": "={{ $json.message.mid }}",
  "text": "={{ $json.message.text }}",
  "timestamp": "={{ $json.timestamp }}",
  "display_name": "={{ $json.display_name }}",
  "attachments": "={{ $json.message.attachments }}"
}`}</pre></div></section>
      <div className="info-banner"><ShieldCheck /><span><strong>Model gateway</strong>{data.readiness.modelGateway ? "OpenAI-compatible credentials are loaded; Test Workspace uses the real gateway." : "No model token is loaded; deterministic local responses are used."}</span></div>
    </>}</LoadState></>;
}

function StudioTabs({ active }: { active: string }) { return <div className="tabs"><Link className={active === "flows" ? "active" : ""} href="/studio/flows">Flow</Link><Link className={active === "prompts" ? "active" : ""} href="/studio/prompts">Prompts</Link><Link className={active === "rules" ? "active" : ""} href="/studio/rules">Rules</Link><Link className={active === "evaluations" ? "active" : ""} href="/studio/evaluations">Evaluations</Link><Link className={active === "releases" ? "active" : ""} href="/studio/releases">Releases</Link></div>; }
function StudioPrompts() {
  const [refresh, setRefresh] = useState(0); const { data, loading, error } = useLoad<Row[]>("/studio/prompts", refresh); const runtime = useLoad<Row>("/studio/runtime", refresh);
  const [editing, setEditing] = useState<Row | null | undefined>(undefined); const [actionError, setActionError] = useState("");
  async function publish(row: Row) { setActionError(""); try { await post(`/studio/prompt-versions/${row.version_id}/transition`, { status: "published" }); setRefresh((value) => value + 1); } catch (reason) { setActionError(reason instanceof Error ? reason.message : "The prompt version could not be published."); } }
  const liveMap = new Map((runtime.data?.prompts ?? []).map((row: Row) => [row.code, row]));
  return <><Header eyebrow="AI STUDIO" title="Prompt Registry" description="Create reusable prompts, manage immutable versions, then attach them to runtime stages in Conversation Flow." actions={<><div className={cx("runtime-pill", runtime.data?.registryConnected && "connected")}><span />{runtime.data?.registryConnected ? `Runtime connected · ${runtime.data.release?.release_code}` : "Runtime configuration required"}</div><button className="button primary" onClick={() => setEditing(null)}><Plus size={16} />New prompt</button></>} /><StudioTabs active="prompts" />
    {actionError && <div className="error-box page-error"><AlertTriangle size={17} />{actionError}</div>}
    <div className="studio-grid"><LoadState loading={loading || runtime.loading} error={error || runtime.error}>{data?.map((row) => { const activePrompt = liveMap.get(row.code) as Row | undefined; return <section className={cx("card", "artifact", activePrompt?.version_id === row.version_id && "runtime-active")} key={row.id}><div><span className="artifact-icon"><Sparkles /></span><div className="artifact-badges"><Badge value={row.status} />{activePrompt && <Badge value={`runtime v${activePrompt.version_no}`} tone="violet" />}</div></div><h3>{row.name}</h3><code>{row.code} · latest v{row.version_no} · {row.version_count} versions</code><p>{row.purpose}</p><div className="prompt-preview">{String(row.system_template ?? "").slice(0, 170)}{String(row.system_template ?? "").length > 170 ? "…" : ""}</div><div className="artifact-meta"><span><BrainCircuit size={15} />{row.model_profile_code}</span><span><Workflow size={15} />{row.allowed_tools?.length ?? 0} tools</span></div><div className="artifact-actions"><button className="button" onClick={() => setEditing(row)}><Pencil size={14} />Create version</button>{row.status !== "published" && <button className="button primary" onClick={() => publish(row)}>Publish v{row.version_no}</button>}</div></section>; })}</LoadState></div>
    {editing !== undefined && <PromptEditorModal prompt={editing} close={() => setEditing(undefined)} done={() => { setEditing(undefined); setRefresh((value) => value + 1); }} />}
  </>;
}

function PromptEditorModal({ prompt, close, done }: { prompt: Row | null; close: () => void; done: () => void }) {
  const [form, setForm] = useState({ code: prompt?.code ?? "", name: prompt?.name ?? "", purpose: prompt?.purpose ?? "Customer response stage", systemTemplate: prompt?.system_template ?? "", userTemplate: prompt?.user_template ?? "", allowedTools: prompt?.allowed_tools?.join(", ") ?? "", modelProfileCode: prompt?.model_profile_code ?? "conversation-primary", changeReason: "" });
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await post("/studio/prompts", { code: form.code, name: form.name, purpose: form.purpose, systemTemplate: form.systemTemplate, userTemplate: form.userTemplate || undefined, allowedTools: form.allowedTools.split(",").map((item: string) => item.trim()).filter(Boolean), modelProfileCode: form.modelProfileCode, changeReason: form.changeReason || (prompt ? "Updated in Prompt Registry" : "Created in Prompt Registry") }); done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The prompt version could not be created."); } finally { setBusy(false); } }
  return <div className="modal-wrap"><button aria-label="Close" className="modal-scrim" onClick={close} /><form className="modal prompt-modal" onSubmit={submit}><div className="modal-head"><div><h2>{prompt ? `Create ${prompt.name} v${Number(prompt.version_no) + 1}` : "Create a reusable prompt"}</h2><p>{prompt ? "The active release stays unchanged until this version is published and pinned by a new release." : "After publishing, attach this prompt to a runtime stage in Conversation Flow."}</p></div><button type="button" className="icon" onClick={close}><X /></button></div><div className="prompt-identity form-grid"><label>Prompt name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>Stable code<input required pattern="[a-zA-Z0-9_-]+" disabled={Boolean(prompt)} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") })} /></label><label className="wide">Purpose<input required value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} /></label></div><div className="prompt-editor-grid"><div><label>System prompt<textarea className="editor prompt-editor" required value={form.systemTemplate} onChange={(event) => setForm({ ...form, systemTemplate: event.target.value })} placeholder="Define the role, response behavior, tone, and stage-specific instructions." /></label><label>User template<textarea className="editor compact" value={form.userTemplate} onChange={(event) => setForm({ ...form, userTemplate: event.target.value })} placeholder="Optional instruction placed before the protected runtime context." /></label></div><aside><div className="info-banner"><ShieldCheck /><span><strong>Runtime invariants stay locked</strong>Grounded fact preservation, no invented numbers, no payment confirmation, structured output, and deterministic fallback cannot be removed by a prompt version.</span></div><label>Allowed tools<input value={form.allowedTools} onChange={(event) => setForm({ ...form, allowedTools: event.target.value })} placeholder="pricing_quote, course_lookup" /></label><label>Model profile<input required value={form.modelProfileCode} onChange={(event) => setForm({ ...form, modelProfileCode: event.target.value })} /></label><label>Change reason<textarea value={form.changeReason} onChange={(event) => setForm({ ...form, changeReason: event.target.value })} placeholder="Why is this version safer or more effective?" /></label></aside></div>{error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button disabled={busy} className="button primary">{busy ? "Creating…" : "Create draft version"}</button></div></form></div>;
}
function StudioRules() { const { data, loading, error } = useLoad<Row[]>("/studio/rules"); return <><Header eyebrow="AI STUDIO" title="Policy & Rules" description="Hard guardrails execute before the model and produce explicit handover reasons." /><StudioTabs active="rules" /><div className="studio-grid"><LoadState loading={loading} error={error}>{data?.map((row) => <section className="card artifact" key={row.id}><div><span className="artifact-icon orange"><Scale /></span><Badge value={row.status} /></div><h3>{row.name}</h3><code>{row.code} · v{row.version_no}</code><p>{row.rules?.length ?? 0} rules · {row.conflicts?.length ?? 0} conflicts</p><div className="rule-preview">{row.rules?.slice(0, 3).map((rule: Row, index: number) => <span key={index}><Circle size={8} />{rule.code ?? rule.when?.signal ?? `Rule ${index + 1}`}</span>)}</div></section>)}</LoadState></div></>; }

function Evaluations() {
  const [refresh, setRefresh] = useState(0); const suites = useLoad<Row[]>("/studio/evaluation-suites"); const runs = useLoad<Row[]>("/studio/evaluation-runs", refresh);
  async function run() { if (!suites.data?.[0]) return; await post("/studio/evaluation-runs", { suiteId: suites.data[0].id }); window.setTimeout(() => setRefresh((value) => value + 1), 1000); }
  return <><Header eyebrow="AI STUDIO" title="Evaluation Center" description="Regression suites gate releases with critical pricing, payment, and handover scenarios." actions={<button disabled={!suites.data?.length} className="button primary" onClick={run}><FlaskConical size={17} />Run regression</button>} /><StudioTabs active="evaluations" /><div className="eval-summary"><section className="card"><span>Evaluation suites</span><strong>{suites.data?.length ?? 0}</strong><small>{suites.data?.reduce((total, item) => total + Number(item.case_count), 0) ?? 0} test cases</small></section><section className="card"><span>Latest run</span><strong>{runs.data?.[0]?.status ?? "Not run"}</strong><small>{runs.data?.[0] ? fmtDate(runs.data[0].created_at) : "—"}</small></section><section className="card"><span>Pass rate</span><strong>{runs.data?.[0]?.metrics?.pass_rate != null ? `${Math.round(runs.data[0].metrics.pass_rate * 100)}%` : "—"}</strong><small>{runs.data?.[0]?.metrics?.critical_violations ?? 0} critical violations</small></section></div><section className="card table-card"><LoadState loading={runs.loading} error={runs.error}>{runs.data?.length ? <table><thead><tr><th>Suite</th><th>Status</th><th>Passed</th><th>Failed</th><th>Critical</th><th>Created</th></tr></thead><tbody>{runs.data.map((row) => <tr key={row.id}><td><strong>{row.suite_name}</strong><small>{row.id.slice(0, 8)}</small></td><td><Badge value={row.status} /></td><td>{row.metrics?.passed ?? "—"}</td><td>{row.metrics?.failed ?? "—"}</td><td>{row.metrics?.critical_violations ?? "—"}</td><td>{fmtDate(row.created_at)}</td></tr>)}</tbody></table> : <Empty icon={FlaskConical} title="No evaluation runs" body="Run the suite to create the first baseline." />}</LoadState></section></>;
}

function Releases() {
  const [refresh, setRefresh] = useState(0); const { data, loading, error } = useLoad<Row[]>("/studio/releases", refresh); const prompts = useLoad<Row[]>("/studio/prompts", refresh); const flows = useLoad<Row[]>("/studio/flows", refresh); const suites = useLoad<Row[]>("/studio/evaluation-suites");
  const [creating, setCreating] = useState(false); const [actionError, setActionError] = useState(""); const [busyId, setBusyId] = useState("");
  async function action(id: string, task: () => Promise<unknown>) { setBusyId(id); setActionError(""); try { await task(); setRefresh((value) => value + 1); } catch (reason) { setActionError(reason instanceof Error ? reason.message : "The release action failed."); } finally { setBusyId(""); } }
  async function approve(id: string) { await action(id, () => post(`/studio/releases/${id}/approve`, { decision: "approved", comment: "Approved in Release Control" })); }
  async function runGate(id: string) { if (!suites.data?.[0]) return; await action(id, () => post("/studio/evaluation-runs", { suiteId: suites.data![0].id, candidateReleaseId: id })); window.setTimeout(() => setRefresh((value) => value + 1), 1800); }
  async function activate(id: string) { await action(id, () => post(`/studio/releases/${id}/activate`)); }
  return <><Header eyebrow="AI STUDIO" title="Release Control" description="Pin published prompts and model settings, require approval, pass the regression gate, then activate the immutable runtime bundle." actions={<button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />Create candidate</button>} /><StudioTabs active="releases" />
    {actionError && <div className="error-box page-error"><AlertTriangle size={17} />{actionError}</div>}
    <section className="release-flow card"><div><CheckCircle2 /><span><strong>Version & approve</strong><small>Published artifacts only</small></span></div><ChevronRight /><div><FlaskConical /><span><strong>Evaluation gate</strong><small>All critical cases pass</small></span></div><ChevronRight /><div><Rocket /><span><strong>Activate</strong><small>Previous release retained</small></span></div></section><section className="card table-card"><LoadState loading={loading} error={error}>{data?.length ? <table><thead><tr><th>Release</th><th>Environment</th><th>Change</th><th>Approval</th><th>Evaluation</th><th>Status</th><th>Activated</th><th>Next action</th></tr></thead><tbody>{data.map((row) => <tr key={row.id}><td><strong>{row.release_code}</strong><small><code>{row.checksum?.slice(0, 10)}…</code></small></td><td>{row.environment}</td><td>{row.change_summary}</td><td><Badge value={row.approved_by ? "approved" : "required"} /></td><td><Badge value={row.evaluation_status ?? (row.status === "active" ? "baseline" : "not run")} /></td><td><Badge value={row.status} /></td><td>{fmtDate(row.activated_at)}</td><td>{["candidate", "canary"].includes(row.status) && <div className="row-actions">{!row.approved_by ? <button disabled={busyId === row.id} className="button small" onClick={() => approve(row.id)}>Approve</button> : row.evaluation_status !== "passed" ? <button disabled={busyId === row.id || ["queued", "running"].includes(row.evaluation_status)} className="button small" onClick={() => runGate(row.id)}>{["queued", "running"].includes(row.evaluation_status) ? "Gate running" : "Run gate"}</button> : <button disabled={busyId === row.id} className="button small primary" onClick={() => activate(row.id)}>Activate</button>}</div>}</td></tr>)}</tbody></table> : <Empty icon={Rocket} />}</LoadState></section>
    {creating && <ReleaseModal releases={data ?? []} prompts={prompts.data ?? []} flows={flows.data ?? []} close={() => setCreating(false)} done={() => { setCreating(false); setRefresh((value) => value + 1); }} />}
  </>;
}

function ReleaseModal({ releases, prompts, flows, close, done }: { releases: Row[]; prompts: Row[]; flows: Row[]; close: () => void; done: () => void }) {
  const active = releases.find((row) => row.status === "active"); const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const [releaseCode, setReleaseCode] = useState(`R-${stamp}`); const [changeSummary, setChangeSummary] = useState("Publish the latest reviewed prompt versions"); const [environment, setEnvironment] = useState(active?.environment ?? "development");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const promptVersionIds = Object.fromEntries(prompts.filter((row) => row.published_version_id).map((row) => [row.code, row.published_version_id]));
  const publishedFlows = flows.filter((row) => row.published_version_id); const [flowVersionId, setFlowVersionId] = useState(active?.manifest?.flowVersionId ?? publishedFlows[0]?.published_version_id ?? "");
  const hasChanges = JSON.stringify(Object.entries(promptVersionIds).sort()) !== JSON.stringify(Object.entries(active?.manifest?.promptVersionIds ?? {}).sort()) || flowVersionId !== active?.manifest?.flowVersionId;
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await post("/studio/releases", { releaseCode, environment, changeSummary, manifest: { ...(active?.manifest ?? {}), promptRuntime: "registry-connected-v2", promptVersionIds, flowVersionId } }); done(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The release candidate could not be created."); } finally { setBusy(false); } }
  return <div className="modal-wrap"><button aria-label="Close" className="modal-scrim" onClick={close} /><form className="modal wide-modal" onSubmit={submit}>
    <div className="modal-head"><div><h2>Create release candidate</h2><p>The bundle pins one published flow and every published prompt version. Drafts are excluded.</p></div><button type="button" className="icon" onClick={close}><X /></button></div>
    <div className="form-grid"><label>Release code<input required value={releaseCode} onChange={(event) => setReleaseCode(event.target.value)} /></label><label>Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option></select></label><label className="wide">Conversation flow<select required value={flowVersionId} onChange={(event) => setFlowVersionId(event.target.value)}><option value="">Select a published flow</option>{publishedFlows.map((flow) => <option value={flow.published_version_id} key={flow.id}>{flow.name} · v{flow.published_version_no}</option>)}</select></label><label className="wide">Change summary<textarea required value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} /></label></div>
    <div className="pinned-list"><strong>{Object.keys(promptVersionIds).length} published prompts pinned</strong>{prompts.map((row) => <span key={row.code}><code>{row.code}</code><small>{row.published_version_id ? `v${row.published_version_no}` : "No published version"}</small></span>)}</div>
    {!hasChanges && <div className="info-banner"><CheckCircle2 /><span><strong>No unpublished runtime change</strong>The active release already pins the latest published flow and prompt versions.</span></div>}{error && <div className="form-error"><AlertTriangle size={16} />{error}</div>}
    <div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button disabled={busy || !hasChanges || !Object.keys(promptVersionIds).length || !flowVersionId} className="button primary">{busy ? "Creating…" : "Create candidate"}</button></div>
  </form></div>;
}

function Jobs() {
  const [refresh, setRefresh] = useState(0); const { data, loading, error } = useLoad<Row[]>("/jobs", refresh);
  return <><Header eyebrow="PLATFORM RUNTIME" title="Jobs & Runtime" description="Durable queues, backoff retries, dead-letter handling, and correlation IDs replace opaque workflow executions." actions={<button className="button ghost" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} />Refresh</button>} /><div className="info-banner"><Activity /><span><strong>PostgreSQL-backed queue</strong>Workers use SKIP LOCKED and all side effects use an outbox to prevent duplicate delivery.</span></div><section className="card table-card"><LoadState loading={loading} error={error}>{data?.length ? <table><thead><tr><th>Job type</th><th>Status</th><th>Current step</th><th>Attempts</th><th>Available</th><th>Latest error</th><th /></tr></thead><tbody>{data.map((row) => <tr key={row.id}><td><strong>{row.job_type}</strong><small>{row.id.slice(0, 8)}</small></td><td><Badge value={row.status} /></td><td>{row.current_step ?? "—"}</td><td>{row.attempts}/{row.max_attempts}</td><td>{fmtDate(row.available_at)}</td><td className="error-cell">{row.last_error ?? "—"}</td><td>{row.status === "failed" && <button className="button small" onClick={async () => { await post(`/jobs/${row.id}/retry`); setRefresh((value) => value + 1); }}>Retry</button>}</td></tr>)}</tbody></table> : <Empty icon={Workflow} />}</LoadState></section></>;
}
