"use client";

import {
  AlertTriangle, ArrowRight, Bot, Check, ChevronRight, CircleDot, FlaskConical, GitBranch,
  GripVertical, LoaderCircle, MessageSquareText, Pencil, Plus, Rocket, Save, ShieldCheck,
  Sparkles, UserRound, Workflow, X, Zap
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, post } from "@/lib/api";

type Row = Record<string, any>;
type FlowNode = { id: string; label: string; runtimeStage: string; promptCode: string; description: string; position?: { x: number; y: number } };
type FlowEdge = { id: string; source: string; target: string; label: string };
type FlowGraph = { entryNodeId: string; nodes: FlowNode[]; edges: FlowEdge[] };

const stageMeta: Record<string, { hint: string; tool: string; tone: string }> = {
  ICE_BREAK: { hint: "First contact and intent discovery", tool: "No required tool", tone: "violet" },
  QUALIFICATION: { hint: "Customer context and learning goals", tool: "knowledge_search", tone: "blue" },
  QNA_COURSE: { hint: "Grounded course information", tool: "course_lookup", tone: "cyan" },
  QNA_PRICE: { hint: "Effective tuition and promotions", tool: "pricing_quote", tone: "amber" },
  HUMAN: { hint: "Advisor takeover and automation stop", tool: "Case creation", tone: "red" }
};

function cx(...values: Array<string | false | null | undefined>) { return values.filter(Boolean).join(" "); }
function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: string }) { return <span className={`flow-badge ${tone}`}><i />{children}</span>; }

