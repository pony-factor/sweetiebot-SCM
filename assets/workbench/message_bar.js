// Reorders the existing SCM message-bar controls without changing their behavior.
const SCM_TOOLKIT_MESSAGE_BAR_IDS = [
    'push',
    'branch',
    'sync',
    'delete',
    'separator-1',
    'autocomplete',
    'spellcheck',
    'post-spellcheck',
    'codex',
    'auto-publish',
    'separator-2',
    'home',
    'pull-request',
    'pony-branch',
];

const SCM_TOOLKIT_DEFAULT_MESSAGE_BAR_LAYOUT = {
    before: ['branch', 'codex'],
    after: [
        'push',
        'sync',
        'delete',
        'separator-1',
        'autocomplete',
        'spellcheck',
        'post-spellcheck',
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
            if (typeof id !== 'string' || (!known.has(id) && !/^separator-[1-9][0-9]*$/.test(id)) || seen.has(id)) {
                return SCM_TOOLKIT_DEFAULT_MESSAGE_BAR_LAYOUT;
            }
            seen.add(id);
            normalized[zone].push(id);
        }
    }
    // Old pinned layouts predate the post-commit toggle. Keep it accessible
    // without resetting the user's other message-bar placements.
    if (!seen.has('post-spellcheck')) {
        const afterSpellcheck = normalized.after.indexOf('spellcheck');
        if (afterSpellcheck >= 0) normalized.after.splice(afterSpellcheck + 1, 0, 'post-spellcheck');
        else normalized.after.unshift('post-spellcheck');
    }
    return normalized;
}

