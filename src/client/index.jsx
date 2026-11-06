import React from 'react';
import { App, Logo } from './app.jsx';
import css from './style.css';
export function apply(ctx) {
  ctx.effect(() => { const element = document.createElement('style'); element.dataset.plugin = 'dsh-acms'; element.textContent = css; document.head.append(element); return () => element.remove(); });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'acms', label: 'ACMS' }, App));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'acms', order: 34, label: 'ACMS' }, Logo));
}
export const inject = ['slots'];