export function FlowStudio() {
  const [flows, setFlows] = useState<Row[]>([]); const [prompts, setPrompts] = useState<Row[]>([]); const [runtime, setRuntime] = useState<Row | null>(null);
  const [selectedId, setSelectedId] = useState(""); const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false); const [newFlow, setNewFlow] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [testMessage, setTestMessage] = useState("What is the tuition fee for Digital Performance?"); const [testState, setTestState] = useState("NEW"); const [testResult, setTestResult] = useState<Row | null>(null); const [testing, setTesting] = useState(false);

  useEffect(() => {
    let active = true; setLoading(true);
    Promise.all([api<Row[]>("/studio/flows"), api<Row[]>("/studio/prompts"), api<Row>("/studio/runtime")]).then(([flowRows, promptRows, runtimeRow]) => {
      if (!active) return; setFlows(flowRows); setPrompts(promptRows); setRuntime(runtimeRow); setSelectedId((current) => current || flowRows[0]?.id || ""); setError("");
    }).catch((reason) => active && setError(reason instanceof Error ? reason.message : "Conversation flows could not be loaded."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [refresh]);

  const selected = flows.find((flow) => flow.id === selectedId) ?? flows[0];
  const graph = selected?.graph as FlowGraph | undefined;
  const promptMap = useMemo(() => new Map(prompts.map((prompt) => [prompt.code, prompt])), [prompts]);

  async function publish() {
    if (!selected?.version_id) return; setError("");
    try { await post(`/studio/flow-versions/${selected.version_id}/transition`, { status: "published" }); setNotice(`Flow v${selected.version_no} published. Create a release candidate to activate it.`); setRefresh((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The flow version could not be published."); }
  }

  async function testFlow() {
    setTesting(true); setError(""); setTestResult(null);
    try { setTestResult(await post<Row>("/studio/prompt-preview", { message: testMessage, state: testState })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The flow preview failed."); }
    finally { setTesting(false); }
  }

  return <>
    <header className="page-header flow-page-header"><div><div className="eyebrow">AI STUDIO / RUNTIME</div><h1>Conversation Flow</h1><p>Design which prompt answers each customer stage, inspect tool grounding, and test the active runtime before release.</p></div><div className="page-actions"><div className={cx("runtime-pill", runtime?.flow && "connected")}><span />{runtime?.flow ? `Runtime · ${runtime.flow.code} v${runtime.flow.version_no}` : "Flow not pinned"}</div><button className="button" onClick={() => { setNewFlow(true); setEditing(true); }}><Plus size={16} />New flow</button><button className="button primary" disabled={!selected} onClick={() => { setNewFlow(false); setEditing(true); }}><Pencil size={16} />Create version</button></div></header>
    <div className="tabs"><Link className="active" href="/studio/flows">Flow</Link><Link href="/studio/prompts">Prompts</Link><Link href="/studio/rules">Rules</Link><Link href="/studio/evaluations">Evaluations</Link><Link href="/studio/releases">Releases</Link></div>
    {(error || notice) && <div className={cx("data-message", error ? "error" : "success")}><span>{error ? <AlertTriangle size={16} /> : <Check size={16} />}{error || notice}</span><button onClick={() => { setError(""); setNotice(""); }}><X size={14} /></button></div>}
    {loading ? <div className="flow-loading"><LoaderCircle className="spin" />Loading the runtime graph</div> : selected && graph ? <>
      <section className="flow-overview card"><div className="flow-overview-main"><div className="flow-selector"><label>Flow<select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{flows.map((flow) => <option value={flow.id} key={flow.id}>{flow.name}</option>)}</select></label><span><strong>{selected.name}</strong><small>{selected.description}</small></span></div><div className="flow-version-state"><Badge tone={selected.runtime_active ? "green" : selected.status === "published" ? "blue" : "amber"}>{selected.runtime_active ? "runtime active" : selected.status}</Badge><code>v{selected.version_no}</code><span>{graph.nodes.length} stages · {graph.edges.length} transitions</span></div></div>
        <div className="flow-release-path"><div className="done"><Pencil /><span><strong>Draft</strong><small>Map stages</small></span></div><ChevronRight /><div className={selected.status === "published" || selected.runtime_active ? "done" : "current"}><ShieldCheck /><span><strong>Publish</strong><small>Lock version</small></span></div><ChevronRight /><div className={selected.runtime_active ? "done" : ""}><FlaskConical /><span><strong>Evaluate</strong><small>Regression gate</small></span></div><ChevronRight /><div className={selected.runtime_active ? "done" : ""}><Rocket /><span><strong>Release</strong><small>Activate bundle</small></span></div></div>
        {selected.status !== "published" && <button className="button primary" onClick={() => void publish()}><ShieldCheck size={15} />Publish flow v{selected.version_no}</button>}
      </section>

      <div className="flow-layout"><section className="flow-canvas card"><div className="flow-section-head"><div><span className="kicker">RUNTIME MAP</span><h2>Customer response pipeline</h2><p>Hard rules choose a route first. The selected stage then loads the prompt and required grounded tool shown below.</p></div><Badge tone="green"><CircleDot size={12} />Live wiring</Badge></div>
        <div className="flow-ingress"><span><MessageSquareText /></span><div><strong>Inbound Messenger event</strong><small>Verified, normalized, deduplicated</small></div><ArrowRight /></div>
        <div className="flow-router"><span><GitBranch /></span><div><strong>Safety & intent router</strong><small>Payment, human request, contact capture, stage and course matching</small></div><Badge tone="red">hard rules first</Badge></div>
        <div className="flow-node-grid">{graph.nodes.map((node, index) => { const meta = stageMeta[node.runtimeStage] ?? stageMeta.ICE_BREAK; const prompt = promptMap.get(node.promptCode); return <article className={cx("flow-node", meta.tone, node.runtimeStage === "HUMAN" && "handover")} key={node.id}><div className="flow-node-top"><span className="flow-step">{String(index + 1).padStart(2, "0")}</span><Badge tone={prompt?.published_version_id ? "green" : "amber"}>{prompt?.published_version_id ? `prompt v${prompt.published_version_no}` : "unpublished"}</Badge></div><span className="flow-node-icon">{node.runtimeStage === "HUMAN" ? <UserRound /> : <Bot />}</span><h3>{node.label}</h3><code>{node.runtimeStage}</code><p>{node.description || meta.hint}</p><div className="flow-node-contract"><span><Sparkles size={14} /><strong>{node.promptCode}</strong></span><span><Zap size={14} />{meta.tool}</span></div>{index < graph.nodes.length - 1 && <span className="flow-node-arrow"><ArrowRight /></span>}</article>; })}</div>
        <div className="flow-output"><ShieldCheck /><div><strong>Grounded response validator</strong><small>Structured output · preserve facts · reject invented numbers · repair once · deterministic fallback</small></div><ArrowRight /><span><MessageSquareText />Messenger reply</span></div>
      </section>

      <aside className="flow-test card"><div className="flow-section-head"><div><span className="kicker">INTERACTIVE PREVIEW</span><h2>Test active flow</h2><p>This calls the same decision, tools, prompt and model path as Test Workspace.</p></div></div><label>Starting state<select value={testState} onChange={(event) => setTestState(event.target.value)}><option value="NEW">NEW</option><option value="ICE_BREAK">ICE_BREAK</option><option value="QUALIFICATION">QUALIFICATION</option><option value="QNA_COURSE">QNA_COURSE</option><option value="QNA_PRICE">QNA_PRICE</option></select></label><label>Customer message<textarea value={testMessage} onChange={(event) => setTestMessage(event.target.value)} /></label><button className="button primary full" onClick={() => void testFlow()} disabled={testing || !testMessage.trim()}>{testing ? <LoaderCircle className="spin" /> : <Zap />}{testing ? "Running real preview…" : "Run flow preview"}</button>{testResult ? <div className="flow-test-result"><div><Badge tone={testResult.provider === "openai-compatible" ? "green" : "amber"}>{testResult.provider}</Badge><span>{testResult.model}</span></div><dl><div><dt>Decision</dt><dd>{testResult.decision?.stage} · {testResult.decision?.route}</dd></div><div><dt>Prompt</dt><dd>{testResult.prompt?.code} · {testResult.prompt?.source}</dd></div><div><dt>Flow</dt><dd>{testResult.flow ? `${testResult.flow.code} v${testResult.flow.version}` : "fallback map"}</dd></div><div><dt>Validation</dt><dd>{testResult.validation?.valid && testResult.validation?.tool_policy ? "Passed" : "Failed"}</dd></div></dl><blockquote>{testResult.final}</blockquote>{testResult.error && <p className="flow-test-error">{testResult.error}</p>}</div> : <div className="flow-test-empty"><Workflow /><p>Run a message to see the exact stage, prompt version, tool policy, provider and final grounded response.</p></div>}</aside>
      </div>
    </> : <div className="empty"><Workflow /><strong>No conversation flow</strong><p>Create the first version and attach prompts to runtime stages.</p></div>}
    {editing && <FlowEditor flow={newFlow ? null : selected} prompts={prompts} close={() => setEditing(false)} done={() => { setEditing(false); setRefresh((value) => value + 1); setNotice("Draft flow version created"); }} />}
  </>;
}

function FlowEditor({ flow, prompts, close, done }: { flow: Row | null; prompts: Row[]; close: () => void; done: () => void }) {
  const template: FlowGraph = flow?.graph ?? {
    entryNodeId: "ice-break",
    nodes: [
      { id: "ice-break", label: "Ice Break", runtimeStage: "ICE_BREAK", promptCode: "ice-break", description: "Welcome the customer and discover the first learning signal" },
      { id: "qualification", label: "Qualification", runtimeStage: "QUALIFICATION", promptCode: "qualification", description: "Clarify background, goals, and preferences" },
      { id: "qna-course", label: "Course Q&A", runtimeStage: "QNA_COURSE", promptCode: "qna-course", description: "Answer from verified course facts" },
      { id: "qna-price", label: "Pricing Q&A", runtimeStage: "QNA_PRICE", promptCode: "qna-price", description: "Quote an effective pricing rule" },
      { id: "human", label: "Human Handover", runtimeStage: "HUMAN", promptCode: "handover-summary", description: "Stop automation and create an advisor case" }
    ],
    edges: []
  };
  const [name, setName] = useState(flow?.name ?? "Messenger Sales Assistant"); const [code, setCode] = useState(flow?.code ?? "messenger-sales-assistant-v2"); const [description, setDescription] = useState(flow?.description ?? "Customer response flow with versioned stage-to-prompt routing.");
  const [nodes, setNodes] = useState<FlowNode[]>(template.nodes); const [changeReason, setChangeReason] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  function update(index: number, key: keyof FlowNode, value: string) { setNodes((current) => current.map((node, position) => position === index ? { ...node, [key]: value } : node)); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const edges: FlowEdge[] = nodes.slice(0, -1).map((node, index) => ({ id: `edge-${index + 1}`, source: node.id, target: nodes[index + 1]!.id, label: index === 0 ? "needs discovered" : "stage signal" }));
    try { await post("/studio/flows", { code, name, description, graph: { entryNodeId: nodes[0]!.id, nodes, edges }, changeReason: changeReason || "Updated stage-to-prompt routing in Flow Studio" }); done(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The flow version could not be created."); }
    finally { setBusy(false); }
  }
  return <div className="modal-wrap"><button className="modal-scrim" aria-label="Close flow editor" onClick={close} /><form className="modal flow-editor-modal" onSubmit={submit}><div className="modal-head"><div><span className="kicker">VERSIONED RUNTIME CONFIG</span><h2>{flow ? `Create ${flow.name} v${Number(flow.version_no) + 1}` : "Create conversation flow"}</h2><p>A draft never changes production. Publish it, pin it in a release, and pass evaluation before activation.</p></div><button type="button" className="icon" onClick={close}><X /></button></div><div className="form-grid"><label>Flow name<input required value={name} onChange={(event) => setName(event.target.value)} /></label><label>Stable code<input required pattern="[a-z0-9-]+" disabled={Boolean(flow)} value={code} onChange={(event) => setCode(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} /></label><label className="wide">Description<input value={description} onChange={(event) => setDescription(event.target.value)} /></label></div><div className="flow-editor-head"><div><strong>Runtime stages</strong><small>Choose the prompt used after hard rules classify each message. Required tools remain enforced by runtime.</small></div><Link href="/studio/prompts"><Plus size={14} />Create a prompt first</Link></div><div className="flow-stage-editor">{nodes.map((node, index) => <div className="flow-stage-row" key={node.id}><GripVertical /><span className={`flow-stage-dot ${stageMeta[node.runtimeStage]?.tone ?? "violet"}`}>{index + 1}</span><label>Stage<input disabled value={node.runtimeStage} /></label><label>Display name<input required value={node.label} onChange={(event) => update(index, "label", event.target.value)} /></label><label>Response prompt<select required value={node.promptCode} onChange={(event) => update(index, "promptCode", event.target.value)}>{prompts.map((prompt) => <option value={prompt.code} key={prompt.code}>{prompt.name} · {prompt.published_version_id ? `published v${prompt.published_version_no}` : "not published"}</option>)}</select></label><label className="wide">Purpose<input value={node.description} onChange={(event) => update(index, "description", event.target.value)} /></label><span className="flow-stage-tool"><Zap size={13} />{stageMeta[node.runtimeStage]?.tool}</span></div>)}</div><label>Change reason<textarea value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder="Explain why this routing change is safer or more effective." /></label>{error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}<div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Save size={15} />}{busy ? "Creating…" : "Create draft version"}</button></div></form></div>;
}
