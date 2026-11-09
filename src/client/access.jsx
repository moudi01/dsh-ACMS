import React, { useMemo, useState } from "react";
import { api } from "./api.js";
import { Field } from "./components.jsx";
const COMMANDS = [
  ["goal.submit", "提交目标"],
  ["status.read", "查询状态"],
  ["events.read", "读取事件"],
  ["interaction.answer", "回复交互"],
  ["task.pause", "暂停任务"],
  ["task.resume", "恢复任务"],
  ["goal.pause", "暂停目标"],
  ["goal.resume", "恢复目标"],
  ["goal.cancel", "取消目标"],
  ["project.create", "创建受限项目"]
];
const READ_COMMANDS = ["status.read", "events.read"];
const DEFAULT_COMMANDS = ["goal.submit", "status.read", "events.read", "interaction.answer"];
function date(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function goalScopeText(scope) {
  if (!scope) return "—";
  if (scope.allGoals) return "项目内全部目标（只读）";
  const ids = scope.goalIds ?? [];
  if (!ids.length) return "本凭据提交的目标（未指定固定目标）";
  return "指定目标：" + ids.join("、") + "（另含本凭据提交的目标）";
}
function Empty({ title, children }) { return <div className="acms-empty"><span className="acms-empty-mark">⇄</span><h3>{title}</h3><p>{children}</p></div>; }
export function AccessPage({ data, refresh }) {
  const [form, setForm] = useState({ name: "外部用户代理", projectId: "", goalId: "", commands: [...DEFAULT_COMMANDS], allGoals: false, projectCreate: false, expiresAt: "" });
  const [issued, setIssued] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [copied, setCopied] = useState("");
  const projects = (data.projects ?? []).filter(project => project.status !== "deleted");
  const goals = useMemo(() => (data.goals ?? []).filter(goal => goal.projectId === form.projectId && goal.status !== "deleted"), [data.goals, form.projectId]);
  const credentials = data.agentCredentials ?? [];
  const update = (key, value) => setForm(current => ({ ...current, [key]: value, ...(key === "projectId" ? { goalId: "" } : {}) }));
  const toggleCommand = command => setForm(current => {
    if (current.allGoals && !READ_COMMANDS.includes(command)) return current;
    const commands = current.commands.includes(command) ? current.commands.filter(item => item !== command) : [...current.commands, command];
    return { ...current, commands, ...(command === "project.create" ? { projectCreate: false } : {}) };
  });
  const toggleAllGoals = checked => setForm(current => ({ ...current, allGoals: checked, projectCreate: checked ? false : current.projectCreate, commands: checked ? [...READ_COMMANDS] : current.commands }));
  const toggleProjectCreate = checked => setForm(current => ({ ...current, projectCreate: checked, commands: checked ? [...new Set([...current.commands, "project.create"])] : current.commands.filter(item => item !== "project.create") }));
  const copy = async () => { try { await navigator.clipboard.writeText(issued.token); setCopied("已复制到剪贴板"); } catch { setCopied("浏览器拒绝剪贴板访问，请手动选择令牌复制"); } };
  const submit = async event => {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      if (!form.projectId) throw new Error("请选择凭据可访问的项目范围");
      if (!form.commands.length) throw new Error("至少选择一项允许的命令");
      const args = { name: form.name.trim(), projectIds: [form.projectId], goalIds: form.goalId ? [form.goalId] : [], allGoals: form.allGoals, commands: form.commands };
      if (form.projectCreate) args.projectCreate = true;
      if (form.expiresAt) args.expiresAt = new Date(form.expiresAt + "T23:59:59").toISOString();
      const result = await api.command("agentCredential.create", args);
      setIssued(result); setCopied(""); await refresh();
    } catch (exception) { setError(exception.code ? exception.code + " · " + exception.message : exception.message); }
    finally { setBusy(false); }
  };
  const revoke = async credential => {
    setBusy(true); setError("");
    try { await api.command("agentCredential.revoke", { credentialId: credential.id, expectedRevision: credential.revision }); setIssued(current => current && current.credential.id === credential.id ? null : current); await refresh(); }
    catch (exception) { setError(exception.code ? exception.code + " · " + exception.message : exception.message); }
    finally { setBusy(false); }
  };
  return <><div className="acms-pagehead"><div><div className="acms-eyebrow">EXTERNAL AGENTS</div><h1>外部接入</h1><p>签发有明确项目和命令范围的凭据，交给外部用户代理。明文令牌只显示一次，保存后即可关闭工作台，由代理通过本机 v1 接口继续工作。</p></div></div><div className="acms-overview-grid"><section className="acms-panel"><div className="acms-sectionhead"><h2>签发凭据</h2><span>OWNER ONLY</span></div><form className="acms-credential-form" onSubmit={submit}><Field label="凭据名称" hint="用于在凭据列表中识别使用方。"><input required maxLength={200} value={form.name} onChange={event => update("name", event.target.value)} /></Field><Field label="项目范围" hint="凭据只能访问所选项目及其目标。"><select required value={form.projectId} onChange={event => update("projectId", event.target.value)}><option value="">选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label="目标范围（可选）" hint="留空时，凭据只能访问其自己提交的目标；指定后，可访问该目标以及本凭据提交的目标。"><select value={form.goalId} disabled={!form.projectId || form.allGoals} onChange={event => update("goalId", event.target.value)}><option value="">不限定单个目标</option>{goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></Field><Field label="有效期（可选）" hint="留空表示长期有效；到期后请求统一返回 401。"><input type="date" value={form.expiresAt} onChange={event => update("expiresAt", event.target.value)} /></Field><div className="acms-field"><label>允许命令</label><div className="acms-checkgrid">{COMMANDS.map(([command, label]) => <label className="acms-check" key={command}><input type="checkbox" checked={form.commands.includes(command)} disabled={form.allGoals && !READ_COMMANDS.includes(command)} onChange={() => toggleCommand(command)} /><span>{label}</span><code>{command}</code></label>)}</div></div><div className="acms-field"><label className="acms-check"><input type="checkbox" checked={form.allGoals} onChange={event => toggleAllGoals(event.target.checked)} /><span>只读监控项目内全部目标（allGoals）</span></label><label className="acms-check"><input type="checkbox" checked={form.projectCreate} disabled={form.allGoals} onChange={event => toggleProjectCreate(event.target.checked)} /><span>允许创建受限项目（projectCreate）</span></label></div>{error && <p role="alert" className="acms-field-error">{error}</p>}<div className="acms-actions"><button type="submit" className="primary" disabled={busy}>{busy ? "正在签发…" : "签发凭据"}</button></div></form></section><section className="acms-panel"><div className="acms-sectionhead"><h2>已签发凭据</h2><span>只显示脱敏前缀</span></div>{issued ? <section className="acms-alert" data-testid="credential-issued" aria-live="polite"><h3>凭据已签发，明文令牌只显示这一次</h3><p>立即复制并保存到仅当前 Windows 用户可读的文件，例如 <code>%USERPROFILE%\.dsh\acms\agent-token</code>。关闭或刷新页面后无法再次读取。</p><code className="acms-token" data-testid="credential-token">{issued.token}</code><div className="acms-actions"><button type="button" onClick={copy}>复制令牌</button>{copied && <span className="acms-muted">{copied}</span>}</div><dl className="acms-definition"><dt>凭据</dt><dd>{issued.credential.name}（{issued.credential.tokenPrefix}）</dd><dt>项目</dt><dd>{issued.credential.scope.projectIds.map(id => projects.find(project => project.id === id)?.name ?? id).join("、")}</dd><dt>目标</dt><dd>{goalScopeText(issued.credential.scope)}</dd><dt>命令</dt><dd>{issued.credential.scope.commands.join("、")}</dd><dt>到期</dt><dd>{date(issued.credential.expiresAt)}</dd></dl></section> : !credentials.length ? <Empty title="还没有外部凭据">签发后，代理只能使用这里列出的项目、目标和命令范围，不能伪造 owner。</Empty> : <div className="acms-credential-list">{credentials.map(credential => <article className="acms-credential" key={credential.id}><div className="acms-sectionhead"><h3>{credential.name}</h3><span className="acms-badge" data-status={credential.status}>{credential.status === "active" ? "有效" : "已撤销"}</span></div><p>前缀 <code>{credential.tokenPrefix}</code> · 创建 {date(credential.createdAt)} · 最近使用 {date(credential.lastUsedAt)}</p><p>项目：{credential.scope.projectIds.map(id => projects.find(project => project.id === id)?.name ?? id).join("、")}；目标：{goalScopeText(credential.scope)}</p><p>命令：{credential.scope.commands.join("、")}；到期：{date(credential.expiresAt)}</p><div className="acms-actions"><button type="button" disabled={busy || credential.status !== "active"} onClick={() => revoke(credential)}>撤销凭据</button></div></article>)}</div>}</section></div></>;
}
