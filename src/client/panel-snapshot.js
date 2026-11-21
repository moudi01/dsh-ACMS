export function selectPanelSnapshot(previous, state, request, epoch, rewindFrom) {
  if (!previous) return { state, request, epoch };
  if (epoch !== previous.epoch) return previous;
  const older = state.cursor < previous.state.cursor;
  const rewound = older && rewindFrom !== null && state.cursor < rewindFrom;
  if (!rewound && (older || (state.cursor === previous.state.cursor && request <= previous.request))) return previous;
  return { state, request, epoch: previous.epoch + Number(rewound) };
}
