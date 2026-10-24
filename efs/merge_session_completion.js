"use strict";
const pending = new WeakMap();
function updateMergeSessionCompletion(vscode, selection, state, schedule = setTimeout, cancel = clearTimeout) {
  if (state?.repository !== selection.repository || !Array.isArray(state.deferred)) return;
  const settled = new Set([...(state.merged || []), ...state.deferred].map(item => item.number));
  const complete = !state.rateLimit && selection.pullRequests.every(pr => settled.has(pr.number));
  const prior = pending.get(vscode.window);
  if (!complete) {
    if (prior) cancel(prior);
    pending.delete(vscode.window);
    return;
  }
  if (prior) return;
  // Let the callback finish delivering its response before removing its tab.
  const timer = schedule(() => {
    pending.delete(vscode.window);
    const tabs = (vscode.window.tabGroups?.all || []).flatMap(group => group.tabs)
      .filter(tab => tab.label === 'Lindsey · Local merge');
    if (tabs.length) void Promise.resolve(vscode.window.tabGroups.close(tabs)).catch(() => {});
  }, 1500);
  timer?.unref?.();
  pending.set(vscode.window, timer);
}
module.exports = {updateMergeSessionCompletion};
