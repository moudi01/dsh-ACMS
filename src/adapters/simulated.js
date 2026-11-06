import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Deterministic testing provider. Never registered in a production DSH profile. */
export class SimulatedAdapter {
  constructor(handler, options = {}) { this.handler = handler; this.delay = options.delay ?? 10; this.active = 0; this.maxActive = 0; this.calls = []; }
  providers() { return [{ name: 'simulation', persistent: true, capabilities: {} }]; }
  async start(input) {
    this.active++; this.maxActive = Math.max(this.active, this.maxActive); this.calls.push(input);
    let timer; let resolveStop; const stopped = new Promise(resolve => { resolveStop = resolve; }); let disposed = false;
    const dispose = async () => { if (disposed) return; disposed = true; clearTimeout(timer); this.active--; resolveStop(); };
    const result = new Promise((resolve, reject) => {
      const abort = () => { reject(input.signal.reason ?? new Error('aborted')); }; input.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(async () => {
        try { input.signal.throwIfAborted(); resolve(await this.handler(input)); } catch (e) { reject(e); }
        finally { input.signal.removeEventListener('abort', abort); }
      }, this.delay);
    });
    return { childId: `sim-${input.attempt.id}`, provider: 'simulation', result, dispose, stopped };
  }
  async reconcile() { return { status: 'stopped', reason: 'Simulation has no external process or side effects' }; }
  async chat({ signal, onAccepted, onText }) {
    signal.throwIfAborted(); onAccepted();
    const text = '模拟智能体回复：已收到你的问题。这是隔离测试会话，没有启动业务任务。'; onText(text); return text;
  }
  async close() {}
}
export async function defaultSimulation({ task }) {
  if (task.kind === 'plan') return { outcome: 'planned', summary: '模拟拆解完成', tasks: [
    { key: 'deliver', title: '生成示例交付物', description: '创建可审查的交付文件', acceptance: '包含任务说明和验证结果', dependencies: [] },
    { key: 'handoff', title: '整理交接说明', description: '基于前一步交付物创建交接说明', acceptance: '交接文档存在且可读', dependencies: ['deliver'] },
  ] };
  if (task.kind === 'review') return { outcome: 'reviewed', decision: 'approve', summary: '模拟审查通过', findings: ['交付物存在，检查证据对应提交版本。'] };
  await fs.writeFile(path.join(task.workspace.path, 'deliverable.md'), `# ${task.title}\n\nThis is a deterministic simulation artifact, not an AI-produced deliverable.\n`);
  return { outcome: 'completed', summary: '模拟交付已生成', artifacts: [{ path: 'deliverable.md', title: task.title }] };
}
