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

// A wrapping branch popup opened from the existing SCM branch button.
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
    bar.append(filterInput, scroll, nativeButton);

    let repository, branch, base, pickerReady = false, panelMode = false, disposed = false;
    let generation = 0, refreshedAt = 0, refreshedRepository = '';
    let refreshTimer, pending = false, knownBranches = [], lastFeaturedCount = 0;
    let lastPrStatus = 'unavailable', lastRemoteStatus = 'available', lastScrolledBranch, showingLoading = false;
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
        const width = Math.max(0, Math.min(720, win.innerWidth - 16));
        const below = Math.max(0, win.innerHeight - rect.bottom - 12);
        const above = Math.max(0, rect.top - 12);
        bar.style.width = `${width}px`;
        bar.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - width - 8))}px`;
        bar.style.maxHeight = `${Math.max(above, below)}px`;
        const height = bar.getBoundingClientRect().height;
        bar.style.top = `${height <= below || below >= above
            ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`;
    };

    const render = (list, featuredCount, prStatus, remoteStatus = lastRemoteStatus) => {
        const filtered = scmToolkitFilterBranchStrip(list, featuredCount, filterInput.value);
        list = filtered.branches;
        featuredCount = filtered.featuredCount;
        const previousScroll = scroll.scrollTop;
        const fragment = doc.createDocumentFragment();
        if (remoteStatus !== 'available' || prStatus !== 'available') {
            const note = doc.createElement('span');
            note.className = 'scm-toolkit-branch-strip-note';
            note.textContent = remoteStatus !== 'available'
                ? 'Remote unavailable — showing local branches only'
                : 'PR status unavailable — showing all branches';
            fragment.append(note);
        }
        list.forEach((item, index) => {
            if (index === featuredCount && featuredCount > 0 && index < list.length) {
                const separator = doc.createElement('span');
                separator.className = 'scm-toolkit-branch-strip-separator';
                separator.setAttribute('role', 'separator');
                separator.setAttribute('aria-label', 'Other branches');
                const caption = doc.createElement('span');
                caption.textContent = 'Other';
                separator.append(caption);
                fragment.append(separator);
            }
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'scm-toolkit-branch-strip-item';
            button.classList.toggle('current', item.name === branch);
            button.setAttribute('aria-current', item.name === branch ? 'true' : 'false');
            const locations = [item.local && 'local', item.origin && settings.remote]
                .filter(Boolean).join(' + ');
            const state = item.hasPr === true ? 'has a PR'
                : item.merged ? 'merged into base'
                : item.hasPr === null ? 'PR status unknown' : 'no PR, unmerged';
            button.title = `${item.name} (${locations}; ${state})`;
            button.setAttribute('aria-label', `Check out ${button.title}`);
            const icon = name => {
                const el = doc.createElement('span');
                el.className = `codicon codicon-${name}`;
                el.setAttribute('aria-hidden', 'true');
                return el;
            };
            if (item.local) button.append(icon('git-branch'));
            if (item.origin) button.append(icon('cloud'));
            const label = doc.createElement('span');
            label.className = 'scm-toolkit-branch-strip-label';
            label.textContent = item.name;
            button.append(label);
            button.disabled = pending;
            button.addEventListener('click', () => {
                if (pending || !repository) return;
                if (item.name === branch) close(true);
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
        refreshedAt = Date.now();
        refreshedRepository = key;
        try {
            const result = await commands.executeCommand('sweetiebot.listBranchStrip', uri,
                { remote: settings.remote, defaultBranch: base });
            if (disposed || !opened || request !== generation || repository !== uri || !panelMode) return;
            showingLoading = false;
            knownBranches = Array.isArray(result?.branches) ? result.branches : [];
            lastFeaturedCount = result?.featuredCount ?? 0;
            lastPrStatus = result?.prStatus;
            lastRemoteStatus = result?.remoteStatus ?? 'available';
            render(knownBranches, lastFeaturedCount, lastPrStatus);
        } catch (error) {
            if (disposed || !opened || request !== generation) return;
            showingLoading = false;
            refreshedAt = 0;
            knownBranches = [];
            render([], 0, 'unavailable', 'unavailable');
            console.warn('Sweetiebot branch strip refresh failed:', error);
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
        const panel = widget.element.closest('.part.panel');
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

    // A view can move from the panel to the sidebar without repository re-binding.
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
                showingLoading = true;
                scroll.textContent = 'Loading branches…';
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
