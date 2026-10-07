// Runs inside VS Code's SCM input widget; services and observables are supplied by install.py.
function scmToolkitHideOutgoingSyncCount(widget) {
    const root = widget.element.closest('.scm-view');
    const Observer = widget.element.ownerDocument.defaultView?.MutationObserver;
    if (!root || !Observer) return;

    const observedRoots = globalThis.__scmToolkitOutgoingSyncRoots ??= new WeakSet();
    if (observedRoots.has(root)) return;
    observedRoots.add(root);

    const update = () => {
        for (const action of root.querySelectorAll('.button-container .monaco-button')) {
            if (!action.querySelector('.codicon-sync')) continue;

            for (const upArrow of action.querySelectorAll(
                '.monaco-button-label > .codicon-arrow-up, '
                + '.monaco-button-label-short > .codicon-arrow-up'
            )) {
                const count = upArrow.previousElementSibling;
                if (!count || count.classList.contains('codicon')) continue;

                const text = count.textContent ?? '';
                const withoutOutgoingCount = text.replace(/\s*\d+\s*$/, '').trimEnd();
                if (withoutOutgoingCount === text) continue;

                count.textContent = withoutOutgoingCount;
                count.hidden = withoutOutgoingCount.trim() === '';
            }
        }
    };

    update();
    const observer = new Observer(update);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
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
        if (!button || !current) return;

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
                await maybeAutoPull();
            } catch {
                // The built-in Git extension owns refresh errors; keep blank-state polling best-effort.
            } finally {
                refreshing = false;
                if (!disposed && !hasChanges()) schedule(1500);
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

function scmToolkitWithCodexCoauthor(message) {
    const base = message.trimEnd();
    if (!base) return '';

    const alreadyAttributed = base.split(/\r?\n/).some(
        line => line.trim() === SCM_TOOLKIT_CODEX_COAUTHOR
    );
    return alreadyAttributed ? base : `${base}\n\n${SCM_TOOLKIT_CODEX_COAUTHOR}`;
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


async function scmToolkitPushWithPullRetry(repository, originalPush) {
    const head = repository.HEAD;
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

function scmToolkitGuardCommit(repository, commands, configuration, notifications) {
    if (!repository || typeof repository.commit !== 'function') return;

    const wrappedRepositories =
        globalThis.__scmToolkitCommitGuardRepositories ??= new WeakMap();
    let state = wrappedRepositories.get(repository);

    if (!state) {
        const originalCommit = repository.commit;
        const originalPush = repository.push;

        const wrappedCommit = async function(message, options) {
            try {
                const allowed = await commands.executeCommand(
                    'sweetiebot.checkCommitLimits',
                    repository.rootUri
                );
                if (allowed === false) return;
            } catch {
                // Keep commits usable if the companion extension is temporarily unavailable.
            }

            let commitLease = false;
            try {
                try {
                    await commands.executeCommand('sweetiebot.beginCommit', repository.rootUri);
                    commitLease = true;
                } catch {
                    // If the companion extension is unavailable, its auto-pull is unavailable too.
                }

                const requestedPostCommitCommand = options?.postCommitCommand;
                const configuredPostCommitCommand =
                    configuration.getValue('git.postCommitCommand');
                const shouldReleasePush =
                    requestedPostCommitCommand === 'push'
                    || (
                        requestedPostCommitCommand === undefined
                        && configuredPostCommitCommand === 'push'
                    );

                if (!shouldReleasePush || typeof originalPush !== 'function') {
                    return await originalCommit.call(repository, message, options);
                }

                await originalCommit.call(repository, message, {
                    ...(options ?? {}),
                    postCommitCommand: null,
                });

                void scmToolkitPushWithPullRetry(repository, originalPush)
                    .catch(error => notifications.error(error));
            } finally {
                if (commitLease) {
                    try {
                        await commands.executeCommand('sweetiebot.endCommit', repository.rootUri);
                    } catch {
                        // The extension may be reloading; do not turn a successful commit into an error.
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

function scmToolkitCreateControls(widget, observe, commands, notifications, configuration, mcpService, settings) {
    const doc = widget.element.ownerDocument;
    if (settings.hideOutgoingSyncCount) scmToolkitHideOutgoingSyncCount(widget);
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
    homeButton.title = 'Home: switch to main';
    homeButton.setAttribute('aria-label', 'Home: switch to main');

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
    pushControl.title = 'Commit and push after a successful commit';

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

    const codexButton = doc.createElement('button');
    codexButton.type = 'button';
    codexButton.className = 'scm-toolkit-codex-coauthor codicon codicon-account';
    codexButton.hidden = true;
    codexButton.title = 'Commit with Codex co-author';
    codexButton.setAttribute('aria-label', 'Commit with Codex co-author');

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

    const settingsButton = doc.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'scm-toolkit-settings';
    settingsButton.textContent = '🪄';
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
        codexButton,
        autoPublishButton,
        secondDivider,
        homeButton,
        pullRequestButton,
        ponyBranchButton
    );

    let currentCommand;
    let currentBranch;
    let currentRepositoryArgument;
    let currentRepositoryUri;
    let currentInput;
    let pending = false;
    let deletingBranch = false;
    let creatingPullRequest = false;
    let creatingPonyBranch = false;
    let updatingPush = false;
    let updatingAutocomplete = false;
    let updatingAutoPublish = false;
    let publishingBranch;
    let committingWithCodex = false;

    const refreshPush = () => {
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
            ? 'Turn off inline autocomplete'
            : 'Turn on inline autocomplete';
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
            || !branch
            || branch === settings.defaultBranch
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

        let attributedMessage;
        committingWithCodex = true;
        refreshCodexCommit();

        try {
            await commands.executeCommand('sweetiebot.prepareCodexCommit', repositoryUri);
            const message = originalMessage.trim() ? originalMessage : await commands.executeCommand(
                'sweetiebot.generateCodexCommitMessage', repositoryUri
            );
            if (currentInput !== input || input.value !== originalMessage) {
                throw new Error('The selected repository or commit message changed during local generation. Try again.');
            }
            if (typeof message !== 'string' || !message.trim()) {
                throw new Error('Local Ollama returned an empty commit message.');
            }
            attributedMessage = scmToolkitWithCodexCoauthor(message);
            input.setValue(attributedMessage, false);
            await commands.executeCommand(
                currentCommitCommand.id,
                ...(currentCommitCommand.arguments ?? [])
            );
        } catch (error) {
            notifications.error(error);
        } finally {
            if (attributedMessage && input.value === attributedMessage) {
                input.setValue(originalMessage, false);
            }
            committingWithCodex = false;
            refreshCodexCommit();
        }
    };

    const refreshPullRequest = () => {
        const branch = currentBranch;
        const unavailable =
            !settings.mcpPullRequest
            || !branch
            || branch === settings.defaultBranch
            || !currentRepositoryUri;

        pullRequestButton.hidden = !settings.mcpPullRequest;
        pullRequestButton.disabled =
            pending || deletingBranch || creatingPullRequest || creatingPonyBranch || unavailable;
        pullRequestTooltip.textContent = branch === settings.defaultBranch
            ? `${settings.defaultBranch} is the pull-request base branch`
            : `Draft a pull request for ${branch ?? 'the current branch'} with Kafania in ChatGPT`;
        pullRequestButton.setAttribute('aria-label', pullRequestTooltip.textContent);
    };

    const createPullRequest = async event => {
        event.stopPropagation();
        const branch = currentBranch;
        const repository = currentRepositoryUri;
        if (
            !settings.mcpPullRequest
            || !branch
            || branch === settings.defaultBranch
            || !repository
            || pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
        ) return;

        creatingPullRequest = true;
        refreshBranchControls();
        try {
            const source = scmToolkitChatgptConversationSource(doc);
            const launch = await commands.executeCommand('sweetiebot.openPullRequestChat', repository, {
                branch,
                base: settings.defaultBranch,
                remote: settings.remote,
                mcpServer: settings.mcpPrServer,
                mcpTool: settings.mcpPrTool,
                source,
            });
            void scmToolkitRecordPullRequestSource(
                doc,
                mcpService,
                settings,
                launch,
                branch,
                settings.defaultBranch,
                source
            ).catch(error => notifications.error(error));
        } catch (error) {
            notifications.error(error);
        } finally {
            creatingPullRequest = false;
            refreshBranchControls();
        }
    };

    const refreshPonyBranch = () => {
        const unavailable = !settings.ponyBranch || !currentRepositoryUri;
        ponyBranchButton.hidden = !settings.ponyBranch;
        ponyBranchButton.disabled =
            pending
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || unavailable;

        const description =
            `Create a random pony branch from ${settings.defaultBranch}; sync first when there are no uncommitted changes`;
        ponyBranchButton.setAttribute('aria-label', description);
        ponyBranchTooltip.textContent = description;
    };

    const createPonyBranch = async event => {
        event.stopPropagation();

        const repository = currentRepositoryUri;
        if (
            !settings.ponyBranch
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
                defaultBranch: settings.defaultBranch,
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
            || branch === settings.defaultBranch;

        const description = branch === settings.defaultBranch
            ? `${settings.defaultBranch} is the sync base branch`
            : `Sync ${branch ?? 'current branch'} with ${settings.remote}/${settings.defaultBranch}`;
        syncButton.title = description;
        syncButton.setAttribute('aria-label', description);
    };

    const syncBranch = async event => {
        event.stopPropagation();

        const branch = currentBranch;
        const repository = currentRepositoryUri;
        if (
            !branch
            || branch === settings.defaultBranch
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
            await commands.executeCommand('sweetiebot.syncBranch', repository, {
                branch,
                defaultBranch: settings.defaultBranch,
                remote: settings.remote,
            });
            notifications.info(`Synced ${branch} with ${settings.defaultBranch}.`);
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
        homeButton.hidden = branchButton.hidden;
        homeButton.disabled = pending || deletingBranch || creatingPullRequest || creatingPonyBranch
            || !currentRepositoryUri || currentBranch === 'main';
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
            || currentBranch === settings.defaultBranch;

        if (!currentBranch) {
            deleteButton.removeAttribute('aria-label');
            deleteTooltip.textContent = '';
        } else if (currentBranch === settings.defaultBranch) {
            const description = `${settings.defaultBranch} cannot be deleted`;
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
        refreshCodexCommit();
        refreshPullRequest();
        refreshPonyBranch();
    };

    const returnHome = async event => {
        event.stopPropagation();
        const repository = currentRepositoryUri;
        if (!repository || currentBranch === 'main' || pending || deletingBranch
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

    const deleteBranch = async event => {
        event.stopPropagation();

        const branch = currentBranch;
        const repositoryArgument = currentRepositoryUri;

        if (
            !settings.branchCleanup
            || !branch
            || !repositoryArgument
            || deletingBranch
            || creatingPullRequest
            || creatingPonyBranch
            || pending
        ) {
            return;
        }

        if (branch === settings.defaultBranch) {
            notifications.error(`Cannot delete ${settings.defaultBranch}.`);
            return;
        }

        deletingBranch = true;
        pushCheckbox.disabled = true;
        refreshBranchControls();

        try {
            await commands.executeCommand('sweetiebot.deleteBranch', repositoryArgument, {
                branch,
                defaultBranch: settings.defaultBranch,
                remote: settings.remote,
            });
        } catch (error) {
            notifications.error(error);
        } finally {
            deletingBranch = false;
            pushCheckbox.disabled = updatingPush;
            refreshBranchControls();
        }
    };

    const openSettings = async event => {
        event.stopPropagation();
        try {
            await commands.executeCommand('sweetiebot.openSettings');
        } catch (error) {
            notifications.error(error);
        }
    };

    homeButton.addEventListener('click', returnHome);
    branchButton.addEventListener('click', openBranchPicker);
    syncButton.addEventListener('click', syncBranch);
    deleteButton.addEventListener('click', deleteBranch);
    codexButton.addEventListener('click', commitWithCodex);
    pullRequestButton.addEventListener('click', createPullRequest);
    ponyBranchButton.addEventListener('click', createPonyBranch);
    settingsButton.addEventListener('click', openSettings);
    widget.disposables.add({
        dispose() {
            homeButton.removeEventListener('click', returnHome);
            branchButton.removeEventListener('click', openBranchPicker);
            syncButton.removeEventListener('click', syncBranch);
            deleteButton.removeEventListener('click', deleteBranch);
            pushCheckbox.removeEventListener('change', changePush);
            autocompleteButton.removeEventListener('click', toggleAutocomplete);
            autoPublishButton.removeEventListener('click', toggleAutoPublish);
            codexButton.removeEventListener('click', commitWithCodex);
            pullRequestButton.removeEventListener('click', createPullRequest);
            ponyBranchButton.removeEventListener('click', createPonyBranch);
            settingsButton.removeEventListener('click', openSettings);
            homeButton.remove();
            branchButton.remove();
            pushControl.remove();
            syncButton.remove();
            deleteButton.remove();
            firstDivider.remove();
            autocompleteButton.remove();
            codexButton.remove();
            autoPublishButton.remove();
            secondDivider.remove();
            pullRequestButton.remove();
            ponyBranchButton.remove();
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
            return homeWidth + branchWidth + pushWidth + syncWidth + deleteWidth + firstDividerWidth
                + autocompleteWidth + codexWidth + autoPublishWidth + secondDividerWidth
                + pullRequestWidth + ponyBranchWidth;
        },

        bind(input) {
            currentCommand = undefined;
            currentBranch = undefined;
            currentRepositoryArgument = undefined;
            currentRepositoryUri = undefined;
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

            if (settings.commitAndPush) {
                pushControl.hidden = false;
                refreshPush();
            }

            if (settings.autocompleteToggle) {
                autocompleteButton.hidden = false;
                refreshAutocomplete();
            }

            if (settings.codexCoauthor) {
                codexButton.hidden = false;
                refreshCodexCommit();
            }

            if (settings.autoPublishToggle) {
                autoPublishButton.hidden = false;
                refreshAutoPublish();
            }

            const groupedControlsVisible =
                !autocompleteButton.hidden || !codexButton.hidden || !autoPublishButton.hidden;
            firstDivider.hidden = !groupedControlsVisible;
            secondDivider.hidden = !groupedControlsVisible;

            if (settings.mcpPullRequest) {
                pullRequestButton.hidden = false;
                refreshPullRequest();
            }

            if (settings.ponyBranch) {
                ponyBranchButton.hidden = false;
                refreshPonyBranch();
            }

            syncButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !deleteButton.hidden || !autocompleteButton.hidden || !codexButton.hidden
                    || !autoPublishButton.hidden || !pullRequestButton.hidden
                    || !ponyBranchButton.hidden || !homeButton.hidden
            );
            deleteButton.classList.toggle(
                'scm-toolkit-has-following-control',
                !autocompleteButton.hidden || !codexButton.hidden || !autoPublishButton.hidden
                    || !pullRequestButton.hidden || !ponyBranchButton.hidden || !homeButton.hidden
            );
            autocompleteButton.classList.toggle(
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
                !ponyBranchButton.hidden
            );

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
                        notifications
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
        row.classList.toggle('scm-toolkit-generating-commit',
            /^Generating commit message(?: ✨)?$/.test(message?.textContent.trim() ?? ''));
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
