// Use the folder itself as Explorer input whenever it is the only healthy root.
// Keep the saved workspace identity, settings, and extension host intact.
function scmToolkitIsSingleRoot(workspace, roots) {
    return Array.isArray(roots) && roots.length === 1 && !!roots[0] && !roots[0].error;
}

// Runs inside VS Code's SCM input widget; services and observables are supplied by install.py.
function scmToolkitRequestIndependentWorkspaceTrust(localUserHome, requests) {
    // Derive the only permitted target inside the workbench. Command arguments
    // cannot redirect this request to a different folder or grant trust silently.
    const uri = localUserHome.with({
        path: localUserHome.path.replace(/\/$/, '') + '/Library/Application Support/Sweetiebot/Workspaces'
    });
    return requests.requestResourcesTrust({
        uri,
        message: 'Sweetiebot uses this parent folder for independent workspaces. ' +
            'Trusting it enables extensions, terminals, and tasks for ALL existing and future repositories inside it. ' +
            'Only approve if you trust every repository placed here.'
    });
}

function scmToolkitDeferActionButtonUpdate(widget, button) {
    let state = widget.scmToolkitPressState;
    if (!state) {
        const container = widget.container;
        const doc = container.ownerDocument;
        const view = doc.defaultView;
        state = widget.scmToolkitPressState = { pressed: false, queued: false };
        const release = () => {
            if (!state.pressed) return;
            // Mouseup is followed by click. Keep the old DOM and its command
            // listener alive through both events, then apply the latest update.
            view.clearTimeout(state.timer);
            state.timer = view.setTimeout(() => {
                state.pressed = false;
                if (state.queued) {
                    state.queued = false;
                    widget.setButton(state.button);
                }
            }, 0);
        };
        const press = event => {
            if (event.button !== 0 || !event.target.closest?.('.monaco-button')) return;
            view.clearTimeout(state.timer);
            state.pressed = true;
        };
        container.addEventListener('pointerdown', press, true);
        doc.addEventListener('pointerup', release, true);
        doc.addEventListener('pointercancel', release, true);
        view.addEventListener('blur', release);
        state.dispose = () => {
            view.clearTimeout(state.timer);
            container.removeEventListener('pointerdown', press, true);
            doc.removeEventListener('pointerup', release, true);
            doc.removeEventListener('pointercancel', release, true);
            view.removeEventListener('blur', release);
        };
    }
    if (!state.pressed) return false;
    state.button = button;
    state.queued = true;
    return true;
}

function scmToolkitDisposeActionButton(widget) {
    widget.scmToolkitPressState?.dispose();
    widget.scmToolkitPressState = undefined;
}

function scmToolkitCustomizeSyncLabels(widget, configuration, settings) {
    const doc = widget.element.ownerDocument;
    const Observer = doc.defaultView?.MutationObserver;
    if (!Observer) return;
    let root;
    const observedRoots = globalThis.__scmToolkitSyncLabelRoots ??= new WeakMap();

    const configuredName = (key, fallback) => {
        const value = configuration.getValue(`scmToolkit.${key}`);
        return String(typeof value === 'string' && value.trim() ? value : (fallback ?? '')).trim();
    };
    const configuredFlag = (key, fallback) => {
        const path = `scmToolkit.${key}`;
        const inspected = configuration.inspect?.(path);
        // Preserve the existing Git-backed preference until it is explicitly
        // mirrored into VS Code by the settings page.
        const value = inspected
            ? inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.userValue
            : configuration.getValue(path);
        return typeof value === 'boolean' ? value : fallback === true;
    };

    // Git can combine the caption and count in one span. Keep its native text
    // separately so preference changes and subsequent Git updates remain reversible.
    const nativeSyncCaptions = new WeakMap();
    const captionNodes = new WeakSet();
    const customizeSyncCaption = (action, names, hiddenCounts, combinedName) => {
        const longLabel = action.querySelector('.monaco-button-label');
        const icon = longLabel?.querySelector('.codicon-sync');
        if (!icon) return false;

        const spinning = icon.classList.contains('codicon-modifier-spin');
        const hasOutgoing = Boolean(action.querySelector('.codicon-arrow-up'));
        const hasIncoming = Boolean(action.querySelector('.codicon-arrow-down'));
        // A commit-and-push can briefly show no ahead count during the push.
        const pushWithoutCounts = !hasIncoming && !hasOutgoing
            && configuration.getValue('git.postCommitCommand') === 'push';
        const fallbackDirection = ((hasOutgoing && !hasIncoming) || (spinning && pushWithoutCounts)) ? 'up'
            : hasIncoming && !hasOutgoing ? 'down' : undefined;
        let renamedDirection;

        for (const node of longLabel.childNodes) {
            if (node.nodeType !== 3 && node.nodeType !== 1) continue;
            if (node.nodeType === 1
                && (node.classList.contains('codicon')
                    || node.classList.contains('scm-toolkit-sync-direction')
                    || node.children.length)) continue;

            const text = node.textContent ?? '';
            const saved = nativeSyncCaptions.get(node);
            const original = saved && text === saved.display ? saved.original : text;
            if (!/\p{L}/u.test(original)) continue;
            captionNodes.add(node);
            // In a two-way sync Git puts its caption and incoming count in
            // the same span. Use that span's arrow, not the whole button.
            const nextIcon = node.nextElementSibling;
            const direction = nextIcon?.classList.contains('codicon-arrow-down') ? 'down'
                : nextIcon?.classList.contains('codicon-arrow-up') ? 'up' : fallbackDirection;
            const name = names[direction];

            const whitespace = original.match(/^\s*/)[0];
            const countSuffix = original.match(/\s+\d+\s*$/)?.[0] ?? '';
            let display = combinedName ? whitespace + combinedName : name ? whitespace + name + countSuffix : original;
            if (!combinedName && hiddenCounts[direction]) {
                // Strip only the native count, preserving digits in a custom name.
                display = name ? whitespace + name : display.replace(/\s+\d+\s*$/, '');
            }
            nativeSyncCaptions.set(node, { original, display });
            if (text !== display) node.textContent = display;
            renamedDirection = combinedName ? 'both' : name ? direction : undefined;
            break;
        }
        return renamedDirection;
    };

    const update = () => {
        const nextRoot = widget.element.closest('.scm-view');
        if (!nextRoot) return;
        if (nextRoot !== root) {
            observer.disconnect();
            if (observedRoots.has(nextRoot)) return;
            if (root) observedRoots.delete(root);
            root = nextRoot;
            observedRoots.set(root, observer);
            observer.observe(root, { subtree: true, childList: true, characterData: true });
        }
        const names = {
            down: configuredName('incomingSyncLabel', settings.incomingSyncLabel),
            up: configuredName('outgoingSyncLabel', settings.outgoingSyncLabel),
        };
        const hiddenArrows = {
            down: configuration.getValue('scmToolkit.hideIncomingSyncArrow') === true,
            up: configuration.getValue('scmToolkit.hideOutgoingSyncArrow') === true,
        };
        const hiddenCounts = {
            down: configuredFlag('hideIncomingSyncCount', settings.hideIncomingSyncCount),
            up: configuredFlag('hideOutgoingSyncCount', settings.hideOutgoingSyncCount),
        };
        const combinedName = hiddenCounts.down && hiddenCounts.up && hiddenArrows.down && hiddenArrows.up
            && names.down && names.up ? `${names.down} & ${names.up}` : '';
        for (const action of root.querySelectorAll('.button-container .monaco-button')) {
            if (!action.querySelector('.codicon-sync')) continue;
            const captionDirection = customizeSyncCaption(action, names, hiddenCounts, combinedName);
            const combinedAnchor = action.querySelector('.codicon-arrow-down') ? 'down' : 'up';

            for (const direction of ['down', 'up']) {
                for (const arrow of action.querySelectorAll(
                    `.monaco-button-label > .codicon-arrow-${direction}, `
                    + `.monaco-button-label-short > .codicon-arrow-${direction}`
                )) {
                    // Hide the visible icon, not the node: Git and our label logic
                    // still use it to determine direction. This is reversible live.
                    arrow.hidden = hiddenArrows[direction];
                    const count = arrow.previousElementSibling;
                    if (!count || count.classList.contains('codicon')) continue;

                    // Insert a separate name so native Git can update its count and icons.
                    let label = count.previousElementSibling;
                    if (!label?.classList.contains('scm-toolkit-sync-direction')) label = undefined;
                    // The full-width progress caption already displays the outgoing name.
                    // Keep the count label in the compact version, but avoid duplication.
                    const inLongLabel = arrow.parentElement?.classList.contains('monaco-button-label');
                    const name = combinedName
                        ? (inLongLabel && captionDirection === 'both') || direction !== combinedAnchor ? '' : combinedName
                        : direction === captionDirection && inLongLabel ? '' : names[direction];
                    if (name) {
                        if (!label) {
                            label = doc.createElement('span');
                            label.className = 'scm-toolkit-sync-direction';
                            count.before(label);
                        }
                        const display = name + '\u00a0';
                        if (label.textContent !== display) label.textContent = display;
                    } else {
                        label?.remove();
                    }

                    // Keep native count text intact so live toggles and Git updates
                    // can restore it without waiting for the button to be rebuilt.
                    if (!captionNodes.has(count)) {
                        count.hidden = hiddenCounts[direction] && /^\s*\d*\s*$/.test(count.textContent ?? '');
                    }
                }
            }
        }
    };

    const observer = new Observer(update);
    // SCM constructs the input before inserting it into its view. Wait for that
    // attachment instead of permanently skipping customization at construction.
    observer.observe(doc.documentElement, { subtree: true, childList: true });
    const disposable = configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('scmToolkit.incomingSyncLabel')
            || event.affectsConfiguration('scmToolkit.outgoingSyncLabel')
            || event.affectsConfiguration('scmToolkit.hideIncomingSyncArrow')
            || event.affectsConfiguration('scmToolkit.hideOutgoingSyncArrow')
            || event.affectsConfiguration('scmToolkit.hideIncomingSyncCount')
            || event.affectsConfiguration('scmToolkit.hideOutgoingSyncCount')
            || event.affectsConfiguration('git.postCommitCommand')) update();
    });
    widget.disposables.add({
        dispose() {
            observer.disconnect();
            disposable.dispose();
            if (root) observedRoots.delete(root);
        }
    });
    update();
}

function scmToolkitCustomizeCommitButtonLabel(
    widget,
    configuration,
    commitLabel,
    commitAndSendLabel
) {
    const fallbackCommitValue = String(commitLabel ?? '').trim();
    const fallbackCommitAndSendValue = String(commitAndSendLabel ?? '').trim();
    const doc = widget.element.ownerDocument;
    const Observer = doc.defaultView?.MutationObserver;
    if (!Observer) return;

    const configuredLabel = (key, fallback) => {
        const configured = configuration.getValue(`scmToolkit.${key}`);
        const value = typeof configured === 'string' ? configured.trim() : '';
        return value || fallback;
    };

    let observedRoot;
    const selector = [
        '.button-container > .monaco-button-dropdown > .monaco-button:first-child',
        '.button-container > .monaco-button:first-child',
    ].join(', ');

    const observeRoot = root => {
        if (observedRoot === root) return;
        observer.disconnect();
        observer.observe(root, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['data-index'],
        });
        observedRoot = root;
    };

    const update = () => {
        const root = widget.element.closest('.scm-view');
        if (!root) return;
        observeRoot(root);

        const inputRow = widget.element.closest('.monaco-list-row');
        const index = inputRow?.getAttribute('data-index');
        const rows = inputRow?.parentElement;
        const actionRow = index === null || index === undefined ? undefined
            : rows?.querySelector(`.monaco-list-row[data-index="${Number(index) + 1}"]`);
        const button = actionRow?.querySelector(selector) ?? root.querySelector(selector);
        const commitValue = configuredLabel('commitButtonLabel', fallbackCommitValue);
        const commitAndSendValue = configuredLabel(
            'commitAndSendButtonLabel',
            fallbackCommitAndSendValue
        );
        const current = configuration.getValue('git.postCommitCommand') === 'push'
            ? (commitAndSendValue || commitValue)
            : commitValue;
        if (!button || !current || button.querySelector('.codicon-sync')) return;

        const labelNode = button.querySelector(
            '.monaco-button-label, .monaco-button-label-short'
        );
        const target = labelNode ?? button;
        if (target.textContent !== current) target.textContent = current;
    };

    const observer = new Observer(update);
    observer.observe(doc.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-index'],
    });
    update();

    const configurationDisposable = configuration.onDidChangeConfiguration(event => {
        if (
            event.affectsConfiguration('git.postCommitCommand')
            || event.affectsConfiguration('scmToolkit.commitButtonLabel')
            || event.affectsConfiguration('scmToolkit.commitAndSendButtonLabel')
        ) {
            update();
        }
    });
    widget.disposables.add({
        dispose() {
            observer.disconnect();
            configurationDisposable.dispose();
        }
    });
}

function scmToolkitCustomizeMessagePlaceholder(
    widget,
    input,
    configuration,
    fallbackPlaceholder
) {
    let nativePlaceholder = input.placeholder;
    let activeOverride;

    const configuredPlaceholder = () => {
        const configured = configuration.getValue('scmToolkit.messagePlaceholder');
        return typeof configured === 'string'
            ? configured
            : String(fallbackPlaceholder ?? '');
    };

    const update = () => {
        const value = configuredPlaceholder();
        if (value) {
            if (input.placeholder !== value) {
                if (!activeOverride || input.placeholder !== activeOverride) {
                    nativePlaceholder = input.placeholder;
                }
                input.placeholder = value;
            }
            activeOverride = value;
            return;
        }

        const previousOverride = activeOverride;
        activeOverride = undefined;
        if (previousOverride && input.placeholder === previousOverride) {
            input.placeholder = nativePlaceholder;
        }
    };

    update();
    widget.repositoryDisposables.add(input.onDidChangePlaceholder(() => {
        const value = configuredPlaceholder();
        if (!value) {
            nativePlaceholder = input.placeholder;
            activeOverride = undefined;
            return;
        }
        if (input.placeholder === value) {
            activeOverride = value;
            return;
        }
        if (!activeOverride || input.placeholder !== activeOverride) {
            nativePlaceholder = input.placeholder;
        }
        activeOverride = value;
        input.placeholder = value;
    }));
    widget.repositoryDisposables.add(configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('scmToolkit.messagePlaceholder')) update();
    }));
}

