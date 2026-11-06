import React from 'react';
import { createRoot } from 'react-dom/client';
window.__ModuleLoader__ = { load({ factory }) {
  const plugin = factory(name => { if (name === 'react') return React; throw new Error(`Unexpected shared module: ${name}`); });
  const ctx = { effect: fn => fn(), slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => { if (options.name === 'main') createRoot(document.getElementById('root')).render(React.createElement(component)); },
  } };
  plugin.apply(ctx);
} };
const script = document.createElement('script'); script.src = '/client.js'; document.head.append(script);
