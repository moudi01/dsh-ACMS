export function beginPanelRewind(previous, epoch) {
  if (!previous?.state || epoch !== previous.epoch) return previous;
  return { state: null, request: previous.request, epoch: epoch + 1 };
}

export function selectPanelSnapshot(previous, state, request, epoch) {
  if (previous && epoch !== previous.epoch) return previous;
  if (previous?.state && (state.cursor < previous.state.cursor ||
      (state.cursor === previous.state.cursor && request <= previous.request))) return previous;
  return { state, request, epoch };
}