function scmToolkitAttachCommitSettings(widget, button) {
    const doc = widget.element.ownerDocument;
    const Observer = doc.defaultView?.MutationObserver;
    if (!Observer) return;

    let observedRoot;
    const observeRoot = root => {
        if (observedRoot === root) return;
        observer.disconnect();
        observer.observe(root, {
            subtree: true, childList: true, attributes: true, attributeFilter: ['data-index']
        });
        observedRoot = root;
    };

    const update = () => {
        const root = widget.element.closest('.scm-view');
        // Input widgets are constructed before their list row enters the sidebar.
        if (!root) return;
        observeRoot(root);
        const inputRow = widget.element.closest('.monaco-list-row');
        const index = inputRow?.getAttribute('data-index');
        const rows = inputRow?.parentElement;
        const actionRow = index === null || index === undefined ? undefined
            : rows?.querySelector(`.monaco-list-row[data-index="${Number(index) + 1}"]`);
        const dropdown = actionRow?.querySelector('.button-container > .monaco-button-dropdown');
        if (button.parentElement === dropdown) return;
        button.parentElement?.classList.remove('scm-toolkit-commit-settings');
        button.remove();
        if (dropdown) {
            dropdown.classList.add('scm-toolkit-commit-settings');
            dropdown.append(button);
        }
    };

    const observer = new Observer(update);
    observeRoot(widget.element.closest('.scm-view') ?? doc.documentElement);
    update();
    widget.disposables.add({
        dispose() {
            observer.disconnect();
            button.parentElement?.classList.remove('scm-toolkit-commit-settings');
            button.remove();
        }
    });
}

async function scmToolkitPullCleanRepository(provider, commands, repositoryArgument) {
    const hasChanges = () => provider.groups.some(group => group.resources.length > 0);
    if (hasChanges()) return false;

    const historyProvider = provider.historyProvider.get();
    const localRef = historyProvider?.historyItemRef.get();
    const remoteRef = historyProvider?.historyItemRemoteRef.get();
    if (
        !historyProvider
        || !localRef?.id
        || !localRef.revision
        || !remoteRef?.id
        || !remoteRef.revision
        || localRef.revision === remoteRef.revision
    ) {
        return false;
    }

    const ancestor = await historyProvider.resolveHistoryItemRefsCommonAncestor([
        localRef.id,
        remoteRef.id
    ]);
    if (ancestor !== localRef.revision || hasChanges()) return false;

    const currentLocalRef = historyProvider.historyItemRef.get();
    const currentRemoteRef = historyProvider.historyItemRemoteRef.get();
    if (
        currentLocalRef?.revision !== localRef.revision
        || currentRemoteRef?.revision !== remoteRef.revision
        || hasChanges()
    ) {
        return false;
    }

    await commands.executeCommand('sweetiebot.autoPullClean', repositoryArgument);
    return true;
}

function scmToolkitEnableBlankStateRefresh(
    widget,
    input,
    commands,
    repositoryArgument,
    autoPullClean,
    blankStateRefresh
) {
    const doc = widget.element.ownerDocument;
    const win = doc.defaultView;
    const provider = input.repository.provider;
    if (!win || !repositoryArgument || typeof provider.onDidChangeResources !== 'function') return;

    let timer;
    let refreshing = false;
    let autoPullInProgress = false;
    let disposed = false;
    let lastAutoPullState;
    let lastAutoFetch;

    const hasChanges = () => provider.groups.some(group => group.resources.length > 0);

    const clearTimer = () => {
        if (timer === undefined) return;
        win.clearTimeout(timer);
        timer = undefined;
    };

    const maybeAutoPull = async () => {
        if (!autoPullClean || hasChanges()) return;

        const now = Date.now();
        if (lastAutoFetch === undefined || now - lastAutoFetch >= 60000) {
            lastAutoFetch = now;
            await commands.executeCommand('sweetiebot.autoPullClean', repositoryArgument, { fetch: true });
        }

        const historyProvider = provider.historyProvider.get();
        const localRef = historyProvider?.historyItemRef.get();
        const remoteRef = historyProvider?.historyItemRemoteRef.get();
        if (!localRef?.revision || !remoteRef?.revision || localRef.revision === remoteRef.revision) {
            return;
        }

        const state = `${localRef.revision}:${remoteRef.revision}`;
        if (state === lastAutoPullState) return;
        lastAutoPullState = state;

        try {
            await scmToolkitPullCleanRepository(provider, commands, repositoryArgument);
        } catch {
            // Background sync is best-effort and does not open Git's error notifications.
        }
    };

    // A slow network fetch must never delay the next local Git status refresh.
    // Only one background pull check may run at a time.
    const startAutoPull = () => {
        if (!autoPullClean || autoPullInProgress || disposed || hasChanges()) return;
        autoPullInProgress = true;
        void maybeAutoPull().catch(() => {
            // Background sync is best-effort; local change detection must continue.
        }).finally(() => {
            autoPullInProgress = false;
        });
    };

    const schedule = delay => {
        clearTimer();
        if (disposed || hasChanges()) return;

        timer = win.setTimeout(async () => {
            timer = undefined;
            if (disposed || hasChanges()) return;

            if (doc.hidden) {
                schedule(5000);
                return;
            }

            refreshing = true;
            try {
                if (blankStateRefresh) {
                    await commands.executeCommand('git.refresh', repositoryArgument);
                }
                startAutoPull();
            } catch {
                // The built-in Git extension owns refresh errors; keep blank-state polling best-effort.
            } finally {
                refreshing = false;
                if (!disposed && !hasChanges()) schedule(750);
            }
        }, delay);
    };

    const resourceDisposable = provider.onDidChangeResources(() => {
        if (disposed) return;

        if (hasChanges()) {
            clearTimer();
            return;
        }

        if (!refreshing && timer === undefined) schedule(300);
    });

    const onVisibilityChange = () => {
        if (disposed || hasChanges() || doc.hidden) return;
        if (!refreshing && timer === undefined) schedule(300);
    };

    doc.addEventListener('visibilitychange', onVisibilityChange);
    schedule(300);

    return {
        dispose() {
            disposed = true;
            clearTimer();
            resourceDisposable.dispose();
            doc.removeEventListener('visibilitychange', onVisibilityChange);
        }
    };
}

const SCM_TOOLKIT_CODEX_COAUTHOR = 'Co-authored-by: Codex <noreply@openai.com>';

function scmToolkitCoauthorTrailer(settings = {}) {
    const name = settings.codexCoauthorName ?? 'Codex';
    const email = settings.codexCoauthorEmail ?? 'noreply@openai.com';
    if (typeof name !== 'string' || !name.trim() || name.length > 100
        || /[\x00-\x1f\x7f<>\u2028\u2029]/.test(name)
        || typeof email !== 'string' || email.length > 254
        || !/^[^\s<>@]+@[^\s<>@]+$/.test(email)) {
        throw new Error('Invalid co-author name or email in Sweetie Bot settings.');
    }
    if (name === 'Codex' && email === 'noreply@openai.com') return SCM_TOOLKIT_CODEX_COAUTHOR;
    return `Co-authored-by: ${name} <${email}>`;
}

function scmToolkitWithCodexCoauthor(message, settings = {}) {
    const base = message.trimEnd();
    if (!base) return '';
    const trailer = scmToolkitCoauthorTrailer(settings);
    const alreadyAttributed = base.split(/\r?\n/).some(
        line => line.trim() === trailer
    );
    return alreadyAttributed ? base : `${base}\n\n${trailer}`;
}

// Named G4 pony entries from the full MLP pony roster. Explicitly unnamed placeholders,
// G5 entries, and non-pony kirin are intentionally excluded from this branch-name pool.
function scmToolkitBranchNamePool() {
    const disabled = new Set(scmToolkitSettings.branchNameDisabledPacks ?? []);
    const names = [];

    for (const pack of scmToolkitSettings.branchNamePacks ?? []) {
        if (!pack || disabled.has(pack.id) || !Array.isArray(pack.names)) continue;
        names.push(...pack.names);
    }

    names.push(...(scmToolkitSettings.branchCustomNames ?? []));
    return [...new Set(names)];
}


async function scmToolkitPushWithPullRetry(repository, originalPush, expectedBranch) {
    const head = repository.HEAD;
    if (expectedBranch && head?.name !== expectedBranch) {
        throw new Error('The active branch changed before its commit could be pushed.');
    }
    try {
        await originalPush.call(repository, head);
    } catch (error) {
        if (
            error?.gitErrorCode !== 'PushRejected'
            || !head?.name
            || !head.upstream?.remote
            || !head.upstream?.name
            || typeof repository.fetch !== 'function'
            || typeof repository.merge !== 'function'
        ) {
            throw error;
        }

        const checkBranch = () => {
            const current = repository.HEAD;
            if (
                current?.name !== head.name
                || current.upstream?.remote !== head.upstream.remote
                || current.upstream?.name !== head.upstream.name
            ) {
                throw new Error('The active branch changed before its upstream changes could be merged and pushed.');
            }
        };
        checkBranch();
        await repository.fetch({ remote: head.upstream.remote, ref: head.upstream.name });
        checkBranch();
        // Merge explicitly: plain pull can refuse divergent branches or use rebase/ff-only settings.
        await repository.merge(`refs/remotes/${head.upstream.remote}/${head.upstream.name}`);
        checkBranch();
        await originalPush.call(repository, repository.HEAD);
    }
}

function scmToolkitGuardCommit(repository, commands, configuration, notifications, settings = {}) {
    if (!repository || typeof repository.commit !== 'function') return;

    const wrappedRepositories =
        globalThis.__scmToolkitCommitGuardRepositories ??= new WeakMap();
    let state = wrappedRepositories.get(repository);

    if (!state) {
        const originalCommit = repository.commit;
        const originalPush = repository.push;

        const wrappedCommit = async function(message, options) {
            // Blank-message commits generate their title inside Git's wrapper.
            // Show progress before any asynchronous preflight or model queueing.
            const generating = settings.aiCommit === true
                && !String(message ?? '').trim()
                && !options?.amend;
            let progress;
            const asynchronous = configuration.getValue('scmToolkit.durableBackgroundCommits') === true
                && !options?.amend && !options?.empty
                && (String(message ?? '').trim() || settings.aiCommit === true);
            const showProgress = () => {
                try {
                    progress = notifications.notify?.({
                        severity: 1, message: 'Generating commit message'
                    });
                } catch {
                    // Notification API failures must never block Git.
                }
            };
            if (generating && !asynchronous) showProgress();
            const finishProgress = () => {
                try { progress?.close?.(); } catch { /* Ignore disposed notice. */ }
                progress = null;
            };
            // Direct commits inspect here before Git may generate a title. In
            // durable mode, the queue first completes any automatic staging,
            // then inspects that final selection exactly once before enqueue.
            // A pre-staging inspection would miss newly staged/Commit All files.
            const checkCommitLimits = async () => {
                try {
                    return (await commands.executeCommand(
                        'sweetiebot.checkCommitLimits',
                        repository.rootUri
                    )) !== false;
                } catch {
                    // Preserve direct Git commits when the companion extension
                    // is temporarily unavailable; durable queue checks fail closed.
                    return true;
                }
            };
            if (!asynchronous && !(await checkCommitLimits())) {
                finishProgress(false);
                return;
            }

            const requestedPostCommitCommand = options?.postCommitCommand;
            const configuredPostCommitCommand = configuration.getValue('git.postCommitCommand');
            const shouldReleasePush = typeof originalPush === 'function' && (
                (requestedPostCommitCommand === 'push' || requestedPostCommitCommand === 'git.push')
                || (requestedPostCommitCommand === undefined && configuredPostCommitCommand === 'push')
            );
            if (asynchronous) {
                let queued;
                try {
                    queued = await commands.executeCommand('sweetiebot.queueCommit', repository.rootUri, {
                        message: String(message ?? ''), push: shouldReleasePush, all: options?.all,
                        sign: options?.signCommit, signoff: options?.signoff
                    });
                } catch (error) {
                    finishProgress(false);
                    throw error;
                }
                if (queued?.queued || queued?.cancelled) {
                    // Cancellation is terminal: never fall through to native
                    // Git and bypass a rejected size/merged-branch preflight.
                    finishProgress(false);
                    return;
                }
                // The queue intentionally declines special commit modes (such
                // as aggregate >100 MiB auto-splitting). Those switch to the
                // original Git wrapper and need one direct-path preflight.
                if (!(await checkCommitLimits())) {
                    finishProgress(false);
                    return;
                }
            }
            if (generating && asynchronous) showProgress();
            const selectedBranch = repository.HEAD?.name;
            let commitLease = false;
            let gateToken = null;
            let pushTask;
            try {
                try {
                    gateToken = await commands.executeCommand(
                        'sweetiebot.beginCommit', repository.rootUri, { waitForPush: shouldReleasePush }
                    );
                    commitLease = true;
                } catch {
                    // If the companion extension is unavailable, its auto-pull is unavailable too.
                }

                if (!shouldReleasePush) {
                    const result = await originalCommit.call(repository, message, options);
                    finishProgress(true);
                    return result;
                }
                await originalCommit.call(repository, message, {
                    ...(options ?? {}), postCommitCommand: null
                });
                finishProgress(true);
                // Preserve the branch being committed and run push/retry in the background.
                pushTask = scmToolkitPushWithPullRetry(repository, originalPush, selectedBranch)
                    .then(() => true, error => { notifications.error(error); return false; });
            } finally {
                finishProgress(false);
                if (commitLease) {
                    const finish = async pushed => {
                        try {
                            await commands.executeCommand(
                                'sweetiebot.endCommit', repository.rootUri, { gateToken, pushed }
                            );
                        } catch {
                            // Extension reloads must not turn a successful commit into an error.
                        }
                    };
                    if (pushTask) {
                        // Commit UI is released immediately; spellcheck waits for push.
                        void pushTask.then(finish);
                    } else {
                        await finish(false);
                    }
                }
            }
        };

        state = {
            references: 0,
            originalCommit,
            wrappedCommit,
        };
        repository.commit = wrappedCommit;
        wrappedRepositories.set(repository, state);
    }

    state.references += 1;
    let disposed = false;

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            state.references -= 1;
            if (state.references !== 0) return;

            if (repository.commit === state.wrappedCommit) {
                repository.commit = state.originalCommit;
            }
            wrappedRepositories.delete(repository);
        }
    };
}

