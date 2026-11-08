import React, { useId, useRef, useState } from 'react';
import { api } from './api.js';

export function Field({ label, children, hint }) {
  const generated = useId(); const id = children.props.id ?? generated;
  return <div className="acms-field"><label htmlFor={id}>{label}</label>{React.cloneElement(children, { id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) })}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
export function ActionButton({ reason = '', compact = false, children, ...props }) {
  const id = useId();
  return <span className="acms-action-control"><button {...props} disabled={!!reason} title={reason || props.title} aria-describedby={reason ? id : undefined}>{children}</button>{reason && <small id={id} className={compact ? 'acms-visually-hidden' : 'acms-disabled-reason'}>{reason}</small>}</span>;
}
/**
 * Bounded text summary with an accessible expand/collapse control. Disclosure
 * state is local to the text itself, so a data refresh never force-closes it.
 */
export function CollapsibleText({ text, lines = 3, className = '', label = '全文', threshold = 140 }) {
  const [open, setOpen] = useState(false);
  const value = String(text ?? '').trim();
  if (!value) return null;
  const long = value.length > threshold || value.split('\n').length > 2;
  return <div className={`acms-collapsible${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
    <p style={{ '--acms-clamp-lines': lines }}>{value}</p>
    {long && <button type="button" className="text acms-expand-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? `收起${label}` : `展开${label}`}</button>}
  </div>;
}
export function DirectoryField({ value = '', onChange, label = '项目目录', hint = '可直接粘贴完整路径，或点击选择目录。' }) {
  const [listing, setListing] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const input = useRef();
  const browse = async directory => { setBusy(true); setError(''); try { setListing(await api.directories(directory)); } catch (e) { setError(`无法浏览目录：${e.message}`); } finally { setBusy(false); } };
  const pick = async () => {
    setError('');
    if (globalThis.__DSH_DIRECTORY_PICKER__?.pick) {
      setBusy(true);
      try { const selected = await globalThis.__DSH_DIRECTORY_PICKER__.pick(); if (typeof selected === 'string') onChange(selected); return; }
      catch { setError('系统目录选择器暂不可用，可在下方浏览目录。'); }
      finally { setBusy(false); }
    }
    await browse('');
  };
  const paste = async () => { try { const text = await navigator.clipboard.readText(); if (!text.trim()) throw new Error('剪贴板没有文字路径'); onChange(text.trim().replace(/^"([\s\S]*)"$/, '$1')); setError(''); } catch { setError('无法读取剪贴板。请点击路径输入框后按 Ctrl+V，或使用“选择目录”。'); } };
  return <div className="acms-directory-field">
    <Field label={label} hint={hint}><input ref={input} required value={value} spellCheck={false} placeholder="例如 D:\\Projects\\my-project" onChange={e => onChange(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && ['a', 'c', 'v', 'x', 'z'].includes(e.key.toLowerCase())) e.stopPropagation(); }} onPaste={e => {
      const text = e.clipboardData.getData('text/plain'); if (!text) return; e.preventDefault(); e.stopPropagation();
      const element = e.currentTarget; const start = element.selectionStart ?? value.length; const end = element.selectionEnd ?? start;
      onChange(value.slice(0, start) + text + value.slice(end)); requestAnimationFrame(() => input.current?.setSelectionRange(start + text.length, start + text.length));
    }} /></Field>
    <div className="acms-actions"><ActionButton type="button" reason={busy ? '正在读取目录，请稍候' : ''} onClick={pick}>选择目录</ActionButton><button type="button" onClick={paste}>粘贴路径</button></div>
    {error && <p role="alert" className="acms-field-error">{error}</p>}
    {listing && <section className="acms-directory-browser" aria-label="浏览项目目录"><div className="acms-sectionhead"><b>{listing.path || '选择磁盘或根目录'}</b><button type="button" onClick={() => setListing(null)}>关闭目录浏览</button></div>
      {listing.path && <div className="acms-actions"><button type="button" onClick={() => browse(listing.parent ?? '')}>上一级</button><button type="button" className="primary" onClick={() => { onChange(listing.path); setListing(null); }}>使用此目录</button></div>}
      <div className="acms-directory-list">{listing.directories.map(d => <button type="button" key={d.path} onClick={() => browse(d.path)}>▱ {d.name}</button>)}{!listing.directories.length && <p>此目录没有子文件夹，可以选择当前目录。</p>}</div>
    </section>}
  </div>;
}