function scmToolkitMessageBarElements(widget) {
    const root = widget.element;
    return {
        push: root.querySelector(':scope > .scm-toolkit-push'),
        branch: root.querySelector(':scope > .scm-toolkit-branch'),
        sync: root.querySelector(':scope > .scm-toolkit-sync-branch'),
        delete: root.querySelector(':scope > .scm-toolkit-delete-branch'),
        'separator-1': root.querySelectorAll(':scope > .scm-toolkit-divider')[0],
        autocomplete: root.querySelector(':scope > .scm-toolkit-autocomplete'),
        spellcheck: root.querySelector(':scope > .scm-toolkit-spellcheck'),
        'post-spellcheck': root.querySelector(':scope > .scm-toolkit-post-spellcheck'),
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

function scmToolkitResponsiveMessageBar(widget, layout, elements, editor, controls) {
    const root = widget.element, win = root.ownerDocument.defaultView;
    if (!win?.ResizeObserver || !widget.inputEditor?.layout || !widget.getContentHeight) return;
    root.classList.add('scm-toolkit-responsive-message-bar');
    const groups = [];
    for (const zone of ['before', 'after']) {
        let ids = [];
        for (const id of layout[zone]) {
            if (id.startsWith('separator-') && ids.length) { groups.push({ zone, ids }); ids = []; }
            ids.push(id);
        }
        if (ids.length) groups.push({ zone, ids });
    }
    const breaks = groups.filter(group => group.zone === 'after').map(group => {
        const node = root.ownerDocument.createElement('span');
        node.className = 'scm-toolkit-message-break'; node.hidden = true;
        elements[group.ids[0]].before(node);
        return { node, group };
    });
    const nativeHeight = widget.getContentHeight.bind(widget), nativeLayout = widget.inputEditor.layout;
    const nativeEvent = widget.onDidChangeContentHeight, listeners = new Set();
    const nativeWidth = controls.width.bind(controls);
    let extra = 0, reserved = 0, queued = false, disposed = false;
    widget.getContentHeight = () => nativeHeight() + extra;
    widget.inputEditor.layout = function(dimension, ...args) {
        return nativeLayout.call(this, { ...dimension, height: Math.max(1, dimension.height - extra) }, ...args);
    };
    if (nativeEvent) widget.onDidChangeContentHeight = (listener, ...args) => {
        listeners.add(listener);
        const subscription = nativeEvent.call(widget, listener, ...args);
        return { dispose() { listeners.delete(listener); subscription.dispose(); } };
    };
    const width = ids => ids.reduce((total, id) => {
        const node = elements[id];
        return total + (!node?.hidden && node?.isConnected ? node.getBoundingClientRect().width : 0);
    }, 0);
    const update = () => {
        queued = false; if (disposed) return;
        const baseAvailable = Math.max(0, root.clientWidth - (widget.getToolbarWidth?.() || 0));
        const extras = [...root.children].filter(node => node.matches('.scm-toolkit-settings, .scm-toolkit-stacked-branch') && !node.hidden)
            .reduce((sum, node) => sum + node.getBoundingClientRect().width, 0);
        const available = Math.max(0, baseAvailable - extras);
        if (!available) return;
        const minimum = Math.min(128, available);
        editor.style.minWidth = minimum + 'px';
        const before = groups.filter(group => group.zone === 'before').reduce((sum, group) => sum + width(group.ids), 0);
        let used = before + minimum, wrapped = false;
        reserved = before + extras;
        for (const { node, group } of breaks) {
            const size = width(group.ids);
            const wrap = size > 0 && used > 0 && used + size > available;
            node.hidden = !wrap;
            if (wrap) { used = 0; wrapped = true; }
            used += size;
            if (!wrapped) reserved += size;
        }
        reserved = Math.min(reserved, Math.max(0, baseAvailable - minimum));
        const next = Math.max(0, Math.ceil(root.scrollHeight - editor.getBoundingClientRect().height));
        if (next !== extra) { extra = next; for (const listener of listeners) listener(); }
        widget.layout();
    };
    const schedule = () => { if (!queued && !disposed) { queued = true; win.requestAnimationFrame(update); } };
    controls.width = () => reserved;
    const resize = new win.ResizeObserver(schedule); resize.observe(root);
    const mutations = new win.MutationObserver(schedule);
    for (const node of Object.values(elements)) mutations.observe(node, { attributes: true, attributeFilter: ['hidden'] });
    widget.disposables.add({ dispose() {
        disposed = true; resize.disconnect(); mutations.disconnect(); breaks.forEach(({ node }) => node.remove());
        widget.getContentHeight = nativeHeight; widget.inputEditor.layout = nativeLayout; widget.onDidChangeContentHeight = nativeEvent;
        controls.width = nativeWidth;
        root.classList.remove('scm-toolkit-responsive-message-bar'); editor.style.removeProperty('min-width');
    } });
    schedule();
}

function scmToolkitApplyMessageBarLayout(widget, settings, controls) {
    const layout = scmToolkitMessageBarLayout(settings.messageBarLayout);
    const elements = scmToolkitMessageBarElements(widget);
    const editor = widget.element.querySelector(':scope > .scm-editor-container');
    const push = widget.element.querySelector(':scope > .scm-toolkit-push');
    if (!editor || !push || Object.values(elements).some(element => !element)) return;

    for (const id of [...layout.before, ...layout.after]) {
        if (id.startsWith('separator-') && !elements[id]) {
            const divider = widget.element.ownerDocument.createElement('span');
            divider.className = 'scm-toolkit-divider';
            divider.setAttribute('aria-hidden', 'true');
            elements[id] = divider;
        }
    }

    const visible = new Set([...layout.before, ...layout.after]);
    for (const [id, element] of Object.entries(elements)) {
        if (!visible.has(id)) element.remove();
    }

    for (const id of layout.before) editor.before(elements[id]);
    editor.after(...layout.after.map(id => elements[id]));

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
    scmToolkitResponsiveMessageBar(widget, layout, elements, editor, controls);
    return refreshSeparators;
}

const scmToolkitCreateControlsWithoutMessageBarLayout = scmToolkitCreateControls;
scmToolkitCreateControls = function(...args) {
    const [widget, _observe, _commands, _notifications, _configuration, _mcpService, settings] = args;
    const layout = scmToolkitMessageBarLayout(settings.messageBarLayout);
    const active = new Set([...layout.before, ...layout.after]);
    const layoutSettings = {
        ...settings,
        commitAndPush: active.has('push'),
        branchPicker: ['branch', 'sync', 'home'].some(id => active.has(id)),
        ponyBranch: active.has('pony-branch'),
        branchCleanup: active.has('delete'),
        autocompleteToggle: active.has('autocomplete'),
        codexCoauthor: active.has('codex'),
        autoPublishToggle: active.has('auto-publish'),
        mcpPullRequest: active.has('pull-request'),
    };
    args[6] = layoutSettings;
    const controls = scmToolkitCreateControlsWithoutMessageBarLayout(...args);
    const refreshSeparators = scmToolkitApplyMessageBarLayout(widget, settings, controls) ?? (() => {});
    const bindWithoutMessageBarLayout = controls.bind.bind(controls);
    controls.bind = input => {
        bindWithoutMessageBarLayout(input);
        refreshSeparators();
    };
    return controls;
};