function scmToolkitChatgptConversationSource(doc) {
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const pattern = new RegExp('^https://chatgpt\\.com/c/(' + uuid + ')(?:[/?#]|$)', 'i');
    for (const input of doc.querySelectorAll('input')) {
        if (typeof input.getClientRects === 'function' && !input.getClientRects().length) continue;
        const match = String(input.value ?? '').trim().match(pattern);
        if (!match) continue;
        return {
            kind: 'chatgpt',
            uuid: match[1],
            url: `https://chatgpt.com/c/${match[1]}`,
        };
    }
    return undefined;
}

function scmToolkitGithubCoordinates(repositoryUrl) {
    const match = String(repositoryUrl ?? '').trim().match(
        /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/i
    );
    return match ? { owner: match[1], repo: match[2] } : undefined;
}

function scmToolkitMcpError(result) {
    return result?.content?.find(
        item => item?.type === 'text' && typeof item.text === 'string'
    )?.text || 'The Kafania MCP tool returned an error.';
}

async function scmToolkitWaitForMcpTool(doc, server, toolName) {
    const win = doc.defaultView;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const tool = server.tools?.get?.().find(
            candidate => candidate.definition?.name === toolName
        );
        if (tool) return tool;
        await new Promise(resolve => (win ? win.setTimeout(resolve, 100) : setTimeout(resolve, 100)));
    }
    return undefined;
}

async function scmToolkitKafaniaTool(doc, mcpService, serverName, toolName) {
    if (!mcpService?.activateCollections || !mcpService?.servers?.get) return undefined;
    await mcpService.activateCollections();
    const wantedServer = String(serverName ?? '').toLowerCase();
    const server = mcpService.servers.get().find(candidate => {
        const metadata = candidate.serverMetadata?.get?.();
        return [
            candidate.definition?.id,
            candidate.definition?.label,
            metadata?.serverName,
        ].some(name => String(name ?? '').toLowerCase() === wantedServer);
    });
    if (!server) return undefined;
    await server.start({ promptType: 'all-untrusted' });
    return scmToolkitWaitForMcpTool(doc, server, toolName);
}

async function scmToolkitWaitForChatgptConversationSource(doc, initialUuid) {
    const win = doc.defaultView;
    for (let attempt = 0; attempt < 80; attempt += 1) {
        const source = scmToolkitChatgptConversationSource(doc);
        if (source && source.uuid !== initialUuid) return source;
        await new Promise(resolve => (win ? win.setTimeout(resolve, 250) : setTimeout(resolve, 250)));
    }
    return undefined;
}

async function scmToolkitCheckPullRequestMcp(doc, mcpService, settings) {
    const serverName = settings.mcpPrServer;
    const statusTool = await scmToolkitKafaniaTool(doc, mcpService, serverName, 'kefania_status');
    if (!statusTool) {
        throw new Error(`Kefania is not ready in VS Code. Start the MCP server "${serverName}" from MCP: List Servers, then try New PR again. For a local checkout, register kefania/src/index.js as a Node stdio server.`);
    }
    const result = await statusTool.call({});
    if (result?.isError) throw new Error(`Kefania cannot access GitHub: ${scmToolkitMcpError(result)}`);
    let status = result?.structuredContent;
    if (!status) {
        try { status = JSON.parse(result?.content?.find(item => item?.type === 'text')?.text || ''); }
        catch { throw new Error('Kefania returned an invalid connection status. Update the server before creating a PR.'); }
    }
    if (status?.ready !== true) throw new Error('Kefania is not ready. Check the server and its GitHub login before creating a PR.');
    for (const name of ['github_get_pull_request_context', settings.mcpPrTool]) {
        if (!(await scmToolkitKafaniaTool(doc, mcpService, serverName, name))) {
            throw new Error(`Kefania is missing the MCP tool "${name}". Update the server before creating a PR.`);
        }
    }
}

async function scmToolkitRecordPullRequestSource(
    doc,
    mcpService,
    settings,
    launch,
    branch,
    base,
    initialSource
) {
    const github = scmToolkitGithubCoordinates(launch?.repositoryUrl);
    if (!github) return false;

    let source = launch?.source || initialSource;
    if (!source) {
        source = await scmToolkitWaitForChatgptConversationSource(doc);
    }
    if (!source) return false;

    const tool = await scmToolkitKafaniaTool(
        doc,
        mcpService,
        settings.mcpPrServer,
        'github_comment_pull_request_source'
    );
    if (!tool) return false;

    const win = doc.defaultView;
    for (let attempt = 0; attempt < 90; attempt += 1) {
        const result = await tool.call({
            owner: github.owner,
            repo: github.repo,
            head: branch,
            base,
            source,
        });
        if (!result?.isError) return true;
        const error = scmToolkitMcpError(result);
        if (!/No open pull request found/i.test(error)) {
            throw new Error(error);
        }
        await new Promise(resolve => (win ? win.setTimeout(resolve, 2000) : setTimeout(resolve, 2000)));
    }
    return false;
}

// Time out workbench notifications, keeping the actionable update prompt open.
const scmToolkitTimedNotificationServices = new WeakSet();
function scmToolkitExpireNotifications(notifications) {
    if (!notifications || scmToolkitTimedNotificationServices.has(notifications)) return;

    // Extension-host notices (including "PR #... merged into main.") may be
    // added directly to the workbench model; info/warn/error also return void.
    // Observe the model so every notice, including ones already open, expires.
    const keepOpen = message => message === 'Sweetiebot update ready'
        || message === 'Generating commit message';
    const duration = message => message === 'Generating commit message asynchronously' ? 1_000 : 20_000;
    const model = notifications.model;
    if (model && Array.isArray(model.notifications) && typeof model.onDidChangeNotification === 'function') {
        const timers = new WeakMap();
        const messageOf = item =>
            String(item?.message?.raw ?? item?.message?.value ?? item?.message ?? '').trim();
        const cancel = item => {
            if (!timers.has(item)) return;
            clearTimeout(timers.get(item));
            timers.delete(item);
        };
        const schedule = item => {
            if (!item || typeof item.close !== 'function') return;
            if (keepOpen(messageOf(item))) {
                cancel(item);
                return;
            }
            if (timers.has(item)) return;
            const timeout = setTimeout(() => {
                timers.delete(item);
                if (model.notifications.includes(item) && !keepOpen(messageOf(item))) {
                    item.close();
                }
            }, duration(messageOf(item)));
            timers.set(item, timeout);
            if (typeof item.onDidClose === 'function') item.onDidClose(() => cancel(item));
        };
        // 0 = ADD and 1 = CHANGE in the workbench notification model.
        model.onDidChangeNotification(event => {
            if (event?.kind === 0 || event?.kind === 1) schedule(event.item);
        });
        for (const item of model.notifications) schedule(item);
        scmToolkitTimedNotificationServices.add(notifications);
        return;
    }

    // Fallback for older workbench services that do not expose a model.
    const scheduled = new WeakSet();
    const track = (handle, message) => {
        const text = typeof message === 'string' ? message : message?.value ?? message?.message ?? '';
        if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')
            || typeof handle.close !== 'function'
            || keepOpen(String(text).trim())
            || scheduled.has(handle)) return handle;
        scheduled.add(handle);
        const timeout = setTimeout(() => handle.close(), duration(String(text).trim()));
        if (typeof handle.onDidClose === 'function') {
            handle.onDidClose(() => clearTimeout(timeout));
        }
        return handle;
    };
    const wrap = (method, messageAt) => {
        const original = notifications[method];
        if (typeof original !== 'function') return;
        notifications[method] = function (...args) {
            return track(original.apply(this, args), messageAt(args));
        };
    };
    // Methods often delegate to notify; a WeakSet prevents duplicate timers.
    wrap('notify', args => args[0]?.message);
    wrap('prompt', args => args[1]);
    for (const method of ['info', 'warn', 'error']) {
        wrap(method, args => args[0]);
    }
    scmToolkitTimedNotificationServices.add(notifications);
}

