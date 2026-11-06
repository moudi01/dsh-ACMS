/** Model IDs are user-facing; executor/provider routes remain explicit underneath. */
export function initialModelBinding(agent, runtime) {
  if (!agent.id) return runtime.modelCatalog?.defaultSelection ?? { provider: 'auto', model: '', llmProvider: '' };
  return { provider: agent.provider ?? 'auto', model: agent.model || runtime.providers.find(p => p.name === agent.provider)?.model || '', llmProvider: agent.llmProvider ?? '', reasoningEffort: agent.reasoningEffort ?? '' };
}
export function modelName(agent, runtime) {
  return agent.model || runtime.providers.find(p => p.name === agent.provider)?.model || ((agent.provider ?? 'auto') === 'auto' ? runtime.modelCatalog?.defaultSelection?.model : null) || '模型未声明';
}
