'use strict';

// Called from the native Source Control Graph history-item renderer. Keep the
// original context-menu action and reuse its prepared native metadata hover.
function scmToolkitGraphCommitActions(actions, hoverService, row, content, hoverOptions) {
  if (!Array.isArray(actions) || typeof hoverService?.showInstantHover !== 'function') {
    return actions;
  }
  return actions.map(action => {
    if (action.id !== 'workbench.scm.action.graph.viewChanges') return action;
    const commitAction = Object.create(action);
    Object.defineProperties(commitAction, {
      id: { value: 'sweetiebot.graph.openCommit', enumerable: true },
      label: { value: 'Open Commit', enumerable: true },
      tooltip: { value: 'Open Commit', enumerable: true },
      class: { value: 'codicon codicon-git-commit', enumerable: true },
      run: { value: () => hoverService.showInstantHover({
        ...hoverOptions,
        target: row,
        content
      }, true), enumerable: true }
    });
    return commitAction;
  });
}