// One popup consumer per workbench document, shared by all repository widgets.
const scmToolkitSpellcheckDocuments = new WeakSet();
const scmToolkitPostSpellcheckStates = new WeakMap();
function scmToolkitWatchSpellcheckPopups(doc, commands) {
    if (scmToolkitSpellcheckDocuments.has(doc)) return;
    scmToolkitSpellcheckDocuments.add(doc);
    let busy = false, popup;
    const poll = async () => {
        if (busy || popup) return;
        busy = true;
        try {
            let preview = await commands.executeCommand('sweetiebot.takeSpellcheckPopup');
            if (!preview || typeof preview.html !== 'string') return;
            const previousFocus = doc.activeElement;
            const dialog = doc.createElement('dialog');
            dialog.className = 'scm-toolkit-spellcheck-popup';
            dialog.setAttribute('aria-label', 'Spellcheck Changes');
            const themeHost = doc.querySelector?.('.monaco-workbench') || doc.documentElement;
            const theme = doc.defaultView.getComputedStyle?.(themeHost);
            dialog.style?.setProperty('color', theme?.getPropertyValue('--vscode-editor-foreground').trim() || '#d4d4d4');
            dialog.style?.setProperty('background-color', theme?.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e');
            const close = doc.createElement('button');
            close.className = 'scm-toolkit-spellcheck-close';
            close.textContent = 'Close';
            const content = doc.createElement('div');
            content.className = 'scm-toolkit-spellcheck-content';
            const heading = doc.createElement('h1');
            heading.textContent = 'Spellcheck Changes';
            const status = doc.createElement('div');
            status.className = 'scm-toolkit-spellcheck-status';
            status.setAttribute('role', 'status');
            const messageLabel = doc.createElement('label');
            messageLabel.className = 'scm-toolkit-spellcheck-message-label';
            messageLabel.textContent = 'Optional commit description (normal title generated on Accept)';
            const message = doc.createElement('textarea');
            message.className = 'scm-toolkit-spellcheck-message';
            message.setAttribute('aria-label', 'Optional commit description');
            message.rows = 4;
            message.value = preview.message || '';
            messageLabel.append(message);
            const actions = doc.createElement('footer');
            actions.className = 'scm-toolkit-spellcheck-actions';
            const revert = doc.createElement('button');
            revert.className = 'scm-toolkit-spellcheck-revert';
            revert.textContent = 'Revert';
            const accept = doc.createElement('button');
            accept.className = 'scm-toolkit-spellcheck-accept';
            accept.textContent = 'Accept';
            actions.append(revert, accept);
            let activeEdit, currentSave, acting = false, dismissed = false;
            const collapsedFiles = new Set();
            const updateActions = () => {
                accept.disabled = acting || !!currentSave || !(preview.files || []).length;
                revert.disabled = acting;
                close.disabled = acting;
                message.disabled = acting;
            };
            message.addEventListener('input', updateActions);
            updateActions();
            const renderFiles = () => {
            if (dialog.open && !(preview.files || []).length) {
                dialog.close();
                return;
            }
            const scrollTop = content.scrollTop;
            content.replaceChildren(heading);
            if (!(preview.files || []).length) {
                const empty = doc.createElement('p');
                empty.textContent = 'No remaining spellcheck corrections to review.';
                content.append(empty);
            }
            for (const file of preview.files || []) {
                const section = doc.createElement('section');
                section.className = 'file';
                const name = doc.createElement('h2');
                const toggle = doc.createElement('button');
                toggle.className = 'scm-toolkit-spellcheck-file-toggle';
                const corrections = file.rows.reduce((sum, row) => sum + (row.changes?.length || 0), 0);
                const count = corrections || file.rows.filter(row => row.kind === 'add' || row.kind === 'remove').length;
                const summary = count + (count === 1 ? ' change' : ' changes');
                const rowsContainer = doc.createElement('div');
                rowsContainer.className = 'rows';
                const updateToggle = () => {
                    const collapsed = collapsedFiles.has(file.name);
                    toggle.textContent = (collapsed ? '▸ ' : '▾ ') + file.name + ' (' + summary + ')';
                    toggle.setAttribute('aria-expanded', String(!collapsed));
                    toggle.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + file.name);
                    rowsContainer.hidden = collapsed;
                };
                toggle.addEventListener('click', () => {
                    if (activeEdit || currentSave || acting) return;
                    if (collapsedFiles.has(file.name)) collapsedFiles.delete(file.name);
                    else collapsedFiles.add(file.name);
                    updateToggle();
                });
                updateToggle();
                name.append(toggle);
                section.append(name, rowsContainer);
                for (const row of file.rows) {
                    const line = doc.createElement('div');
                    line.className = ['hunk', 'meta'].includes(row.kind) ? row.kind : 'diff-line ' + row.kind;
                    if (['hunk', 'meta'].includes(row.kind)) line.textContent = row.text;
                    else {
                        for (const [className, value] of [['line-number', row.oldNumber], ['line-number', row.newNumber], ['sign', row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' ']]) {
                            const cell = doc.createElement('span');
                            cell.className = className;
                            cell.textContent = value == null ? '' : String(value);
                            line.append(cell);
                        }
                        const lineActions = doc.createElement('span');
                        lineActions.className = 'scm-toolkit-spellcheck-line-actions';
                        if (row.editId && typeof row.originalText === 'string' && row.originalText !== row.text) {
                            const revertLine = doc.createElement('button');
                            revertLine.className = 'scm-toolkit-spellcheck-revert-line';
                            revertLine.type = 'button';
                            revertLine.textContent = '↶';
                            revertLine.title = 'Revert entire line in ' + file.name + ', line ' + row.newNumber;
                            revertLine.setAttribute('aria-label', 'Revert all corrections in '
                                + file.name + ', line ' + row.newNumber);
                            revertLine.addEventListener('click', event => {
                                event.stopPropagation();
                                if (activeEdit || currentSave || acting) return;
                                status.textContent = 'Reverting line…';
                                // Keep the same stale-diff and dirty-editor protections as manual edits.
                                currentSave = commands.executeCommand('sweetiebot.saveSpellcheckEdit',
                                    preview.sessionId, row.editId, row.originalText).then(updated => {
                                    preview = updated;
                                    status.textContent = 'Line reverted';
                                    renderFiles();
                                    return true;
                                }, error => {
                                    status.textContent = error.message || 'Could not revert this line.';
                                    return false;
                                }).finally(() => { currentSave = undefined; updateActions(); });
                                updateActions();
                            });
                            lineActions.append(revertLine);
                        }
                        line.append(lineActions);
                        const text = doc.createElement('span');
                        text.className = 'line-text';
                        if (row.changes?.some(change => change.changeId)) {
                            const appendText = (value, changed = false) => {
                                if (!value) return;
                                const token = doc.createElement('span');
                                if (changed) token.className = 'changed-token';
                                token.textContent = value;
                                text.append(token);
                            };
                            let offset = 0;
                            for (const change of row.changes) {
                                appendText(row.text.slice(offset, change.start));
                                const correction = doc.createElement('span');
                                correction.className = 'scm-toolkit-spellcheck-correction';
                                const changed = doc.createElement('span');
                                changed.className = 'changed-token';
                                changed.textContent = row.text.slice(change.start, change.end);
                                correction.append(changed);
                                const undo = doc.createElement('button');
                                undo.className = 'scm-toolkit-spellcheck-undo';
                                undo.type = 'button';
                                undo.textContent = '↶';
                                undo.title = 'Restore ' + JSON.stringify(change.before) + ' instead of ' + JSON.stringify(change.after);
                                undo.setAttribute('aria-label', 'Revert correction in ' + file.name
                                    + ', line ' + row.newNumber + ': ' + change.after + ' to ' + change.before);
                                undo.addEventListener('click', event => {
                                    event.stopPropagation();
                                    if (activeEdit || currentSave || acting) return;
                                    status.textContent = 'Undoing…';
                                    currentSave = commands.executeCommand('sweetiebot.undoSpellcheckChange',
                                        preview.sessionId, change.changeId).then(updated => {
                                        preview = updated;
                                        status.textContent = 'Correction undone';
                                        renderFiles();
                                        return true;
                                    }, error => {
                                        status.textContent = error.message || 'Could not undo this correction.';
                                        return false;
                                    }).finally(() => { currentSave = undefined; updateActions(); });
                                    updateActions();
                                });
                                correction.append(undo);
                                text.append(correction);
                                offset = change.end;
                            }
                            appendText(row.text.slice(offset));
                        } else {
                            for (const segment of row.segments) {
                                const token = doc.createElement('span');
                                if (segment.changed) token.className = 'changed-token';
                                token.textContent = segment.text;
                                text.append(token);
                            }
                        }
                        if (row.editId) {
                            text.tabIndex = 0;
                            text.classList.add('editable');
                            text.title = 'Click to edit this unstaged line';
                            text.setAttribute('aria-label', 'Edit ' + file.name + ', line ' + row.newNumber);
                            const begin = () => {
                                if (activeEdit || currentSave || acting) return;
                                const editor = doc.createElement('textarea');
                                editor.className = 'scm-toolkit-spellcheck-line-editor';
                                editor.value = row.text;
                                editor.setAttribute('aria-label', 'Edit ' + file.name + ', line ' + row.newNumber);
                                editor.rows = 1;
                                editor.spellcheck = false;
                                text.replaceChildren(editor);
                                const resize = () => {
                                    editor.style.height = 'auto';
                                    editor.style.height = editor.scrollHeight + 'px';
                                };
                                const finish = () => {
                                    if (currentSave) return currentSave;
                                    if (activeEdit?.editor !== editor) return Promise.resolve(true);
                                    if (editor.value === row.text) {
                                        activeEdit = undefined;
                                        renderFiles();
                                        return Promise.resolve(true);
                                    }
                                    const value = editor.value;
                                    editor.disabled = true;
                                    close.disabled = true;
                                    status.textContent = 'Saving…';
                                    currentSave = commands.executeCommand('sweetiebot.saveSpellcheckEdit', preview.sessionId, row.editId, value)
                                        .then(updated => {
                                            preview = updated;
                                            activeEdit = undefined;
                                            status.textContent = 'Saved';
                                            renderFiles();
                                            return true;
                                        }, error => {
                                            editor.disabled = false;
                                            status.textContent = error.message || 'Could not save this edit.';
                                            return false;
                                        }).finally(() => { currentSave = undefined; updateActions(); });
                                    return currentSave;
                                };
                                activeEdit = {editor, finish};
                                editor.addEventListener('input', resize);
                                editor.addEventListener('blur', () => { void finish(); });
                                editor.addEventListener('keydown', event => {
                                    if (event.key === 'Escape') {
                                        event.preventDefault(); event.stopPropagation();
                                        if (currentSave) return;
                                        activeEdit = undefined;
                                        renderFiles();
                                        close.focus();
                                    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                        event.preventDefault();
                                        void finish();
                                    }
                                });
                                editor.focus();
                                resize();
                            };
                            text.addEventListener('click', begin);
                            text.addEventListener('keydown', event => {
                                if (event.key === 'Enter') { event.preventDefault(); begin(); }
                            });
                        }
                        line.append(text);
                    }
                    rowsContainer.append(line);
                }
                content.append(section);
            }
            content.scrollTop = scrollTop;
            };
            renderFiles();
            const complete = async action => {
                if (acting) return;
                acting = true;
                updateActions();
                try {
                    if (currentSave && !await currentSave) return;
                    if (action === 'accept' && activeEdit && !await activeEdit.finish()) return;
                    // Revert discards a draft still being typed in the popup.
                    if (action === 'revert') activeEdit = undefined;
                    status.textContent = action === 'accept' ? 'Committing…' : 'Reverting…';
                    await commands.executeCommand('sweetiebot.finishSpellcheckPreview', preview.sessionId, action, message.value);
                    dialog.close();
                } catch (error) {
                    status.textContent = error.message || 'Could not complete the spelling review.';
                } finally { acting = false; updateActions(); }
            };
            revert.addEventListener('mousedown', event => { event.preventDefault(); });
            revert.addEventListener('click', () => { void complete('revert'); });
            accept.addEventListener('click', () => { void complete('accept'); });
            const dismiss = async () => {
                if (acting) return;
                if (currentSave && !await currentSave) return;
                if (activeEdit && !await activeEdit.finish()) return;
                dismissed = true;
                dialog.close();
            };
            dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); });
            close.addEventListener('click', dismiss);
            dialog.addEventListener('click', event => {
                if (event.target !== dialog) return;
                const rect = dialog.getBoundingClientRect();
                if (event.clientX < rect.left || event.clientX > rect.right
                    || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
            });
            dialog.addEventListener('close', () => {
                popup = undefined;
                dialog.remove();
                void commands.executeCommand('sweetiebot.closeSpellcheckPopup', preview.sessionId,
                    dismissed ? message.value : undefined).catch(() => {});
                if (previousFocus?.isConnected) previousFocus.focus();
            }, { once: true });
            dialog.append(close, status, content, messageLabel, actions);
            (doc.querySelector?.('.monaco-workbench') || doc.body).append(dialog);
            popup = dialog;
            dialog.showModal();
            close.focus();
        } catch { /* Extension activation or reload may temporarily remove the command. */ }
        finally { busy = false; }
    };
    doc.defaultView.setInterval(poll, 1000);
    void poll();
}

// Run opt-in subject-only spelling corrections as the user drafts, not during Commit.
// Debounce local Ollama calls, serialize checks, and discard stale responses.
function scmToolkitWatchDraftSpellcheck(
    input, repositoryUri, commands, blocked = () => false,
    { spellcheck = true, professionalEmoji = false, review = false, delaySeconds = 1.5 } = {}
) {
    let timer;
    let busy = false;
    let disposed = false;
    let checkedSubject;
    const subjectOf = value => String(value || '').split(/\r?\n/, 1)[0];

    const schedule = () => {
        clearTimeout(timer);
        if (disposed || blocked()) return;
        const subject = subjectOf(input.value);
        if (!subject.trim() || subject === checkedSubject) return;
        timer = setTimeout(async () => {
            timer = undefined;
            if (disposed || busy || blocked()) return;
            const original = input.value ?? '';
            const subject = subjectOf(original);
            if (!subject.trim() || subject === checkedSubject) return;
            busy = true;
            checkedSubject = subject;
            try {
                const corrected = await commands.executeCommand(
                    'sweetiebot.previewCommitSpellcheck', repositoryUri, original,
                    { automatic: true, spellcheck, professionalEmoji, review }
                );
                if (!disposed && !blocked() && input.value === original
                    && typeof corrected === 'string' && corrected !== original) {
                    checkedSubject = subjectOf(corrected);
                    input.setValue(corrected, false);
                }
            } catch (error) {
                // An unavailable Ollama model must not interrupt drafting or commit.
                console.warn('Sweetiebot draft spellcheck:', error?.message || error);
            } finally {
                busy = false;
                if (!disposed && subjectOf(input.value) !== checkedSubject) schedule();
            }
        }, Math.max(500, Math.min(10000, (Number(delaySeconds) || 1.5) * 1000)));
    };

    const listener = input.onDidChange(schedule);
    schedule();
    return {
        dispose() {
            disposed = true;
            clearTimeout(timer);
            listener.dispose();
        }
    };
}

