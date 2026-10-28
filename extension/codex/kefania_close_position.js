'use strict';

const POSITIONS = new Set(['left', 'middle', 'right']);

function normalizeKefaniaClosePosition(value) {
  return POSITIONS.has(value) ? value : 'left';
}

// The saved dropdown wins. Preserve an old right-side choice until then,
// because VS Code exposes the new schema's default even if it isn't configured.
function kefaniaClosePosition(configuration) {
  const modern = configuration.get('kefaniaCloseButtonPosition', 'left');
  const details = configuration.inspect?.('kefaniaCloseButtonPosition');
  const explicitlySet = details && [
    'globalValue', 'workspaceValue', 'workspaceFolderValue',
  ].some(key => details[key] !== undefined);
  if (details && !explicitlySet && configuration.get('kefaniaCloseButtonLeft', true) === false) {
    return 'right';
  }
  return normalizeKefaniaClosePosition(modern);
}

module.exports = {kefaniaClosePosition, normalizeKefaniaClosePosition};
