// Separate host process for crash/restart tests; never connects to a real model.
import { readFileSync } from 'node:fs';
import { PairedRuntimes } from '../../src/adapters/paired.js';
import { DshAdapter } from '../../src/adapters/dsh.js';
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const company = { store: { require: () => plan.model, list: () => [] }, policy: () => ({ turnTimeoutMs: 5000 }) };
const paired = new PairedRuntimes(company, plan.dataDir);
if (process.argv[3] === 'read') {
  const adapter = new DshAdapter({ subagents: { providers: new Map() } }, company, plan.dataDir, { paired });
  console.log(JSON.stringify(await adapter.reconcile(plan.attempt)));
} else {
  const input = { ...plan.input, onAccepted: plan.crash ? () => { setTimeout(() => process.exit(86), 150); } : undefined };
  console.log(JSON.stringify(await paired.run(plan.model.id, input)));
}