function scmToolkitCreateControls(widget, observe, commands, notifications, configuration, mcpService, settings) {
    scmToolkitWatchSpellcheckPopups(widget.element.ownerDocument, commands);
    scmToolkitExpireNotifications(notifications);
    const doc = widget.element.ownerDocument;
    scmToolkitCustomizeSyncLabels(widget, configuration, settings);
    if (settings.commitButtonLabel || settings.commitAndSendButtonLabel) {
        scmToolkitCustomizeCommitButtonLabel(
            widget,
            configuration,
            settings.commitButtonLabel,
            settings.commitAndSendButtonLabel
        );
    }
    const homeButton = doc.createElement('button');
    homeButton.type = 'button';
    homeButton.className = 'scm-toolkit-home codicon codicon-home';
    homeButton.hidden = true;
    homeButton.title = 'Home: switch to the default branch';
    homeButton.setAttribute('aria-label', 'Home: switch to the default branch');

    const branchButton = doc.createElement('button');
    branchButton.type = 'button';
    branchButton.className = 'scm-toolkit-branch';
    branchButton.hidden = true;

    const branchLabel = doc.createElement('span');
    branchLabel.className = 'scm-toolkit-branch-label';

    const arrow = doc.createElement('span');
    arrow.textContent = '▾';
    arrow.setAttribute('aria-hidden', 'true');

    branchButton.append(branchLabel, arrow);

    const pushControl = doc.createElement('label');
    pushControl.className = 'scm-toolkit-push';
    pushControl.hidden = true;
    pushControl.title = 'Checked: push after committing. Unchecked: do nothing after committing.';

    const pushCheckbox = doc.createElement('input');
    pushCheckbox.type = 'checkbox';
    pushCheckbox.className = 'scm-toolkit-push-checkbox';
    pushCheckbox.setAttribute('aria-label', 'Commit and push');

    const pushMark = doc.createElement('span');
    pushMark.className = 'scm-toolkit-push-mark';
    pushMark.setAttribute('aria-hidden', 'true');

    pushControl.append(pushCheckbox, pushMark);

    const syncButton = doc.createElement('button');
    syncButton.type = 'button';
    syncButton.className = 'scm-toolkit-sync-branch codicon codicon-sync';
    syncButton.hidden = true;

    const deleteButton = doc.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'scm-toolkit-delete-branch codicon codicon-trash';
    deleteButton.hidden = true;

    const deleteTooltip = doc.createElement('span');
    deleteTooltip.className = 'scm-toolkit-tooltip';
    deleteTooltip.setAttribute('aria-hidden', 'true');
    deleteButton.append(deleteTooltip);

    const firstDivider = doc.createElement('span');
    firstDivider.className = 'scm-toolkit-divider';
    firstDivider.hidden = true;
    firstDivider.setAttribute('aria-hidden', 'true');

    const autocompleteButton = doc.createElement('button');
    autocompleteButton.type = 'button';
    autocompleteButton.className = 'scm-toolkit-autocomplete codicon codicon-sparkle';
    autocompleteButton.hidden = true;

    const autocompleteTooltip = doc.createElement('span');
    autocompleteTooltip.className = 'scm-toolkit-tooltip';
    autocompleteTooltip.setAttribute('aria-hidden', 'true');
    autocompleteButton.append(autocompleteTooltip);

    const spellcheckButton = doc.createElement('button');
    spellcheckButton.type = 'button';
    spellcheckButton.className = 'scm-toolkit-spellcheck codicon codicon-check';
    spellcheckButton.hidden = true;
    spellcheckButton.title = 'Preview spelling correction';
    spellcheckButton.setAttribute('aria-label', 'Preview spelling correction');

    const postSpellcheckButton = doc.createElement('button');
    postSpellcheckButton.type = 'button';
    postSpellcheckButton.className = 'scm-toolkit-post-spellcheck codicon codicon-whole-word';
    postSpellcheckButton.hidden = true;

    const codexButton = doc.createElement('button');
    codexButton.type = 'button';
    codexButton.className = 'scm-toolkit-codex-coauthor codicon codicon-account';
    codexButton.hidden = true;
    codexButton.title = `Commit with ${settings.codexCoauthorName || 'Codex'} co-author`;
    codexButton.setAttribute('aria-label', codexButton.title);

    const autoPublishButton = doc.createElement('button');
    autoPublishButton.type = 'button';
    autoPublishButton.className = 'scm-toolkit-auto-publish codicon codicon-cloud-upload';
    autoPublishButton.hidden = true;

    const autoPublishTooltip = doc.createElement('span');
    autoPublishTooltip.className = 'scm-toolkit-tooltip';
    autoPublishTooltip.setAttribute('aria-hidden', 'true');
    autoPublishButton.append(autoPublishTooltip);

    const secondDivider = doc.createElement('span');
    secondDivider.className = 'scm-toolkit-divider';
    secondDivider.hidden = true;
    secondDivider.setAttribute('aria-hidden', 'true');

    const pullRequestButton = doc.createElement('button');
    pullRequestButton.type = 'button';
    pullRequestButton.className = 'scm-toolkit-pull-request codicon codicon-git-pull-request';
    pullRequestButton.hidden = true;

    const pullRequestTooltip = doc.createElement('span');
    pullRequestTooltip.className = 'scm-toolkit-tooltip';
    pullRequestTooltip.setAttribute('aria-hidden', 'true');
    pullRequestButton.append(pullRequestTooltip);

    const ponyBranchButton = doc.createElement('button');
    ponyBranchButton.type = 'button';
    ponyBranchButton.className = 'scm-toolkit-pony-branch codicon codicon-git-branch-create';
    ponyBranchButton.hidden = true;

    const ponyBranchTooltip = doc.createElement('span');
    ponyBranchTooltip.className = 'scm-toolkit-tooltip';
    ponyBranchTooltip.setAttribute('aria-hidden', 'true');
    ponyBranchButton.append(ponyBranchTooltip);

    const stackedBranchButton = doc.createElement('button');
    stackedBranchButton.type = 'button';
    stackedBranchButton.className = 'scm-toolkit-stacked-branch codicon codicon-layers';
    stackedBranchButton.hidden = true;
    const stackedBranchTooltip = doc.createElement('span');
    stackedBranchTooltip.className = 'scm-toolkit-tooltip';
    stackedBranchTooltip.setAttribute('aria-hidden', 'true');
    stackedBranchButton.append(stackedBranchTooltip);

    const settingsButton = doc.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'scm-toolkit-settings';
    const settingsIcon = doc.createElement('span');
    settingsIcon.className = 'scm-toolkit-settings-icon';
    settingsIcon.setAttribute('aria-hidden', 'true');
    settingsIcon.textContent = '🪄';
    settingsButton.append(settingsIcon);
    settingsButton.hidden = true;
    settingsButton.title = 'Open Sweetiebot SCM settings';
    settingsButton.setAttribute('aria-label', 'Open Sweetiebot SCM settings');

    widget.element.prepend(branchButton);
    scmToolkitAttachCommitSettings(widget, settingsButton);
    widget.element.append(
        pushControl,
        syncButton,
        deleteButton,
        firstDivider,
        autocompleteButton,
        spellcheckButton,
        postSpellcheckButton,
        codexButton,
        autoPublishButton,
        secondDivider,
        homeButton,
        pullRequestButton,
        ponyBranchButton,
        stackedBranchButton
    );

    const branchStrip = scmToolkitCreateBranchStrip(widget, commands, notifications,
        settings, event => openBranchPicker(event), branchButton);

    let currentCommand;
    let currentBranch;
    let currentRepositoryArgument;
    let currentRepositoryUri;
    let currentDefaultBranch;
    let currentBranchRevision;
    let pullRequestEligibilityKey;
    let pullRequestEligibility;
    let pullRequestEligibilityRetry;
    let pullRequestEligibilityRequest = 0;
    let repositoryResolveToken = 0;
    let defaultBranchRetry;
    let currentInput;
    let pending = false;
    let deletingBranch = false;
    let creatingPullRequest = false;
    let creatingPonyBranch = false;
    let updatingPush = false;
    let updatingAutocomplete = false;
    let spellchecking = false;
    let updatingPostSpellcheck = false;
    const postSpellcheckState = scmToolkitPostSpellcheckStates.get(doc)
        || { enabled: Boolean(settings.postCommitSpellcheck) };
    scmToolkitPostSpellcheckStates.set(doc, postSpellcheckState);
    let updatingAutoPublish = false;
    let publishingBranch;
    let committingWithCodex = false;

    const refreshPush = () => {
        if (configuration.getValue('git.postCommitCommand') === 'sync') {
            void configuration.updateValue('git.postCommitCommand', 'none')
                .catch(error => notifications.error(error));
        }
        pushCheckbox.checked = configuration.getValue('git.postCommitCommand') === 'push';
    };

    const changePush = async event => {
        event.stopPropagation();
        if (updatingPush) return;

        updatingPush = true;
        pushCheckbox.disabled = true;
        const enabled = pushCheckbox.checked;
        try {
            await configuration.updateValue(
                'git.postCommitCommand',
                enabled ? 'push' : 'none'
            );
        } catch (error) {
            notifications.error(error);
        } finally {
            updatingPush = false;
            pushCheckbox.disabled = deletingBranch;
            refreshPush();
        }
    };

    pushCheckbox.addEventListener('change', changePush);
    widget.disposables.add(configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('git.postCommitCommand')) refreshPush();
    }));

    const refreshAutocomplete = () => {
        const enabled = configuration.getValue('editor.inlineSuggest.enabled') !== false;
        autocompleteButton.classList.toggle('scm-toolkit-autocomplete-off', !enabled);
        autocompleteButton.setAttribute('aria-pressed', String(!enabled));
        const description = enabled
            ? 'Turn off inline code completion'
            : 'Turn on inline code completion';
        autocompleteButton.setAttribute('aria-label', description);
        autocompleteTooltip.textContent = description;
    };

    const toggleAutocomplete = async event => {
        event.stopPropagation();
        if (updatingAutocomplete) return;

        updatingAutocomplete = true;
        autocompleteButton.disabled = true;
        const enabled = configuration.getValue('editor.inlineSuggest.enabled') !== false;
        try {
            await configuration.updateValue('editor.inlineSuggest.enabled', !enabled);
        } catch (error) {
            notifications.error(error);
        } finally {
            updatingAutocomplete = false;
            autocompleteButton.disabled = false;
            refreshAutocomplete();
        }
    };

    autocompleteButton.addEventListener('click', toggleAutocomplete);
    widget.disposables.add(configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('editor.inlineSuggest.enabled')) {
            refreshAutocomplete();
        }
    }));

    const refreshSpellcheck = () => {
        spellcheckButton.disabled =
            spellchecking || pending || deletingBranch || !currentInput || !currentRepositoryUri;
    };

    const refreshPostSpellcheck = () => {
        const enabled = postSpellcheckState.enabled;
        const description = enabled
            ? 'Turn off automatic post-commit spellcheck'
            : 'Turn on automatic post-commit spellcheck';
        const updateButton = button => {
            button.classList.toggle('scm-toolkit-post-spellcheck-active', enabled);
            button.setAttribute('aria-pressed', String(enabled));
            button.setAttribute('aria-label', description);
            button.title = description;
        };
        updateButton(postSpellcheckButton);
        for (const button of doc.querySelectorAll?.('.scm-toolkit-post-spellcheck') || []) {
            if (button !== postSpellcheckButton) updateButton(button);
        }
        postSpellcheckButton.disabled = updatingPostSpellcheck;
    };

    const togglePostSpellcheck = async event => {
        event.stopPropagation();
        if (updatingPostSpellcheck) return;
        updatingPostSpellcheck = true;
        refreshPostSpellcheck();
        try {
            postSpellcheckState.enabled = await commands.executeCommand(
                'sweetiebot.postCommitSpellcheck', 'toggle'
            );
        } catch (error) {
            notifications.error(error);
        } finally {
            updatingPostSpellcheck = false;
            refreshPostSpellcheck();
        }
    };

    const previewSpellcheck = async event => {
        event.stopPropagation();
        if (spellchecking || pending || deletingBranch || !currentInput || !currentRepositoryUri) return;

        const input = currentInput;
        const originalMessage = input.value ?? '';
        if (!originalMessage.trim()) {
            notifications.error('Enter a commit message before previewing spelling corrections.');
            return;
        }

        spellchecking = true;
        refreshSpellcheck();
        try {
            const corrected = await commands.executeCommand(
                'sweetiebot.previewCommitSpellcheck',
                currentRepositoryUri,
                originalMessage
            );
            if (currentInput !== input || input.value !== originalMessage) {
                throw new Error('The selected repository or commit message changed during spellcheck. Try again.');
            }
            if (typeof corrected === 'string' && corrected !== originalMessage) {
                input.setValue(corrected, false);
            }
        } catch (error) {
            notifications.error(error);
        } finally {
            spellchecking = false;
            refreshSpellcheck();
        }
    };

    const refreshAutoPublish = () => {
        const enabled = configuration.getValue('scmToolkit.autoPublishNewBranches') === true;
        autoPublishButton.classList.toggle('scm-toolkit-auto-publish-active', enabled);
        autoPublishButton.setAttribute('aria-pressed', String(enabled));
        autoPublishButton.disabled =
            updatingAutoPublish || Boolean(publishingBranch) || !currentRepositoryUri;
        const description = enabled
            ? `Automatically publish new branches to ${settings.remote}`
            : `Keep new branches local instead of publishing to ${settings.remote}`;
        autoPublishButton.setAttribute('aria-label', description);
        autoPublishTooltip.textContent = description;
    };

    const toggleAutoPublish = async event => {
        event.stopPropagation();
        if (updatingAutoPublish) return;

        updatingAutoPublish = true;
        refreshAutoPublish();
        const enabled = configuration.getValue('scmToolkit.autoPublishNewBranches') === true;
        try {
            await configuration.updateValue('scmToolkit.autoPublishNewBranches', !enabled);
        } catch (error) {
            notifications.error(error);
        } finally {
            updatingAutoPublish = false;
            refreshAutoPublish();
        }
    };

    const maybePublishBranch = async branch => {
        if (
            configuration.getValue('scmToolkit.autoPublishNewBranches') !== true
            || !currentRepositoryUri
            || !currentDefaultBranch
            || !branch
            || branch === currentDefaultBranch
            || publishingBranch === branch
        ) {
            return false;
        }

        publishingBranch = branch;
        refreshAutoPublish();
        try {
            const published = await commands.executeCommand(
                'sweetiebot.publishBranch',
                currentRepositoryUri,
                { branch, remote: settings.remote }
            );
            return Boolean(published);
        } catch (error) {
            notifications.error(error);
            return false;
        } finally {
            if (publishingBranch === branch) publishingBranch = undefined;
            refreshAutoPublish();
        }
    };

    autoPublishButton.addEventListener('click', toggleAutoPublish);
    widget.disposables.add(configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('scmToolkit.autoPublishNewBranches')) {
            refreshAutoPublish();
        }
    }));

    const refreshCodexCommit = () => {
        const currentCommitCommand = currentInput?.repository.provider.acceptInputCommand;
        codexButton.disabled =
            pending
            || deletingBranch
            || committingWithCodex
            || !currentInput
            || !currentCommitCommand?.id;
    };

    const commitWithCodex = async event => {
        event.stopPropagation();
        const currentCommitCommand = currentInput?.repository.provider.acceptInputCommand;
        if (
            !settings.codexCoauthor
            || !currentInput
            || !currentCommitCommand?.id
            || pending
            || deletingBranch
            || committingWithCodex
        ) {
            return;
        }

        const input = currentInput;
        const repositoryUri = currentRepositoryUri;
        const originalMessage = input.value ?? '';
        if (!originalMessage.trim() && !settings.codexCommitContext) {
            notifications.error('Enter a commit message before committing with Codex attribution.');
            return;
        }

        committingWithCodex = true;
        refreshCodexCommit();

        try {
            const result = await commands.executeCommand('sweetiebot.commitWithCodex', repositoryUri, {
                message: originalMessage,
                trailer: scmToolkitCoauthorTrailer(settings),
                codexCommitContext: settings.codexCommitContext
            });
            if (result?.committed && !result.queued && input.value === originalMessage) input.setValue('');
        } catch (error) {
            notifications.error(error);
        } finally {
            committingWithCodex = false;
            refreshCodexCommit();
        }
    };

    const refreshPullRequest = () => {
        const branch = currentBranch;
        const unavailable =
            !settings.mcpPullRequest
            || !branch
            || branch === currentDefaultBranch
            || !currentDefaultBranch
            || !currentRepositoryUri;

        const key = [currentRepositoryUri?.toString(), branch, currentDefaultBranch,
            currentBranchRevision, settings.remote].join('|');
        if (unavailable) {
            clearTimeout(pullRequestEligibilityRetry);
            pullRequestEligibilityRetry = undefined;
        }
        if (!unavailable && key !== pullRequestEligibilityKey) {
            clearTimeout(pullRequestEligibilityRetry);
            pullRequestEligibilityRetry = undefined;
            const request = ++pullRequestEligibilityRequest;
            pullRequestEligibilityKey = key;
            pullRequestEligibility = undefined;
            void commands.executeCommand('sweetiebot.pullRequestEligibility', currentRepositoryUri, {
                branch,
                base: currentDefaultBranch,
                remote: settings.remote,
            }).then(result => {
                if (pullRequestEligibilityKey !== key || pullRequestEligibilityRequest !== request) return;
                pullRequestEligibility = result;
                refreshPullRequest();
            }).catch(error => {
                if (pullRequestEligibilityKey !== key || pullRequestEligibilityRequest !== request) return;
                pullRequestEligibility = { allowed: false, reason: 'unavailable',
                    message: error.message || String(error) };
                // Setup can be repaired without moving the branch head. Do not
                // cache a failed read-only check until the window is reloaded.
                pullRequestEligibilityRetry = setTimeout(() => {
                    pullRequestEligibilityRetry = undefined;
                    if (pullRequestEligibilityKey !== key || pullRequestEligibilityRequest !== request) return;
                    pullRequestEligibilityKey = undefined;
                    refreshPullRequest();
                }, 15000);
                refreshPullRequest();
            });
        }

        pullRequestButton.hidden = !settings.mcpPullRequest;
        pullRequestButton.disabled = pending || deletingBranch || creatingPullRequest
            || creatingPonyBranch || unavailable || !pullRequestEligibility
            || (pullRequestEligibility.allowed !== true && pullRequestEligibility.reason !== 'unavailable');
        pullRequestButton.classList.toggle('scm-toolkit-pr-needs-attention', pullRequestEligibility?.reason === 'unavailable');
        const previous = pullRequestEligibility?.pullRequest;
        pullRequestTooltip.textContent = branch === currentDefaultBranch
            ? `${currentDefaultBranch} is the pull-request base branch`
            : !pullRequestEligibility
                ? 'Checking existing PRs and starting base…'
                : pullRequestEligibility.reason === 'pending-commits'
                    ? 'Open the PR window now; drafting starts after commit naming and push finish'
                    : pullRequestEligibility.reason === 'open-pr'
                        ? `PR #${previous?.number ?? '?'} is already open; new commits appear there automatically`
                    : pullRequestEligibility.reason === 'same-starting-base'
                        ? `PR #${previous?.number ?? '?'} already used this starting base; branch must start from a different commit`
                        : pullRequestEligibility.reason === 'no-commits'
                            ? 'No published commits ahead of the base'
                            : pullRequestEligibility.reason === 'unavailable'
                                ? /Install codex-pony on this repository/.test(pullRequestEligibility.message)
                                    ? 'New PR needs codex-pony access to this repository. Click for setup and retry.'
                                    : `New PR is unavailable: ${pullRequestEligibility.message}. Click for details and retry.`
                                : `Research a pull request for ${branch ?? 'the current branch'} in ChatGPT and publish with Kefania`;
        pullRequestButton.setAttribute('aria-label', pullRequestTooltip.textContent);
    };

    const createPullRequest = async event => {
        event.stopPropagation();
        const branch = currentBranch;
        const repository = currentRepositoryUri;
        if (
            !settings.mcpPullRequest
            || !branch
            || branch === currentDefaultBranch
            || !currentDefaultBranch
            || !repository
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) return;

        if (pullRequestEligibility?.allowed !== true) {
            if (pullRequestEligibility?.reason === 'unavailable') {
                try {
                    const retry = await commands.executeCommand('sweetiebot.explainPullRequestSetup', pullRequestEligibility.message);
                    if (retry) {
                        pullRequestEligibilityKey = undefined;
                        refreshPullRequest();
                    }
                } catch (error) { notifications.error(error); }
            }
            return;
        }

        creatingPullRequest = true;
        refreshBranchControls();
        try {
            const source = scmToolkitChatgptConversationSource(doc);
            const options = {
                branch,
                base: currentDefaultBranch,
                remote: settings.remote,
                mcpServer: settings.mcpPrServer,
                mcpTool: settings.mcpPrTool,
                source,
            };
            try {
                await commands.executeCommand('sweetiebot.openPullRequestChat', repository, options);
            } catch (error) {
                // Only fall back before any browser chat can have been launched.
                if (!error?.browserUnavailable && error?.name !== 'SweetiebotBrowserUnavailable') throw error;
                await commands.executeCommand('sweetiebot.createLocalPullRequest', repository, options);
            }
        } catch (error) {
            notifications.error(error);
        } finally {
            creatingPullRequest = false;
            refreshBranchControls();
        }
    };

    const refreshPonyBranch = () => {
        const unavailable = !settings.ponyBranch || !currentRepositoryUri || !currentDefaultBranch;
        ponyBranchButton.hidden = !settings.ponyBranch;
        ponyBranchButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || unavailable;

        const description =
            `Create a random pony branch from ${currentDefaultBranch}; sync first when there are no uncommitted changes`;
        ponyBranchButton.setAttribute('aria-label', description);
        ponyBranchTooltip.textContent = description;
    };

    const refreshStackedBranch = () => {
        stackedBranchButton.hidden = !settings.ponyBranch;
        stackedBranchButton.disabled = pending || deletingBranch || creatingPullRequest
            || creatingPonyBranch || !currentRepositoryUri || !currentDefaultBranch
            || !currentBranch || currentBranch === currentDefaultBranch;
        const description = currentBranch && currentBranch !== currentDefaultBranch
            ? `Create a stacked pony branch from ${currentBranch} (requires gh stack)`
            : 'Select a topic branch to create a stacked GitHub PR';
        stackedBranchButton.setAttribute('aria-label', description);
        stackedBranchTooltip.textContent = description;
    };

    const createStackedBranch = async event => {
        event.stopPropagation();
        const repository = currentRepositoryUri;
        const parent = currentBranch;
        if (!settings.ponyBranch || !repository || !parent || parent === currentDefaultBranch
            || pending || deletingBranch || creatingPullRequest || creatingPonyBranch) return;
        creatingPonyBranch = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();
        try {
            await commands.executeCommand('sweetiebot.createStackedBranch', repository, {
                parent, remote: settings.remote, names: scmToolkitBranchNamePool()
            });
        } catch (error) {
            notifications.error(error);
        } finally {
            creatingPonyBranch = false;
            pushCheckbox.disabled = updatingPush;
            refreshBranchControls();
        }
    };

    const createPonyBranch = async event => {
        event.stopPropagation();

        const repository = currentRepositoryUri;
        if (
            !settings.ponyBranch
            || !currentDefaultBranch
            || !repository
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) {
            return;
        }

        creatingPonyBranch = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        try {
            const branch = await commands.executeCommand('sweetiebot.createBranch', repository, {
                defaultBranch: currentDefaultBranch,
                remote: settings.remote,
                names: scmToolkitBranchNamePool(),
            });
            await maybePublishBranch(branch);
        } catch (error) {
            notifications.error(error);
        } finally {
            creatingPonyBranch = false;
            pushCheckbox.disabled = updatingPush;
            refreshBranchControls();
        }
    };

    const refreshSyncBranch = () => {
        const branch = currentBranch;
        const repository = currentRepositoryUri;
        syncButton.hidden = !branch;
        syncButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || !repository
            || !currentDefaultBranch;

        const description = branch === currentDefaultBranch
            ? `Sync ${branch} with its upstream branch (pull updates and push local commits)`
            : `Sync ${branch ?? 'current branch'} with ${settings.remote}/${currentDefaultBranch} as one commit (Alt-click to preserve merge ancestry)`;
        syncButton.title = description;
        syncButton.setAttribute('aria-label', description);
    };

    const syncBranch = async event => {
        event.stopPropagation();

        const branch = currentBranch;
        const repository = currentRepositoryUri;
        if (
            !branch
            || !currentDefaultBranch
            || !repository
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) {
            return;
        }

        pending = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        try {
            const result = await commands.executeCommand('sweetiebot.syncBranch', repository, {
                branch,
                defaultBranch: currentDefaultBranch,
                remote: settings.remote,
                strategy: event.altKey ? 'merge' : 'squash',
            });
            if (result) {
                notifications.info(branch === currentDefaultBranch
                    ? `Synced ${branch} with its upstream branch.`
                    : event.altKey
                        ? `Synced ${branch} with ${currentDefaultBranch} (merge).`
                        : `Squash synced '${branch}' with '${currentDefaultBranch}'`);
            }
        } catch (error) {
            // Leave merge conflicts untouched and keep the sync message for the manual commit.
            notifications.error(error);
        } finally {
            pending = false;
            pushCheckbox.disabled = updatingPush || deletingBranch;
            refreshBranchControls();
        }
    };

    const refreshBranchControls = () => {
        branchStrip.update(currentRepositoryUri, currentBranch, currentDefaultBranch,
            Boolean(currentCommand?.id));
        homeButton.hidden = branchButton.hidden;
        const homeDescription = `Home: switch to ${currentDefaultBranch || 'the default branch'}`;
        homeButton.title = homeDescription;
        homeButton.setAttribute('aria-label', homeDescription);
        homeButton.disabled = pending || deletingBranch || creatingPullRequest || creatingPonyBranch
            || !currentRepositoryUri || !currentDefaultBranch || currentBranch === currentDefaultBranch;
        branchButton.disabled =
            pending || deletingBranch || creatingPullRequest || creatingPonyBranch || !currentCommand?.id;

        const unavailable =
            !settings.branchCleanup
            || !currentBranch
            || !currentRepositoryUri;

        deleteButton.hidden = !settings.branchCleanup || !currentBranch;
        deleteButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || unavailable
            || !currentDefaultBranch
            || currentBranch === currentDefaultBranch;

        if (!currentBranch) {
            deleteButton.removeAttribute('aria-label');
            deleteTooltip.textContent = '';
        } else if (currentBranch === currentDefaultBranch) {
            const description = `${currentDefaultBranch} cannot be deleted`;
            deleteButton.setAttribute('aria-label', description);
            deleteTooltip.textContent = description;
        } else {
            const description =
                `Delete local branch ${currentBranch} if it no longer exists on ${settings.remote}`;
            deleteButton.setAttribute('aria-label', description);
            deleteTooltip.textContent = description;
        }

        refreshSyncBranch();
        refreshAutoPublish();
        refreshSpellcheck();
        refreshPostSpellcheck();
        refreshCodexCommit();
        refreshPullRequest();
        refreshPonyBranch();
        refreshStackedBranch();
    };

    const returnHome = async event => {
        event.stopPropagation();
        const repository = currentRepositoryUri;
        if (!repository || !currentDefaultBranch || currentBranch === currentDefaultBranch || pending || deletingBranch
            || creatingPullRequest || creatingPonyBranch) return;

        pending = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();
        try {
            await commands.executeCommand('sweetiebot.returnHome', repository);
        } catch (error) {
            notifications.error(error);
        } finally {
            pending = false;
            pushCheckbox.disabled = updatingPush || deletingBranch;
            refreshBranchControls();
        }
    };

    const openBranchPicker = async event => {
        event.stopPropagation();
        const command = currentCommand;
        if (!command?.id || pending || deletingBranch || creatingPullRequest || creatingPonyBranch) return;

        pending = true;
        refreshBranchControls();
        try {
            await commands.executeCommand(command.id, ...(command.arguments ?? []));
        } catch (error) {
            notifications.error(error);
        } finally {
            pending = false;
            refreshBranchControls();
        }
    };

    const deleteBranch = async (event, onlyEmpty = false) => {
        event.stopPropagation();

        const branch = currentBranch;
        const repositoryArgument = currentRepositoryUri;

        if (
            !settings.branchCleanup
            || !branch
            || !repositoryArgument
            || !currentDefaultBranch
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || pending
        ) {
            return;
        }

        if (branch === currentDefaultBranch) {
            notifications.error(`Cannot delete ${currentDefaultBranch}.`);
            return;
        }

        deletingBranch = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        try {
            let result;
            if (onlyEmpty) {
                result = await commands.executeCommand('sweetiebot.deleteEmptyBranch', repositoryArgument, {
                    branch,
                    defaultBranch: currentDefaultBranch,
                    remote: settings.remote,
                });
            } else {
                result = await commands.executeCommand('sweetiebot.deleteBranch', repositoryArgument, {
                    branch,
                    defaultBranch: currentDefaultBranch,
                    remote: settings.remote,
                });
            }
            if (!onlyEmpty && result?.remoteDeleted) {
                notifications.info(`Deleted ${branch} locally and on ${settings.remote}.`);
            }
            if (!onlyEmpty && result?.unverifiedDeleted) {
                notifications.info(`Deleted unverified local branch ${branch}.`);
            }
            if (onlyEmpty && result) {
                notifications.info(`Deleted empty branch ${branch}${result.remoteDeleted ? ' locally and on ' + settings.remote : ' locally'}.`);
            }
        } catch (error) {
            notifications.error(error);
        } finally {
            deletingBranch = false;
            pushCheckbox.disabled = updatingPush;
            refreshBranchControls();
        }
    };

    // Right-click still offers the stricter empty-branch cleanup. The trash
    // button separately confirms deletion of published PR branches.
    let branchContextMenu;
    const closeBranchContextMenu = () => {
        branchContextMenu?.remove();
        branchContextMenu = undefined;
    };
    const showBranchContextMenu = event => {
        if (
            !settings.branchCleanup || !currentBranch || !currentRepositoryUri
            || !currentDefaultBranch || currentBranch === currentDefaultBranch
            || pending || deletingBranch || creatingPullRequest || creatingPonyBranch
        ) return;
        event.preventDefault();
        event.stopPropagation();
        closeBranchContextMenu();
        const menu = doc.createElement('div');
        menu.className = 'scm-toolkit-branch-context-menu';
        menu.setAttribute('role', 'menu');
        const action = doc.createElement('button');
        action.type = 'button';
        action.setAttribute('role', 'menuitem');
        action.textContent = `Delete empty branch (local + ${settings.remote})…`;
        action.addEventListener('click', click => {
            closeBranchContextMenu();
            void deleteBranch(click, true);
        });
        menu.append(action);
        (doc.body || doc.documentElement).append(menu);
        const width = 260;
        menu.style.left = `${Math.max(0, Math.min(event.clientX, doc.defaultView.innerWidth - width))}px`;
        menu.style.top = `${Math.max(0, Math.min(event.clientY, doc.defaultView.innerHeight - menu.offsetHeight))}px`;
        branchContextMenu = menu;
        action.focus();
    };
    const dismissBranchContextMenu = event => {
        if (branchContextMenu && !branchContextMenu.contains(event.target)) closeBranchContextMenu();
    };
    const escapeBranchContextMenu = event => {
        if (event.key === 'Escape') closeBranchContextMenu();
    };
    doc.addEventListener('pointerdown', dismissBranchContextMenu, true);
    doc.addEventListener('keydown', escapeBranchContextMenu);
    branchButton.addEventListener('contextmenu', showBranchContextMenu);

    const openSettings = async event => {
        event.stopPropagation();
        try {
            await commands.executeCommand('sweetiebot.openSettings');
        } catch (error) {
            notifications.error(error);
        }
    };

    const toggleBranchPicker = event => {
        event.stopPropagation();
        if (pending || deletingBranch || creatingPullRequest || creatingPonyBranch) return;
        if (!branchStrip.toggle()) void openBranchPicker(event);
    };

    homeButton.addEventListener('click', returnHome);
    branchButton.addEventListener('click', toggleBranchPicker);
    syncButton.addEventListener('click', syncBranch);
    deleteButton.addEventListener('click', deleteBranch);
    spellcheckButton.addEventListener('click', previewSpellcheck);
    postSpellcheckButton.addEventListener('click', togglePostSpellcheck);
    codexButton.addEventListener('click', commitWithCodex);
    pullRequestButton.addEventListener('click', createPullRequest);
    ponyBranchButton.addEventListener('click', createPonyBranch);
    stackedBranchButton.addEventListener('click', createStackedBranch);
    settingsButton.addEventListener('click', openSettings);
    widget.disposables.add({
        dispose() {
            clearTimeout(defaultBranchRetry);
            repositoryResolveToken += 1;
            clearTimeout(pullRequestEligibilityRetry);
            pullRequestEligibilityRequest += 1;
            homeButton.removeEventListener('click', returnHome);
            branchButton.removeEventListener('click', toggleBranchPicker);
            branchButton.removeEventListener('contextmenu', showBranchContextMenu);
            doc.removeEventListener('pointerdown', dismissBranchContextMenu, true);
            doc.removeEventListener('keydown', escapeBranchContextMenu);
            closeBranchContextMenu();
            branchStrip.dispose();
            syncButton.removeEventListener('click', syncBranch);
            deleteButton.removeEventListener('click', deleteBranch);
            pushCheckbox.removeEventListener('change', changePush);
            autocompleteButton.removeEventListener('click', toggleAutocomplete);
            spellcheckButton.removeEventListener('click', previewSpellcheck);
            postSpellcheckButton.removeEventListener('click', togglePostSpellcheck);
            autoPublishButton.removeEventListener('click', toggleAutoPublish);
            codexButton.removeEventListener('click', commitWithCodex);
            pullRequestButton.removeEventListener('click', createPullRequest);
            ponyBranchButton.removeEventListener('click', createPonyBranch);
            stackedBranchButton.removeEventListener('click', createStackedBranch);
            settingsButton.removeEventListener('click', openSettings);
            homeButton.remove();
            branchButton.remove();
            pushControl.remove();
            syncButton.remove();
            deleteButton.remove();
            firstDivider.remove();
            autocompleteButton.remove();
            spellcheckButton.remove();
            postSpellcheckButton.remove();
            codexButton.remove();
            autoPublishButton.remove();
            secondDivider.remove();
            pullRequestButton.remove();
            ponyBranchButton.remove();
            stackedBranchButton.remove();
            settingsButton.remove();
        }
    });

    return {
        width() {
            const homeWidth = homeButton.hidden
                ? 0
                : homeButton.getBoundingClientRect().width;
            const branchWidth = branchButton.hidden
                ? 0
                : branchButton.getBoundingClientRect().width;
            const pushWidth = pushControl.hidden
                ? 0
                : pushControl.getBoundingClientRect().width;
            const syncWidth = syncButton.hidden
                ? 0
                : syncButton.getBoundingClientRect().width;
            const deleteWidth = deleteButton.hidden
                ? 0
                : deleteButton.getBoundingClientRect().width;
            const firstDividerWidth = firstDivider.hidden
                ? 0
                : firstDivider.getBoundingClientRect().width;
            const autocompleteWidth = autocompleteButton.hidden
                ? 0
                : autocompleteButton.getBoundingClientRect().width;
            const spellcheckWidth = spellcheckButton.hidden
                ? 0
                : spellcheckButton.getBoundingClientRect().width;
            const postSpellcheckWidth = postSpellcheckButton.hidden
                ? 0
                : postSpellcheckButton.getBoundingClientRect().width;
            const codexWidth = codexButton.hidden
                ? 0
                : codexButton.getBoundingClientRect().width;
            const autoPublishWidth = autoPublishButton.hidden
                ? 0
                : autoPublishButton.getBoundingClientRect().width;
            const secondDividerWidth = secondDivider.hidden
                ? 0
                : secondDivider.getBoundingClientRect().width;
            const pullRequestWidth = pullRequestButton.hidden
                ? 0
                : pullRequestButton.getBoundingClientRect().width;
            const ponyBranchWidth = ponyBranchButton.hidden
                ? 0
                : ponyBranchButton.getBoundingClientRect().width;
            const stackedBranchWidth = stackedBranchButton.hidden
                ? 0
                : stackedBranchButton.getBoundingClientRect().width;
            return homeWidth + branchWidth + pushWidth + syncWidth + deleteWidth + firstDividerWidth
                + autocompleteWidth + spellcheckWidth + postSpellcheckWidth + codexWidth + autoPublishWidth + secondDividerWidth
                + pullRequestWidth + ponyBranchWidth + stackedBranchWidth;
        },

        bind(input) {
            currentCommand = undefined;
            currentBranch = undefined;
            currentRepositoryArgument = undefined;
            currentRepositoryUri = undefined;
            currentDefaultBranch = undefined;
            branchStrip.update(undefined, undefined, undefined, false);
            clearTimeout(defaultBranchRetry);
            defaultBranchRetry = undefined;
            currentBranchRevision = undefined;
            clearTimeout(pullRequestEligibilityRetry);
            pullRequestEligibilityRetry = undefined;
            pullRequestEligibilityRequest += 1;
            pullRequestEligibilityKey = undefined;
            pullRequestEligibility = undefined;
            const resolutionToken = ++repositoryResolveToken;
            currentInput = undefined;
            homeButton.hidden = true;
            homeButton.disabled = true;
            branchButton.hidden = true;
            branchButton.disabled = true;
            pushControl.hidden = true;
            syncButton.hidden = true;
            syncButton.disabled = true;
            deleteButton.hidden = true;
            deleteButton.disabled = true;
            firstDivider.hidden = true;
            autocompleteButton.hidden = true;
            autocompleteButton.disabled = false;
            spellcheckButton.hidden = true;
            spellcheckButton.disabled = true;
            postSpellcheckButton.hidden = true;
            codexButton.hidden = true;
            autoPublishButton.hidden = true;
            autoPublishButton.disabled = true;
            secondDivider.hidden = true;
            codexButton.disabled = true;
            pullRequestButton.hidden = true;
            pullRequestButton.disabled = true;
            ponyBranchButton.hidden = true;
            ponyBranchButton.disabled = true;
            settingsButton.hidden = true;

            if (!input || input.repository.provider.providerId !== 'git') return;
            currentInput = input;
            settingsButton.hidden = false;
            const provider = input.repository.provider;
            currentRepositoryUri = provider.rootUri;
            const resolveBase = async () => {
                try {
                    const branch = await commands.executeCommand('sweetiebot.resolveDefaultBranch', provider.rootUri, {
                        remote: settings.remote
                    });
                    if (repositoryResolveToken !== resolutionToken) return;
                    if (typeof branch !== 'string' || !branch.trim()) {
                        throw new Error('The default branch is not available yet. Retrying…');
                    }
                    currentDefaultBranch = branch;
                    refreshBranchControls();
                    widget.layout();
                } catch (error) {
                    if (repositoryResolveToken !== resolutionToken) return;
                    notifications.error(error);
                    defaultBranchRetry = setTimeout(resolveBase, 15000);
                }
            };
            void resolveBase();

            if (settings.commitAndPush) {
                pushControl.hidden = false;
                refreshPush();
            }

            if (settings.autocompleteToggle) {
                autocompleteButton.hidden = false;
                refreshAutocomplete();
            }

            if (settings.spellcheckManualCommit) {
                spellcheckButton.hidden = false;
                refreshSpellcheck();
            }
            if (settings.spellcheckManualCommit || settings.draftCommitEmoji) {
                widget.repositoryDisposables.add(scmToolkitWatchDraftSpellcheck(
                    input, currentRepositoryUri, commands,
                    () => pending || deletingBranch || spellchecking,
                    {
                        spellcheck: Boolean(settings.spellcheckManualCommit),
                        professionalEmoji: Boolean(settings.draftCommitEmoji),
                        review: Boolean(settings.spellcheckManualCommit)
                            && settings.draftSpellcheckAction === 'review',
                        delaySeconds: settings.draftSpellcheckDelaySeconds || 1.5
                    }
                ));
            }

            postSpellcheckButton.hidden = false;
            refreshPostSpellcheck();
            const spellcheckInput = input;
            void commands.executeCommand('sweetiebot.postCommitSpellcheck', 'get')
                .then(enabled => {
                    if (currentInput !== spellcheckInput || typeof enabled !== 'boolean') return;
                    postSpellcheckState.enabled = enabled;
                    refreshPostSpellcheck();
                }).catch(error => notifications.error(error));

            if (settings.codexCoauthor) {
                codexButton.hidden = false;
                refreshCodexCommit();
            }

            if (settings.autoPublishToggle) {
                autoPublishButton.hidden = false;
                refreshAutoPublish();
            }

            const groupedControlsVisible =
                !autocompleteButton.hidden || !spellcheckButton.hidden || !postSpellcheckButton.hidden
                    || !codexButton.hidden || !autoPublishButton.hidden;
            firstDivider.hidden = !groupedControlsVisible;
            secondDivider.hidden = !groupedControlsVisible;

            if (settings.mcpPullRequest) {
                pullRequestButton.hidden = false;
                refreshPullRequest();
            }

            if (settings.ponyBranch) {
                ponyBranchButton.hidden = false;
                refreshPonyBranch();
                stackedBranchButton.hidden = false;
                refreshStackedBranch();
            }

            syncButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !deleteButton.hidden || !autocompleteButton.hidden || !spellcheckButton.hidden
                    || !postSpellcheckButton.hidden || !codexButton.hidden || !autoPublishButton.hidden || !pullRequestButton.hidden
                    || !ponyBranchButton.hidden || !homeButton.hidden
            );
            deleteButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !autocompleteButton.hidden || !spellcheckButton.hidden || !postSpellcheckButton.hidden || !codexButton.hidden
                    || !autoPublishButton.hidden || !pullRequestButton.hidden
                    || !ponyBranchButton.hidden || !homeButton.hidden
            );
            autocompleteButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !spellcheckButton.hidden || !postSpellcheckButton.hidden || !codexButton.hidden || !autoPublishButton.hidden
                    || !pullRequestButton.hidden || !ponyBranchButton.hidden || !homeButton.hidden
            );
            spellcheckButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !postSpellcheckButton.hidden || !codexButton.hidden || !autoPublishButton.hidden || !pullRequestButton.hidden
                    || !ponyBranchButton.hidden || !homeButton.hidden
            );
            postSpellcheckButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !codexButton.hidden || !autoPublishButton.hidden || !pullRequestButton.hidden
                    || !ponyBranchButton.hidden || !homeButton.hidden
            );
            codexButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !autoPublishButton.hidden || !pullRequestButton.hidden
                    || !ponyBranchButton.hidden || !homeButton.hidden
            );
            pullRequestButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !ponyBranchButton.hidden || !stackedBranchButton.hidden
            );
            ponyBranchButton.classList.toggle('scm-toolkit-has-following-control', !stackedBranchButton.hidden);

            scmToolkitCustomizeMessagePlaceholder(
                widget,
                input,
                configuration,
                settings.messagePlaceholder
            );

            let blankStateRefreshDisposable;
            widget.repositoryDisposables.add(observe(reader => {
                provider.actionButton?.read(reader);
                const items = provider.statusBarCommands.read(reader) ?? [];
                // Keep the first Git status command and its original arguments so the
                // built-in branch picker remains the source of truth.
                const command = items[0];
                currentCommand = command;
                currentRepositoryArgument = command?.arguments?.[0];

                if (
                    currentRepositoryArgument
                    && !widget.repositoryDisposables.__scmToolkitCommitGuardBound
                ) {
                    const asyncPushDisposable = scmToolkitGuardCommit(
                        currentRepositoryArgument,
                        commands,
                        configuration,
                        notifications,
                        settings
                    );
                    if (asyncPushDisposable) {
                        widget.repositoryDisposables.__scmToolkitCommitGuardBound = true;
                        widget.repositoryDisposables.add(asyncPushDisposable);
                    }
                }

                if (
                    (settings.blankStateRefresh || settings.autoPullClean)
                    && currentRepositoryArgument
                    && !blankStateRefreshDisposable
                ) {
                    blankStateRefreshDisposable = scmToolkitEnableBlankStateRefresh(
                        widget,
                        input,
                        commands,
                        currentRepositoryArgument,
                        settings.autoPullClean,
                        settings.blankStateRefresh
                    );
                    if (blankStateRefreshDisposable) {
                        widget.repositoryDisposables.add(blankStateRefreshDisposable);
                    }
                }

                const historyProvider = provider.historyProvider.read(reader);
                const historyItemRef = historyProvider?.historyItemRef.read(reader);
                const previousBranch = currentBranch;
                currentBranch = historyItemRef?.id?.startsWith('refs/heads/')
                    ? historyItemRef.name
                    : undefined;
                currentBranchRevision = historyItemRef?.revision;
                if (previousBranch && currentBranch && previousBranch !== currentBranch) {
                    void maybePublishBranch(currentBranch);
                }

                const branch = command?.title?.replace(/\$\([^)]+\)/g, '').trim();
                branchButton.hidden = !settings.branchPicker || !branch;
                branchLabel.textContent = branch ?? '';
                branchButton.title = command?.tooltip || `Select branch: ${branch ?? ''}`;
                branchButton.setAttribute('aria-label', `Select branch, current branch ${branch ?? ''}`);
                refreshBranchControls();
                widget.layout();
            }));
        }
    };
}

