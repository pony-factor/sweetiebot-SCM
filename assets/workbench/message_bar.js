// Reorders the existing SCM message-bar controls without changing their behavior.
const SCM_TOOLKIT_MESSAGE_BAR_IDS = [
    'branch',
    'sync',
    'delete',
    'separator-1',
    'autocomplete',
    'codex',
    'auto-publish',
    'separator-2',
    'home',
    'pull-request',
    'pony-branch',
];

const SCM_TOOLKIT_DEFAULT_MESSAGE_BAR_LAYOUT = {
    before: ['branch'],
    after: [
        'sync',
        'delete',
        'separator-1',
        'autocomplete',
        'codex',
        'auto-publish',
        'separator-2',
        'home',
        'pull-request',
        'pony-branch',
    ],
};

function scmToolkitMessageBarLayout(raw) {
    let value = raw;
    try {
        if (typeof value === 'string') value = JSON.parse(value);
    } catch {
        value = undefined;
    }
    if (!value || typeof value !== 'object') return SCM_TOOLKIT_DEFAULT_MESSAGE_BAR_LAYOUT;

    const known = new Set(SCM_TOOLKIT_MESSAGE_BAR_IDS);
    const seen = new Set();
    const normalized = { before: [], after: [] };
    for (const zone of ['before', 'after']) {
        if (!Array.isArray(value[zone])) return SCM_TOOLKIT_DEFAULT_MESSAGE_BAR_LAYOUT;
        for (const id of value[zone]) {
            if (typeof id !== 'string' || !known.has(id) || seen.has(id)) {
                return SCM_TOOLKIT_DEFAULT_MESSAGE_BAR_LAYOUT;
            }
            seen.add(id);
            normalized[zone].push(id);
        }
    }
    return normalized;
}

function scmToolkitMessageBarElements(widget) {
    const root = widget.element;
    return {
        branch: root.querySelector(':scope > .scm-toolkit-branch'),
        sync: root.querySelector(':scope > .scm-toolkit-sync-branch'),
        delete: root.querySelector(':scope > .scm-toolkit-delete-branch'),
        'separator-1': root.querySelectorAll(':scope > .scm-toolkit-divider')[0],
        autocomplete: root.querySelector(':scope > .scm-toolkit-autocomplete'),
        codex: root.querySelector(':scope > .scm-toolkit-codex-coauthor'),
        'auto-publish': root.querySelector(':scope > .scm-toolkit-auto-publish'),
        'separator-2': root.querySelectorAll(':scope > .scm-toolkit-divider')[1],
        home: root.querySelector(':scope > .scm-toolkit-home'),
        'pull-request': root.querySelector(':scope > .scm-toolkit-pull-request'),
        'pony-branch': root.querySelector(':scope > .scm-toolkit-pony-branch'),
    };
}

function scmToolkitRefreshMessageBarSeparators(layout, elements) {
    for (const zone of ['before', 'after']) {
        const ids = layout[zone];
        for (let index = 0; index < ids.length; index += 1) {
            const id = ids[index];
            if (!id.startsWith('separator-')) continue;
            const divider = elements[id];
            if (!divider?.isConnected) continue;
            const before = ids.slice(0, index).some(candidate => {
                const element = elements[candidate];
                return element?.isConnected && !element.hidden && !candidate.startsWith('separator-');
            });
            const after = ids.slice(index + 1).some(candidate => {
                const element = elements[candidate];
                return element?.isConnected && !element.hidden && !candidate.startsWith('separator-');
            });
            divider.hidden = !(before && after);
        }
    }
}

function scmToolkitApplyMessageBarLayout(widget, settings) {
    const layout = scmToolkitMessageBarLayout(settings.messageBarLayout);
    const elements = scmToolkitMessageBarElements(widget);
    const editor = widget.element.querySelector(':scope > .scm-editor-container');
    const push = widget.element.querySelector(':scope > .scm-toolkit-push');
    if (!editor || !push || Object.values(elements).some(element => !element)) return;

    const visible = new Set([...layout.before, ...layout.after]);
    for (const [id, element] of Object.entries(elements)) {
        if (!visible.has(id)) element.remove();
    }

    for (const id of layout.before) editor.before(elements[id]);
    editor.after(push, ...layout.after.map(id => elements[id]));

    const refreshSeparators = () => scmToolkitRefreshMessageBarSeparators(layout, elements);
    const Observer = widget.element.ownerDocument.defaultView?.MutationObserver;
    if (Observer) {
        const observer = new Observer(refreshSeparators);
        for (const [id, element] of Object.entries(elements)) {
            if (!id.startsWith('separator-')) {
                observer.observe(element, { attributes: true, attributeFilter: ['hidden'] });
            }
        }
        widget.disposables.add({ dispose: () => observer.disconnect() });
    }

    refreshSeparators();
    return refreshSeparators;
}

const scmToolkitCreateControlsWithoutMessageBarLayout = scmToolkitCreateControls;
scmToolkitCreateControls = function(...args) {
    const [widget, _observe, _commands, _notifications, _configuration, _mcpService, settings] = args;
    const controls = scmToolkitCreateControlsWithoutMessageBarLayout(...args);
    const refreshSeparators = scmToolkitApplyMessageBarLayout(widget, settings) ?? (() => {});
    const bindWithoutMessageBarLayout = controls.bind.bind(controls);
    controls.bind = input => {
        bindWithoutMessageBarLayout(input);
        refreshSeparators();
    };
    return controls;
};
