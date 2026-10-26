// Native queue transactions keep attachments, neighboring IDs, and dispatch ownership.
(() => {
    'use strict';
    const PREFIX = 'sweetiebot.codex.queued-edit.';
    class QueueEdit {
        constructor(adapter, id, storage, notify = () => {}) {
            this.adapter = adapter;
            this.id = id;
            this.storage = storage;
            this.notify = notify;
            this.key = PREFIX + JSON.stringify([adapter.hostId, adapter.threadId, id]);
            this.phase = 'idle';
            this.text = '';
        }
        persist() {
            this.storage.setItem(this.key, JSON.stringify({
                hostId: this.adapter.hostId, threadId: this.adapter.threadId,
                messageId: this.id, text: this.text, receipt: this.receipt ?? null,
                original: this.original, owner: this.owner,
            }));
        }
        emit() { this.notify(this); }
        async hold() {
            const coordinator = await this.adapter.coordinator();
            if (typeof coordinator?.deferAutomaticTurns !== 'function') throw Error('Queue editing is unavailable in this Codex version.');
            this.lease = await coordinator.deferAutomaticTurns(this.adapter.threadId);
            if (typeof this.lease?.[Symbol.dispose] !== 'function' && typeof this.lease?.dispose !== 'function') {
                throw Error('The queue pause could not be confirmed.');
            }
        }
        release() {
            const lease = this.lease;
            this.lease = null;
            try { (lease?.[Symbol.dispose] ?? lease?.dispose)?.call(lease); } catch {}
        }
        async begin(recovery = null) {
            if (this.phase !== 'idle') return;
            this.phase = 'opening';
            this.emit();
            try {
                const current = this.adapter.actions.get(this.id);
                if (recovery?.receipt && !current) {
                    this.receipt = recovery.receipt;
                    this.original = recovery.original ?? recovery.receipt.message;
                    this.text = recovery.text;
                    this.persist();
                    await this.hold();
                } else {
                    if (!current || typeof current.text !== 'string'
                        || (current.submission && current.submission.status !== 'queued')) {
                        throw Error('This message is no longer available for editing.');
                    }
                    this.original = current;
                    this.text = recovery?.text ?? current.text;
                    // Refuse to remove the native item unless recovery can be saved.
                    this.persist();
                    await this.hold();
                    this.receipt = await this.adapter.actions.beginEdit(this.id);
                    if (!this.receipt) throw Error('This message has already left the queue.');
                    if (!recovery) { this.original = this.receipt.message; this.text = this.receipt.message.text; }
                    this.persist();
                }
                if (this.receipt.canRestore === false) { this.release(); throw Error('Codex cannot safely restore this message. Your saved text is retained.'); }
                this.phase = 'editing';
            } catch (error) {
                this.error = error.message;
                this.phase = 'error';
                if (!this.receipt) {
                    this.release();
                    if (!recovery) { try { this.storage.removeItem(this.key); } catch {} }
                }
            }
            this.emit();
        }
        checkOwnership() {
            const saved = this.storage.getItem(this.key);
            const record = saved ? JSON.parse(saved) : null;
            if (this.owner && record?.owner && record.owner !== this.owner) {
                this.moved = true;
                this.phase = 'error';
                this.error = 'This edit was resumed in another window. Your local text remains available.';
                this.release();
                this.emit();
                return false;
            }
            return true;
        }
        update(text) {
            this.text = text;
            try { if (!this.checkOwnership()) return; this.persist(); this.error = ''; }
            catch { this.error = 'Recovery could not be updated. Save this edit before closing the window.'; }
            this.emit();
        }
        finish(cancel = false) {
            if (this.inFlight) return this.inFlight;
            if (!this.checkOwnership() || this.moved) {
                if (cancel) { this.phase = 'closed'; this.emit(); }
                return Promise.resolve(false);
            }
            if (!this.receipt) {
                if (cancel) { this.phase = 'closed'; this.emit(); return Promise.resolve(true); }
                return Promise.resolve(false);
            }
            if (this.receipt.canRestore === false) return Promise.resolve(false);
            this.phase = 'saving';
            this.error = '';
            this.emit();
            this.inFlight = Promise.resolve().then(async () => {
                try {
                    // Never rebuild context or move the item to the end of the queue.
                    const receipt = {...this.receipt, message: {...this.receipt.message,
                        text: cancel ? this.original.text : this.text}};
                    if (cancel || this.text === this.original.text) {
                        await this.adapter.actions.restoreEdit(receipt);
                    } else {
                        // Restore is native Undo: server queues deliberately reuse
                        // its old serialized input. Edited text must use native Send
                        // with edit-position metadata, just like Codex's own editor.
                        const context = receipt.message.context;
                        const editPosition = {
                            messageId:this.receipt.message.id,
                            previousMessageId:this.receipt.previousMessageId,
                            nextMessageId:this.receipt.nextMessageId,
                            serverSubmission:this.receipt.serverSubmission,
                            preserveSerializedContext:this.receipt.preserveSerializedContext,
                            multiUserMessageSender:this.receipt.message.multiUserMessageSender ?? null,
                            isImageEditFollowUp:context.isImageEditFollowUp,
                            turnTrigger:context.turnTrigger,
                            restoredPromptContext:context.restoredPromptContext,
                        };
                        const result = await this.adapter.actions.send(receipt.message, {
                            acceptLocally:true, queueModeOverride:'queue', editPosition,
                        });
                        if (!['queued','sent'].includes(result?.status)) throw Error('Queue edit was not accepted.');
                    }
                    try { this.storage.removeItem(this.key); } catch {}
                    this.phase = 'closed';
                    this.release();
                    this.emit();
                    return true;
                } catch {
                    this.error = 'Could not save to the queue. Your edit is retained and the queue is still paused. Retry Save or Cancel.';
                    this.phase = 'error';
                    this.emit();
                    return false;
                } finally { this.inFlight = null; }
            });
            return this.inFlight;
        }
    }
    if (globalThis.__SCM_TOOLKIT_QUEUE_EDIT_TEST__) {
        Object.assign(globalThis.__SCM_TOOLKIT_QUEUE_EDIT_TEST__, {QueueEdit, PREFIX});
        return;
    }
    if (globalThis.scmToolkitQueuedEditUi) return;
    globalThis.scmToolkitQueuedEditUi = true;
    const sessions = new Map();
    const storage = localStorage;
    const OWNER_KEY = PREFIX + 'owner';
    let owner = sessionStorage.getItem(OWNER_KEY);
    if (!owner) { owner = crypto.randomUUID(); sessionStorage.setItem(OWNER_KEY, owner); }
    const style = document.createElement('style');
    style.textContent = `
      :root[data-codex-window-type="extension"] [data-composer-rail][data-composer-rail-placement="above"] {
        --composer-rail-tuck:0px; --composer-rail-overlap:0px;
        margin-bottom:8px !important; padding-bottom:0 !important;
        border:1px solid color-mix(in srgb,var(--vscode-foreground,#888) 22%,transparent);
        border-radius:8px !important; corner-shape:round !important;
        background:var(--vscode-input-background,var(--color-surface-primary));
        color:var(--vscode-input-foreground,var(--vscode-foreground));
      }
      :root[data-codex-window-type="extension"] [data-composer-rail][data-composer-rail-placement="above"]::after { display:none; }
      :root[data-codex-window-type="extension"] [data-composer-rail][data-composer-rail-placement="above"] [data-composer-rail-item] {
        margin-bottom:0 !important; padding-bottom:0 !important;
        background:transparent !important; border-color:var(--vscode-widget-border,transparent) !important;
        color:inherit !important;
      }
      :root[data-codex-window-type="extension"] [data-composer-rail] button:not(.scm-toolkit-queue-save):not(.scm-toolkit-queue-cancel) {
        color:var(--scm-toolkit-queue-accent,var(--color-codex-drop-overlay,var(--vscode-focusBorder))) !important;
      }
      :root[data-codex-window-type="extension"] [data-scm-toolkit-queue-preview] :is(.text-secondary,.text-codex-description) { color:var(--vscode-input-foreground,var(--vscode-foreground)) !important; }
      [data-scm-toolkit-queue-preview] { cursor:text; }
      .scm-toolkit-queue-editor { min-width:0; padding:8px; border:1px solid var(--vscode-focusBorder,#888); border-radius:8px; background:var(--vscode-input-background); margin:4px 0; }
      .scm-toolkit-queue-editor textarea { display:block; box-sizing:border-box; width:100%; min-height:72px; max-height:none; overflow-y:hidden; resize:vertical; border:0; outline:0; background:transparent; color:inherit; font:inherit; line-height:1.5; white-space:pre-wrap; }
      .scm-toolkit-queue-editor footer { display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-size:12px; }
      .scm-toolkit-queue-editor [role=status] { flex:1 1 100%; opacity:.8; }
      .scm-toolkit-queue-editor button { border:0; border-radius:4px; padding:3px 8px; background:var(--vscode-button-secondaryBackground); color:inherit; cursor:pointer; }
      .scm-toolkit-queue-editor .scm-toolkit-queue-save { margin-inline-start:auto; }
      .scm-toolkit-queue-editor .scm-toolkit-queue-cancel { width:24px; height:24px; padding:0; background:transparent; color:var(--vscode-descriptionForeground,inherit); font-size:18px; line-height:1; }
      .scm-toolkit-queue-editor .scm-toolkit-queue-cancel:hover { background:var(--vscode-toolbar-hoverBackground,rgba(127,127,127,.15)); color:var(--vscode-foreground,inherit); }
      .scm-toolkit-queue-editor .scm-toolkit-queue-cancel:focus-visible { outline:1px solid var(--vscode-focusBorder,#888); outline-offset:1px; }
    `;
    document.head.append(style);
    const autoSize = field => { field.style.height = 'auto'; field.style.height = Math.max(72, field.scrollHeight) + 'px'; };
    function adapterFor(row) {
        const id = row.dataset.scmToolkitQueueId;
        const host = row.dataset.scmToolkitQueueHost;
        const matches = [...(globalThis.scmToolkitQueuedEditStores?.values() ?? [])].filter(a =>
            String(a.hostId) === host && a.actions.get(id));
        return matches.length === 1 ? matches[0] : null;
    }
    function stableHost(row) {
        let child = row;
        for (let parent = row.parentElement; parent && parent !== document.body; child = parent, parent = parent.parentElement) {
            if (parent.querySelector('[data-composer-body]')) return {host:parent, before:child};
        }
        return null;
    }
    function mount(adapter, id, anchor, recovery = null) {
        const sessionKey = JSON.stringify([adapter.hostId, adapter.threadId, id]);
        if (sessions.has(sessionKey)) { sessions.get(sessionKey).field.focus(); return; }
        const box = document.createElement('div');
        box.className = 'scm-toolkit-queue-editor';
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', 'Edit queued message');
        const field = document.createElement('textarea');
        field.setAttribute('aria-label', 'Queued message text');
        field.spellcheck = true;
        const footer = document.createElement('footer');
        const status = document.createElement('span');
        status.setAttribute('role', 'status');
        const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save';
        save.className = 'scm-toolkit-queue-save';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '×';
        cancel.className = 'scm-toolkit-queue-cancel';
        cancel.setAttribute('aria-label', 'Cancel edit'); cancel.title = 'Cancel edit';
        footer.append(status, cancel, save); box.append(field, footer);
        let focused = false;
        const edit = new QueueEdit(adapter, id, storage, state => {
            if (state.phase === 'closed') { box.remove(); sessions.delete(sessionKey); return; }
            field.readOnly = state.moved || state.receipt?.canRestore === false;
            field.disabled = state.phase === 'opening' || state.phase === 'saving' || !state.receipt;
            save.disabled = state.moved || field.disabled || state.receipt?.canRestore === false;
            cancel.disabled = state.phase === 'opening' || state.phase === 'saving' || state.receipt?.canRestore === false;
            status.textContent = state.error || (state.phase === 'saving' ? 'Saving…' : state.phase === 'opening' ? 'Pausing queue…' : 'Queue paused while you edit. Leaving the editor saves your changes.');
            if (document.activeElement !== field) field.value = state.text;
            autoSize(field);
            if (state.phase === 'editing' && !focused && field.isConnected) { focused = true; field.focus(); }
        });
        edit.owner = owner;
        sessions.set(sessionKey, {edit, box, field, anchor, focus() {
            if (edit.phase === 'editing' && field.isConnected) { focused = true; field.focus(); }
        }});
        anchor.parent.insertBefore(box, anchor.before?.parentElement === anchor.parent ? anchor.before : null);
        field.addEventListener('input', () => { edit.update(field.value); autoSize(field); });
        field.addEventListener('keydown', event => {
            if (event.isComposing) return;
            if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
                event.preventDefault(); event.stopPropagation(); void edit.finish(event.key === 'Escape');
            }
        });
        save.addEventListener('click', () => void edit.finish());
        cancel.addEventListener('click', () => void edit.finish(true));
        box.addEventListener('focusout', () => setTimeout(() => {
            if (!box.contains(document.activeElement) && edit.phase === 'editing') void edit.finish();
        }, 0));
        void edit.begin(recovery);
    }
    document.addEventListener('click', event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const preview = event.target.closest?.('[data-scm-toolkit-queue-preview]');
        const row = preview?.closest('[data-scm-toolkit-queue-id]');
        if (!row) return;
        const adapter = adapterFor(row), fallback = stableHost(row);
        if (!adapter || !fallback) return;
        event.preventDefault(); event.stopImmediatePropagation();
        mount(adapter, row.dataset.scmToolkitQueueId, {
            parent:row.parentElement, before:row.nextSibling, fallback,
        });
    }, true);
    document.addEventListener('keydown', event => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[data-scm-toolkit-queue-preview]')) {
            event.preventDefault(); event.target.click();
        }
    }, true);
    function maintain() {
        for (const button of document.querySelectorAll('[data-composer-rail] button')) {
            if (button.textContent.trim() !== 'View changes') continue;
            const text = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            while (text.nextNode()) {
                if (text.currentNode.nodeValue.includes('View changes')) {
                    text.currentNode.nodeValue = text.currentNode.nodeValue.replace('View changes', 'Changes');
                }
            }
            if (button.getAttribute('aria-label') === 'View changes') button.setAttribute('aria-label', 'Changes');
        }
        for (const {edit, box, anchor, focus} of sessions.values()) {
            if (box.isConnected) continue;
            if (anchor.fallback.host.isConnected) {
                const {host, before} = anchor.fallback;
                host.insertBefore(box, before?.parentElement === host ? before : null);
                focus();
            } else if (edit.phase === 'editing') void edit.finish();
        }
    }
    new MutationObserver(() => { try { maintain(); } catch {} }).observe(document.documentElement, {childList:true, subtree:true});
    maintain();
    window.addEventListener('storage', event => {
        for (const {edit} of sessions.values()) if (event.key === edit.key) {
            try { edit.checkOwnership(); } catch {}
        }
    });
    const offered = new Set();
    function recover(adapter) {
        const host = document.querySelector('[data-composer-surface-variant]');
        if (!host || !adapter) return;
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key?.startsWith(PREFIX)) continue;
            let entry;
            try { entry = JSON.parse(storage.getItem(key)); } catch { continue; }
            if (!entry?.original || entry.threadId !== adapter.threadId || entry.hostId !== adapter.hostId) continue;
            const sessionKey = JSON.stringify([adapter.hostId, adapter.threadId, entry.messageId]);
            if (sessions.has(sessionKey) || offered.has(key)) continue;
            offered.add(key);
            if (!entry.receipt || entry.receipt.canRestore === false) {
                const button = document.createElement('button'); button.type = 'button';
                button.textContent = 'Show interrupted queued-message edit';
                button.addEventListener('click', () => {
                    const box = document.createElement('div'); box.className = 'scm-toolkit-queue-editor';
                    const note = document.createElement('p'); note.textContent = 'Queue status could not be confirmed. This saved text is retained for manual recovery.';
                    const field = document.createElement('textarea'); field.readOnly = true; field.value = entry.text; field.setAttribute('aria-label','Saved queued message');
                    box.append(note, field); button.replaceWith(box); autoSize(field);
                });
                host.prepend(button); continue;
            }
            const existing = adapter.actions.get(entry.receipt.message.id);
            if (existing?.text === entry.text) { storage.removeItem(key); continue; }
            const anchor = {parent:host, before:host.firstChild, fallback:{host,before:host.firstChild}};
            if (entry.owner === owner) mount(adapter, entry.messageId, anchor, entry);
            else {
                const button = document.createElement('button'); button.type = 'button';
                button.textContent = 'Resume saved queued-message edit';
                button.addEventListener('click', () => { button.remove(); mount(adapter, entry.messageId, anchor, entry); });
                host.prepend(button);
            }
        }
    }
    window.addEventListener('scm-toolkit-queue-store', event => {
        try { recover(event.detail); } catch {}
    });
    try { recover(globalThis.scmToolkitQueuedEditCurrent); } catch {}
})();