// Notification rows are reused, so update the marker whenever their message changes.
(() => {
    const selector = '.notification-list-item';
    const update = row => {
        const message = row.querySelector('.notification-list-item-message');
        const text = message?.textContent.trim() ?? '';
        row.classList.toggle('scm-toolkit-generating-commit',
            /^Generating commit message(?: asynchronously)?(?: ✨)?$/.test(text));
        row.classList.toggle('scm-toolkit-push-waiting',
            text === 'Commit message generation is in progress. Your changes will be pushed as soon as it completes.');
        row.classList.toggle('scm-toolkit-making-pr',
            text === 'Creating new pull request with Kefania instructions');
        row.classList.toggle('scm-toolkit-pr-opened',
            /^Codex Pony opened PR #[1-9]\d*$/.test(text));
        row.classList.toggle('scm-toolkit-reload-ready',
            text === 'Sweetiebot update ready');
        row.classList.toggle('scm-toolkit-pr-merged',
            /^PR #[1-9]\d* merged into main\.$/.test(text));
        row.classList.toggle('scm-toolkit-pr-queued',
            /^PR #[1-9]\d* queued for merge\.$/.test(text));
        row.classList.toggle('scm-toolkit-branch-squash-synced',
            /^Squash synced '.+' with '.+'$/.test(text));
        row.classList.toggle('scm-toolkit-operation-failed',
            /^(?:Git (?:could not complete the operation:|is locked|stopped because|refused because|could not authenticate|rejected the update|could not find|cannot complete|reported)|This folder is not a Git repository\.|Unable to squash-merge pull request:|Unable to merge #\d+:|(?:Failed|Unable) to (?:auto[- ]?merge|merge) (?:PR\b|pull request\b)|(?:Auto[- ]?merge|Automatic merge) (?:failed|failure)\b)/i.test(text));
    };
    const observer = new MutationObserver(records => {
        const rows = new Set();
        for (const record of records) {
            const target = record.target.nodeType === Node.ELEMENT_NODE
                ? record.target : record.target.parentElement;
            const row = target?.closest(selector);
            if (row) rows.add(row);
            for (const node of record.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.matches(selector)) rows.add(node);
                node.querySelectorAll(selector).forEach(row => rows.add(row));
            }
        }
        rows.forEach(update);
    });
    observer.observe(document, { childList: true, characterData: true, subtree: true });
    document.querySelectorAll(selector).forEach(update);
})();

// Called by the native titlebar, including auxiliary windows. Browser resizeTo
// cannot resize the Electron workspace window; use VS Code's native host bridge.
function scmToolkitMountCompactWindow(doc, nativeHost, commands, configuration, settings = {}) {
    // The SCM input widget may never mount in a tiny or hidden Source Control view.
    // The titlebar is always present, so watch for spelling reviews independently.
    if (commands?.executeCommand) scmToolkitWatchSpellcheckPopups(doc, commands);
    if (doc.__sweetiebotCompactWindow) return;
    const win = doc.defaultView;
    if (!win || !nativeHost?.positionWindow) return;
    const state = { restore: null, busy: false, opening: false, autoCompactStarted: false };
    doc.__sweetiebotCompactWindow = state;
    const placementKey = 'sweetiebot.compact-window-placements.v1';
    const readPlacements = () => {
        try { return JSON.parse(win.localStorage.getItem(placementKey) || '{}'); }
        catch { return {}; }
    };
    const releasePlacement = () => {
        const release = () => {
            const placements = readPlacements();
            delete placements[win.vscodeWindowId];
            win.localStorage?.setItem(placementKey, JSON.stringify(placements));
        };
        return win.navigator?.locks
            ? win.navigator.locks.request(placementKey, release) : release();
    };
    const reservePlacement = async () => {
        const reserve = async () => {
            const windows = nativeHost.getWindows
                ? await nativeHost.getWindows({ includeAuxiliaryWindows: true }) : null;
            const placements = readPlacements();
            if (windows) {
                const live = new Set(windows.map(window => String(window.id)));
                for (const id of Object.keys(placements)) if (!live.has(id)) delete placements[id];
            }
            delete placements[win.vscodeWindowId];
            const screen = win.screen;
            const display = [screen.availLeft ?? 0, screen.availTop ?? 0,
                screen.availWidth, screen.availHeight].join(':');
            const occupied = new Set(Object.values(placements)
                .filter(item => item.display === display).map(item => item.slot));
            let slot = 0;
            while (occupied.has(slot)) slot++;
            const columns = Math.max(1, Math.floor(screen.availWidth / 640));
            const x = (screen.availLeft ?? 0) + (slot % columns) * 640;
            const top = screen.availTop ?? 0;
            // Begin at the vertical middle, then fill rows below. Keep the
            // titlebar on screen when there is no room for another full row.
            const y = Math.min(top + Math.round((screen.availHeight - 640) / 2)
                + Math.floor(slot / columns) * 640, top + screen.availHeight - 640);
            placements[win.vscodeWindowId] = { display, slot };
            win.localStorage?.setItem(placementKey, JSON.stringify(placements));
            return { x, y, width: 640, height: 640 };
        };
        // Serialize reservations across renderer processes, including automatic
        // compaction of several newly opened PR windows at the same time.
        return win.navigator?.locks
            ? win.navigator.locks.request(placementKey, reserve) : reserve();
    };
    const actionId = 'sweetiebot-compact-window-action';
    const newActionId = 'sweetiebot-new-workspace-window-action';
    const displayKey = () => [win.screen.availLeft, win.screen.availTop,
        win.screen.width ?? win.screen.availWidth,
        win.screen.height ?? win.screen.availHeight, win.devicePixelRatio].join(':');
    let compactDisplay;
    let displayWatcher;
    const stopDisplayWatcher = () => {
        if (displayWatcher !== undefined) win.clearInterval(displayWatcher);
        displayWatcher = undefined;
    };
    const watchCompactDisplay = () => {
        stopDisplayWatcher();
        compactDisplay = displayKey();
        // Moving a window need not emit a renderer resize event. Watch only
        // while compact, including moves between displays with different scales.
        displayWatcher = win.setInterval(async () => {
            if (!state.restore || state.busy) return;
            // A native fill on the same display is a user expansion. Leave it
            // in place instead of undoing title-bar double-clicks every 250ms.
            const filled = win.outerWidth > 640 && win.outerHeight > 640
                && win.outerWidth >= win.screen.availWidth - 32
                && win.outerHeight >= win.screen.availHeight - 32;
            if (displayKey() === compactDisplay) {
                if (filled) {
                    state.restore = null;
                    await releasePlacement();
                    stopDisplayWatcher();
                    const action = doc.getElementById(actionId)?.querySelector('a');
                    if (action) updateAction(action);
                }
                return;
            }
            compactDisplay = displayKey();
            await releasePlacement();
            if (win.screen.availWidth < 640 || win.screen.availHeight < 640) return;
            state.busy = true;
            try {
                // setBounds alone does not leave a native maximized state.
                if (nativeHost.unmaximizeWindow) {
                    await nativeHost.unmaximizeWindow({ targetWindowId: win.vscodeWindowId });
                }
                // Keep the user's drag destination; do not center on the new display.
                await nativeHost.positionWindow({ x: win.screenX, y: win.screenY,
                    width: 640, height: 640 }, { targetWindowId: win.vscodeWindowId });
            } catch (error) {
                console.error('Sweetiebot could not preserve compact window size', error);
            } finally {
                state.busy = false;
            }
        }, 250);
    };
    const refreshVisibility = () => {
        const compact = configuration?.getValue('scmToolkit.compactWindowButton')
            ?? settings.compactWindowButton ?? true;
        const newWindow = configuration?.getValue('scmToolkit.newWorkspaceWindowButton')
            ?? settings.newWorkspaceWindowButton ?? true;
        const compactItem = doc.getElementById(actionId);
        const newItem = doc.getElementById(newActionId);
        if (compactItem) compactItem.hidden = !compact;
        if (newItem) newItem.hidden = !newWindow;
        const toolbar = doc.querySelector('.part.titlebar .titlebar-left')
            ?.querySelector('.sweetiebot-compact-window-toolbar');
        if (toolbar) toolbar.hidden = !compact && (!newWindow || !commands?.executeCommand);
    };
    const updateAction = action => {
        const compact = Boolean(state.restore);
        action.classList.toggle('codicon-screen-normal', !compact);
        action.classList.toggle('codicon-screen-full', compact);
        action.setAttribute('aria-pressed', String(compact));
        action.setAttribute('aria-disabled', String(state.busy));
        action.title = compact ? 'Expand to 75% of this display' : 'Compact window';
        action.setAttribute('aria-label', action.title);
    };
    const toggle = async action => {
        if (state.busy) return;
        // VS Code enforces a 600px minimum width when its panel is on the side.
        // Do not squeeze or rearrange the user's resizable vertical columns.
        if (!state.restore && (win.screen.availWidth < 640 || win.screen.availHeight < 640)) {
            action.title = 'Display too small for a 640px square window';
            action.setAttribute('aria-label', action.title);
            return;
        }
        state.busy = true;
        let failed = false;
        updateAction(action);
        try {
            const previous = {
                x: win.screenX, y: win.screenY,
                width: win.outerWidth, height: win.outerHeight
            };
            const screen = win.screen;
            // Expand on the current display instead of restoring stale bounds
            // from whichever display the window was originally compacted on.
            const width = state.restore
                ? Math.min(screen.availWidth, Math.max(600, Math.round(screen.availWidth * 0.75))) : 640;
            const height = state.restore ? Math.round(screen.availHeight * 0.75) : 640;
            const bounds = state.restore ? {
                x: (screen.availLeft ?? 0) + Math.round((screen.availWidth - width) / 2),
                y: (screen.availTop ?? 0) + Math.round((screen.availHeight - height) / 2),
                width, height
            } : await reservePlacement();
            if (nativeHost.unmaximizeWindow) {
                await nativeHost.unmaximizeWindow({ targetWindowId: win.vscodeWindowId });
            }
            await nativeHost.positionWindow(bounds, { targetWindowId: win.vscodeWindowId });
            state.restore = state.restore ? null : previous;
            if (state.restore) watchCompactDisplay();
            else {
                await releasePlacement();
                stopDisplayWatcher();
            }
        } catch (error) {
            if (!state.restore) await releasePlacement();
            console.error('Sweetiebot could not resize the window', error);
            failed = true;
        } finally {
            state.busy = false;
            updateAction(action);
            if (failed) {
                action.title = 'Could not resize window; click to retry';
                action.setAttribute('aria-label', action.title);
            }
        }
    };
    const startCompactIfRequested = action => {
        if (state.autoCompactStarted ||
            configuration?.getValue('scmToolkit.startCompactPRSession') !== true) return;
        state.autoCompactStarted = true;
        // Share the button's native square resize and restore behavior.
        void toggle(action);
    };
    const mount = () => {
        if (doc.getElementById(actionId)) return;
        const left = doc.querySelector('.part.titlebar .titlebar-left');
        if (!left) return;
        let toolbar = left.querySelector('.sweetiebot-compact-window-toolbar');
        if (!toolbar) {
            toolbar = doc.createElement('div');
            toolbar.className = 'monaco-action-bar sweetiebot-compact-window-toolbar';
            const actions = doc.createElement('ul');
            actions.className = 'actions-container';
            toolbar.appendChild(actions);
            left.appendChild(toolbar);
        }
        const actions = toolbar.querySelector('.actions-container');
        const item = doc.createElement('li');
        item.id = actionId;
        item.className = 'action-item sweetiebot-compact-window-action';
        item.setAttribute('role', 'presentation');
        const action = doc.createElement('a');
        action.className = 'action-label codicon';
        action.setAttribute('role', 'button');
        action.setAttribute('tabindex', '0');
        updateAction(action);
        action.addEventListener('pointerdown', event => event.stopPropagation());
        action.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            void toggle(action);
        });
        action.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            void toggle(action);
        });
        item.appendChild(action);
        actions.prepend(item);
        if (commands?.executeCommand) {
            const newItem = doc.createElement('li');
            newItem.id = newActionId;
            newItem.className = 'action-item sweetiebot-compact-window-action';
            newItem.setAttribute('role', 'presentation');
            const newAction = doc.createElement('a');
            newAction.className = 'action-label codicon codicon-link-external';
            newAction.title = 'Open a window on shared main';
            newAction.setAttribute('aria-label', newAction.title);
            newAction.setAttribute('role', 'button');
            newAction.setAttribute('tabindex', '0');
            newAction.setAttribute('aria-disabled', String(state.opening));
            const open = async () => {
                if (state.opening) return;
                state.opening = true;
                newAction.setAttribute('aria-disabled', 'true');
                try {
                    await commands.executeCommand('sweetiebot.openIndependentWorkspace');
                    newAction.title = 'Open a window on shared main';
                } catch (error) {
                    console.error('Sweetiebot could not open the workspace in a new window', error);
                    newAction.title = 'Could not open workspace in new window; click to retry';
                } finally {
                    state.opening = false;
                    newAction.setAttribute('aria-disabled', 'false');
                    newAction.setAttribute('aria-label', newAction.title);
                }
            };
            newAction.addEventListener('pointerdown', event => event.stopPropagation());
            newAction.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                void open();
            });
            newAction.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                void open();
            });
            newItem.appendChild(newAction);
            actions.appendChild(newItem);
        }
        refreshVisibility();
        startCompactIfRequested(action);
    };
    mount();
    const observer = new win.MutationObserver(mount);
    observer.observe(doc.body, { childList: true, subtree: true });
    const visibilityListener = configuration?.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('scmToolkit.compactWindowButton')
            || event.affectsConfiguration('scmToolkit.newWorkspaceWindowButton')) refreshVisibility();
        if (event.affectsConfiguration('scmToolkit.startCompactPRSession')) {
            const action = doc.getElementById(actionId)?.querySelector('a');
            if (action) startCompactIfRequested(action);
        }
    });
    win.addEventListener('unload', () => {
        // Closed-window reservations are pruned using the native window list.
        stopDisplayWatcher();
        observer.disconnect();
        visibilityListener?.dispose();
    }, { once: true });
}

// Resolve the active rendered theme, including the user's color customizations.
function scmToolkitKefaniaThemeColors(doc = document) {
    const win = doc.defaultView;
    const style = win.getComputedStyle(doc.querySelector('.monaco-workbench') || doc.documentElement);
    const tokens = {
        bg: 'editor-background', panel: 'sideBar-background',
        line: 'panel-border', text: 'foreground', muted: 'descriptionForeground',
        accent: 'textLink-foreground', button: 'button-background',
        buttonText: 'button-foreground', buttonHover: 'button-hoverBackground',
        control: 'button-secondaryBackground', controlText: 'button-secondaryForeground',
        controlHover: 'button-secondaryHoverBackground', focus: 'focusBorder',
        error: 'errorForeground', code: 'textCodeBlock-background'
    };
    const colors = {};
    for (const [key, token] of Object.entries(tokens)) {
        const value = style.getPropertyValue('--vscode-' + token).trim();
        if (value && win.CSS.supports('color', value)) colors[key] = value;
    }
    return colors;
}
