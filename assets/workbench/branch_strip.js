// Preserve branch order and featured membership when searching by name.
function scmToolkitFilterBranchStrip(branches, featuredCount, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return { branches, featuredCount };
    const matching = [];
    let matchingFeatured = 0;
    branches.forEach((item, index) => {
        if (item.name.toLowerCase().includes(needle)) {
            matching.push(item);
            if (index < featuredCount) matchingFeatured++;
        }
    });
    return { branches: matching, featuredCount: matchingFeatured };
}

// Keep recent branch visits ahead of branches with only recent commits.
function scmToolkitSortBranchStrip(branches, recent = {}) {
    return [...branches].sort((a, b) =>
        (Number(recent[b.name]) || 0) - (Number(recent[a.name]) || 0)
        || (Number(b.modified) || 0) - (Number(a.modified) || 0)
        || a.name.localeCompare(b.name));
}

// A compact, vertical branch popup opened from the existing SCM branch button.
// The native branch picker stays available as the overflow action and elsewhere.
function scmToolkitCreateBranchStrip(widget, commands, notifications, settings, openNativePicker, trigger) {
    const doc = widget.element.ownerDocument;
    const win = doc.defaultView;
    const bar = doc.createElement('div');
    bar.className = 'scm-toolkit-branch-strip';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Git branches');
    const filterInput = doc.createElement('input');
    filterInput.type = 'search';
    filterInput.className = 'scm-toolkit-branch-strip-filter';
    filterInput.placeholder = 'Filter branches';
    filterInput.setAttribute('aria-label', 'Filter branches');
    filterInput.setAttribute('autocomplete', 'off');
    filterInput.spellcheck = false;
    const scroll = doc.createElement('div');
    scroll.className = 'scm-toolkit-branch-strip-scroll';
    scroll.setAttribute('aria-label', 'Branches');
    scroll.setAttribute('tabindex', '0');
    const nativeButton = doc.createElement('button');
    nativeButton.type = 'button';
    nativeButton.className = 'scm-toolkit-branch-strip-native codicon codicon-ellipsis';
    nativeButton.title = 'Open Git branch and tag picker';
    nativeButton.setAttribute('aria-label', nativeButton.title);
    nativeButton.addEventListener('click', event => {
        close();
        openNativePicker(event);
    });
    const header = doc.createElement('div');
    header.className = 'scm-toolkit-branch-strip-header';
    header.append(filterInput, nativeButton);
    bar.append(header, scroll);

    let repository, branch, base, pickerReady = false, panelMode = false, disposed = false;
    let generation = 0, refreshedAt = 0, refreshedRepository = '';
    let refreshTimer, pending = false, knownBranches = [], lastFeaturedCount = 0;
    let lastPrStatus = 'unavailable', lastRemoteStatus = 'available', lastScrolledBranch, showingLoading = false;
    let recentKey = '', recentBranches = Object.create(null), lastRecordedBranch = '';
    const rememberBranch = repositoryId => {
        if (!repositoryId) return;
        const key = `sweetiebot.branchRecent.v1:${repositoryId}`;
        if (recentKey !== key) {
            recentKey = key;
            lastRecordedBranch = '';
            try {
                const stored = JSON.parse(win.localStorage.getItem(key) || '{}');
                recentBranches = stored && typeof stored === 'object' && !Array.isArray(stored)
                    ? stored : Object.create(null);
            } catch { recentBranches = Object.create(null); }
        }
        if (!branch || lastRecordedBranch === branch) return;
        recentBranches[branch] = Date.now();
        lastRecordedBranch = branch;
        const recent = Object.entries(recentBranches)
            .filter(([, stamp]) => Number.isFinite(Number(stamp)))
            .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 60);
        recentBranches = Object.fromEntries(recent);
        try { win.localStorage.setItem(key, JSON.stringify(recentBranches)); }
        catch { /* Still maintain in-memory recency if browser storage is unavailable. */ }
    };
    let opened = false;
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    const close = (restoreFocus = false) => {
        opened = false;
        showingLoading = false;
        filterInput.value = '';
        generation++; // Reject refresh results arriving after close.
        bar.remove();
        trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus && trigger.isConnected) trigger.focus();
    };
    const position = () => {
        const rect = trigger.getBoundingClientRect();
        const view = widget.element.closest('.scm-view');
        const host = view?.getBoundingClientRect() || rect;
        // The popup occupies the SCM area's remaining height, not the entire panel width.
        const width = Math.max(0, Math.min(host.width || win.innerWidth - 16,
            Math.min(360, Math.max(245, Math.round(win.innerWidth * .24))),
            win.innerWidth - 16));
        const bottom = Math.min(host.bottom || win.innerHeight - 8, win.innerHeight - 8);
        const above = Math.max(0, rect.top - Math.max(8, host.top) - 4);
        const below = Math.max(0, bottom - rect.bottom - 4);
        const placeBelow = below >= above;
        const height = Math.min(Math.max(above, below), win.innerHeight - 16);
        bar.style.width = `${width}px`;
        bar.style.left = `${Math.max(8, Math.min(host.left, win.innerWidth - width - 8))}px`;
        bar.style.height = `${height}px`;
        bar.style.maxHeight = `${win.innerHeight - 16}px`;
        bar.style.top = `${placeBelow ? rect.bottom + 4
            : Math.max(8, rect.top - height - 4)}px`;
    };

    const render = (list, featuredCount, prStatus, remoteStatus = lastRemoteStatus) => {
        const filtered = scmToolkitFilterBranchStrip(list, featuredCount, filterInput.value);
        list = scmToolkitSortBranchStrip(filtered.branches, recentBranches);
        const previousScroll = scroll.scrollTop;
        const fragment = doc.createDocumentFragment();
        if (remoteStatus === 'loading' || prStatus === 'loading') {
            const note = doc.createElement('span');
            note.className = 'scm-toolkit-branch-strip-note';
            note.textContent = 'Checking origin and pull requests…';
            fragment.append(note);
        } else if (remoteStatus !== 'available' || prStatus !== 'available') {
            const note = doc.createElement('span');
            note.className = 'scm-toolkit-branch-strip-note';
            note.textContent = remoteStatus !== 'available'
                ? 'Origin unavailable — local branches only'
                : 'PR status unavailable';
            fragment.append(note);
        }
        const section = title => {
            const heading = doc.createElement('span');
            heading.className = 'scm-toolkit-branch-strip-section';
            heading.textContent = title;
            fragment.append(heading);
        };
        let seenOther = false;
        list.forEach((item, index) => {
            const isRecent = Number(recentBranches[item.name]) > 0;
            if (!index) section(isRecent ? 'Recently used' : 'Branches');
            else if (!isRecent && !seenOther) {
                section('Other branches');
                seenOther = true;
            }
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'scm-toolkit-branch-strip-item';
            const isCurrent = item.name === branch;
            button.classList.toggle('current', isCurrent);
            button.setAttribute('aria-current', isCurrent ? 'true' : 'false');
            const locations = [item.local && 'local', item.origin && settings.remote]
                .filter(Boolean).join(' + ');
            const pr = item.pr;
            const state = pr?.number ? `PR #${pr.number} (${String(pr.state || 'unknown').toLowerCase()})`
                : item.hasPr === true ? 'has a PR'
                : item.merged ? 'merged into base'
                : item.hasPr === null ? 'PR status unknown' : 'no PR';
            button.title = `${item.name} (${locations || 'unknown location'}; ${state})`;
            button.setAttribute('aria-label', `Check out ${button.title}`);
            const icon = (name, title) => {
                const el = doc.createElement('span');
                el.className = `codicon codicon-${name}`;
                el.title = title;
                el.setAttribute('aria-hidden', 'true');
                return el;
            };
            const label = doc.createElement('span');
            label.className = 'scm-toolkit-branch-strip-label';
            label.textContent = item.name;
            button.append(label);
            const metadata = doc.createElement('span');
            metadata.className = 'scm-toolkit-branch-strip-metadata';
            if (item.local) metadata.append(icon('git-branch', 'Local branch'));
            if (item.origin) metadata.append(icon('cloud', `On ${settings.remote}`));
            if (item.hasPr === true) {
                const badge = doc.createElement('span');
                badge.className = 'scm-toolkit-branch-strip-pr';
                badge.textContent = pr?.number ? `PR #${pr.number}` : 'PR';
                badge.title = pr?.url ? `${state}: ${pr.url}` : state;
                metadata.append(badge);
            }
            button.append(metadata);
            button.disabled = pending;
            button.addEventListener('click', () => {
                if (pending || !repository) return;
                if (isCurrent) close(true);
                else void checkout(item.name);
            });
            fragment.append(button);
        });
        if (!list.length) {
            const label = doc.createElement('span');
            label.className = 'scm-toolkit-branch-strip-note';
            label.textContent = filterInput.value.trim() ? 'No matching branches' : 'No branches found';
            fragment.append(label);
        }
        scroll.replaceChildren(fragment);
        if (opened) position();
        if (!filterInput.value.trim() && lastScrolledBranch !== branch) {
            lastScrolledBranch = branch;
            scroll.querySelector('[aria-current="true"]')
                ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else {
            scroll.scrollTop = previousScroll;
        }
    };

    filterInput.addEventListener('input', () => {
        if (!showingLoading) render(knownBranches, lastFeaturedCount, lastPrStatus);
    });
    // Typing continues to search after keyboard focus moves into the branch buttons.
    bar.addEventListener('keydown', event => {
        if (!opened || event.target === filterInput || event.ctrlKey || event.metaKey
            || event.altKey || event.isComposing || event.key.length !== 1
            || event.key === ' ') return;
        filterInput.value += event.key;
        filterInput.focus();
        if (!showingLoading) render(knownBranches, lastFeaturedCount, lastPrStatus);
        event.preventDefault();
    });

    const refresh = async (force = false) => {
        if (!opened || !panelMode || !repository || !base || disposed) return;
        const uri = repository;
        const key = `${uri.toString()}:${base}`;
        if (!force && key === refreshedRepository && Date.now() - refreshedAt < 20000) return;
        const request = ++generation;
        const active = () => !disposed && opened && request === generation
            && repository === uri && panelMode;
        refreshedAt = Date.now();
        refreshedRepository = key;
        try {
            // Render local refs before any remote network or GitHub CLI request.
            const local = await commands.executeCommand('sweetiebot.listBranchStrip', uri,
                { remote: settings.remote, defaultBranch: base, localOnly: true });
            if (!active()) return;
            rememberBranch(local?.repositoryId);
            showingLoading = false;
            knownBranches = Array.isArray(local?.branches) ? local.branches : [];
            lastFeaturedCount = local?.featuredCount ?? 0;
            lastPrStatus = 'loading';
            lastRemoteStatus = 'loading';
            render(knownBranches, lastFeaturedCount, lastPrStatus, lastRemoteStatus);
        } catch (error) {
            if (!active()) return;
            showingLoading = false;
            refreshedAt = 0;
            lastPrStatus = 'unavailable';
            lastRemoteStatus = 'unavailable';
            render(knownBranches, lastFeaturedCount, lastPrStatus, lastRemoteStatus);
            console.warn('Sweetiebot local branch refresh failed:', error);
            return;
        }
        try {
            const result = await commands.executeCommand('sweetiebot.listBranchStrip', uri,
                { remote: settings.remote, defaultBranch: base });
            if (!active()) return;
            rememberBranch(result?.repositoryId);
            knownBranches = Array.isArray(result?.branches) ? result.branches : [];
            lastFeaturedCount = result?.featuredCount ?? 0;
            lastPrStatus = result?.prStatus ?? 'unavailable';
            lastRemoteStatus = result?.remoteStatus ?? 'unavailable';
            render(knownBranches, lastFeaturedCount, lastPrStatus, lastRemoteStatus);
        } catch (error) {
            if (!active()) return;
            refreshedAt = 0;
            lastPrStatus = 'unavailable';
            lastRemoteStatus = 'unavailable';
            // Keep the already loaded local branches instead of blanking the selector.
            render(knownBranches, lastFeaturedCount, lastPrStatus, lastRemoteStatus);
            console.warn('Sweetiebot remote branch refresh failed:', error);
        }
    };

    const checkout = async name => {
        if (pending || !repository) return;
        pending = true;
        const repo = repository;
        for (const el of scroll.querySelectorAll('button')) el.disabled = true;
        try {
            await commands.executeCommand('sweetiebot.checkoutBranchStrip', repo,
                { branch: name, remote: settings.remote });
            if (recentKey) {
                recentBranches[name] = Date.now();
                lastRecordedBranch = name;
                try { win.localStorage.setItem(recentKey, JSON.stringify(recentBranches)); }
                catch { /* Recency remains available during this session. */ }
            }
            lastScrolledBranch = undefined;
            refreshedAt = 0;
            close(true);
        } catch (error) {
            notifications.error(error);
        } finally {
            pending = false;
            for (const el of scroll.querySelectorAll('button')) el.disabled = false;
        }
    };

    const syncPlacement = () => {
        if (disposed) return false;
        const panel = widget.element.closest('.part.panel, .part.sidebar, .part.auxiliarybar');
        const view = widget.element.closest('.scm-view');
        const eligible = Boolean(panel && view && repository && base && pickerReady
            && settings.horizontalBranchSelector);
        panelMode = eligible;
        if (!eligible) {
            close();
            generation++;
            return false;
        }
        if (opened) {
            const host = doc.querySelector('.monaco-workbench') || doc.body;
            if (bar.parentElement !== host) host.append(bar);
            position();
        }
        return true;
    };

    const update = (uri, currentBranch, defaultBranch, hasNativePicker) => {
        const repositoryChanged = repository?.toString() !== uri?.toString()
            || base !== defaultBranch;
        const branchChanged = branch !== currentBranch;
        repository = uri;
        branch = currentBranch;
        base = defaultBranch;
        pickerReady = hasNativePicker;
        if (!syncPlacement()) return false;
        if (repositoryChanged) {
            close();
            refreshedAt = 0;
            knownBranches = [];
            scroll.replaceChildren();
            lastScrolledBranch = undefined;
        }
        if (!showingLoading && branchChanged && knownBranches.length) {
            render(knownBranches, lastFeaturedCount, lastPrStatus);
        }
        if (repositoryChanged || branchChanged || Date.now() - refreshedAt >= 20000) {
            void refresh();
        }
        return true;
    };

    // The selector follows SCM when it moves between the panel and either sidebar.
    const observer = new win.MutationObserver(() => {
        const wasPanelMode = panelMode;
        if (syncPlacement() && !wasPanelMode) void refresh(true);
    });
    observer.observe(doc.querySelector('.monaco-workbench') || doc.body,
        { childList: true, subtree: true });
    const focus = () => {
        if (syncPlacement()) void refresh();
    };
    win.addEventListener('focus', focus);
    const dismiss = event => {
        if (opened && !bar.contains(event.target) && !trigger.contains(event.target)) close();
    };
    const escape = event => {
        if (opened && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
        }
    };
    const resized = () => close();
    doc.addEventListener('pointerdown', dismiss, true);
    doc.addEventListener('keydown', escape, true);
    win.addEventListener('resize', resized);
    refreshTimer = win.setInterval(focus, 20000);
    return {
        update,
        toggle() {
            if (!syncPlacement()) return false;
            if (opened) close();
            else {
                opened = true;
                trigger.setAttribute('aria-expanded', 'true');
                syncPlacement();
                showingLoading = !knownBranches.length;
                if (knownBranches.length) {
                    const cachedLocal = knownBranches.filter(item => item.local)
                        .map(item => ({ ...item, origin: false }));
                    render(cachedLocal, 0, 'loading', 'loading');
                } else scroll.textContent = 'Loading local branches…';
                position();
                void refresh(true);
                filterInput.focus();
            }
            return true;
        },
        get visible() { return opened; },
        dispose() {
            disposed = true;
            win.clearInterval(refreshTimer);
            observer.disconnect();
            win.removeEventListener('focus', focus);
            doc.removeEventListener('pointerdown', dismiss, true);
            doc.removeEventListener('keydown', escape, true);
            win.removeEventListener('resize', resized);
            generation++;
            close();
        }
    };
}
