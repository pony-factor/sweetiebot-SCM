// A one-row branch navigator shown only when Source Control is in the bottom panel.
// The native branch picker stays available as the overflow action and elsewhere.
function scmToolkitCreateBranchStrip(widget, commands, notifications, settings, openNativePicker) {
    const doc = widget.element.ownerDocument;
    const win = doc.defaultView;
    const bar = doc.createElement('div');
    bar.className = 'scm-toolkit-branch-strip';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Git branches');
    const scroll = doc.createElement('div');
    scroll.className = 'scm-toolkit-branch-strip-scroll';
    scroll.setAttribute('aria-label', 'Branches, horizontally scrollable');
    scroll.setAttribute('tabindex', '0');
    const nativeButton = doc.createElement('button');
    nativeButton.type = 'button';
    nativeButton.className = 'scm-toolkit-branch-strip-native codicon codicon-ellipsis';
    nativeButton.title = 'Open Git branch and tag picker';
    nativeButton.setAttribute('aria-label', nativeButton.title);
    nativeButton.addEventListener('click', openNativePicker);
    bar.append(scroll, nativeButton);

    let repository, branch, base, pickerReady = false, panelMode = false, disposed = false;
    let generation = 0, refreshedAt = 0, refreshedRepository = '';
    let refreshTimer, pending = false, knownBranches = [], lastFeaturedCount = 0;
    let lastPrStatus = 'unavailable', lastScrolledBranch;

    const render = (list, featuredCount, prStatus) => {
        const previousScroll = scroll.scrollLeft;
        const fragment = doc.createDocumentFragment();
        if (prStatus !== 'available') {
            const note = doc.createElement('span');
            note.className = 'scm-toolkit-branch-strip-note';
            note.textContent = 'PR status unavailable — showing all branches';
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
                if (!pending && repository && item.name !== branch) void checkout(item.name);
            });
            fragment.append(button);
        });
        if (!list.length) {
            const label = doc.createElement('span');
            label.className = 'scm-toolkit-branch-strip-note';
            label.textContent = 'No branches found';
            fragment.append(label);
        }
        scroll.replaceChildren(fragment);
        if (lastScrolledBranch !== branch) {
            lastScrolledBranch = branch;
            scroll.querySelector('[aria-current="true"]')
                ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else {
            scroll.scrollLeft = previousScroll;
        }
    };

    const refresh = async (force = false) => {
        if (!panelMode || !repository || !base || disposed) return;
        const uri = repository;
        const key = `${uri.toString()}:${base}`;
        if (!force && key === refreshedRepository && Date.now() - refreshedAt < 20000) return;
        const request = ++generation;
        refreshedAt = Date.now();
        refreshedRepository = key;
        try {
            const result = await commands.executeCommand('sweetiebot.listBranchStrip', uri,
                { remote: settings.remote, defaultBranch: base });
            if (disposed || request !== generation || repository !== uri || !panelMode) return;
            knownBranches = Array.isArray(result?.branches) ? result.branches : [];
            lastFeaturedCount = result?.featuredCount ?? 0;
            lastPrStatus = result?.prStatus;
            render(knownBranches, lastFeaturedCount, lastPrStatus);
        } catch (error) {
            if (disposed || request !== generation) return;
            refreshedAt = 0;
            knownBranches = [];
            render([], 0, 'unavailable');
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
            void refresh(true);
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
            bar.remove();
            generation++;
            return false;
        }
        if (bar.parentElement !== view) view.prepend(bar);
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
            refreshedAt = 0;
            knownBranches = [];
            scroll.replaceChildren();
            lastScrolledBranch = undefined;
        }
        if (branchChanged && knownBranches.length) {
            render(knownBranches, lastFeaturedCount, lastPrStatus);
        }
        if (repositoryChanged || branchChanged || Date.now() - refreshedAt >= 20000) {
            void refresh();
        }
        return true;
    };

    scroll.addEventListener('wheel', event => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && scroll.scrollWidth > scroll.clientWidth) {
            scroll.scrollLeft += event.deltaY;
            event.preventDefault();
        }
    }, { passive: false });
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
    refreshTimer = win.setInterval(focus, 20000);
    return {
        update,
        get visible() { return panelMode; },
        dispose() {
            disposed = true;
            win.clearInterval(refreshTimer);
            observer.disconnect();
            win.removeEventListener('focus', focus);
            generation++;
            bar.remove();
        }
    };
}
