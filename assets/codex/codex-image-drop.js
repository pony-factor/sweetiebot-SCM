// Capture external file drops across the VS Code webview, using native upload handlers.
function scmToolkitRegisterImageDropTarget(root, enter, leave, drop) {
    const key = '__scmToolkitImageDropTargets';
    let state = globalThis[key];
    if (!state) {
        const targets = new Set();
        const body = document.body;
        // Capture before history rows and their hover cards can intercept the drag.
        const surface = window;
        let active;
        let interaction = 0;
        const select = event => {
            const entries = [...targets].reverse().filter(entry => !entry.root
                || (entry.root.isConnected !== false && entry.root.getClientRects().length));
            return entries.find(entry => entry.root?.contains(event.target)
                && entry.root.getClientRects().length)
                ?? entries.find(entry => entry.root)
                ?? entries.find(entry => !entry.root);
        };
        const hasFiles = event => {
            const transfer = event.dataTransfer;
            return transfer && (Array.from(transfer.types || []).includes('Files')
                || transfer.files?.length
                || Array.from(transfer.items || []).some(item => item.kind === 'file'));
        };
        const reportFailure = () => {
            let notice = document.getElementById('scm-toolkit-image-drop-status');
            if (!notice) {
                notice = document.createElement('div');
                notice.id = 'scm-toolkit-image-drop-status';
                notice.setAttribute('role', 'status');
                notice.style.cssText = 'position:fixed;bottom:72px;left:12px;right:12px;z-index:2147483647;padding:12px;border:1px solid var(--vscode-widget-border,#888);border-radius:6px;background:var(--vscode-editorWidget-background,#222);color:var(--vscode-editorWidget-foreground,#fff);font:inherit;cursor:pointer';
                notice.title = 'Click to dismiss';
                notice.addEventListener('click', () => notice.remove());
                body.appendChild(notice);
            }
            notice.textContent = 'The screenshot could not be attached. Save it first, then drag the saved image here.';
        };
        const snapshotDrop = transfer => {
            // Read the drag store synchronously: Chromium protects it once drop returns.
            const items = Array.from(transfer.items || []).map(item => {
                const file = item.kind === 'file' ? item.getAsFile() : null;
                const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
                return { kind: item.kind, type: item.type, file, entry };
            });
            const files = Array.from(transfer.files || []);
            for (const file of files) {
                if (!items.some(item => item.file === file)) {
                    items.push({ kind: 'file', type: file.type, file, entry: null });
                }
            }
            const types = Array.from(transfer.types || []);
            const strings = new Map(types.filter(type => type !== 'Files')
                .map(type => [type, transfer.getData(type)]));
            const pending = items.filter(item => item.kind === 'file' && !item.entry?.isDirectory
                && (!item.file || item.file.size === 0)
                && (item.type?.startsWith('image/')
                    || /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(item.file?.name || item.entry?.name || '')));
            return { items, files, types, strings, pending };
        };
        const recoverImage = async item => {
            // A floating macOS screenshot may initially be a zero-byte promised file.
            // Request a fresh File from the captured entry rather than reusing its size.
            if (!item.entry?.isFile) return null;
            const deadline = Date.now() + 2500;
            while (Date.now() < deadline) {
                const file = await new Promise(resolve => {
                    const timeout = setTimeout(() => resolve(null), 200);
                    const finish = file => { clearTimeout(timeout); resolve(file); };
                    try { item.entry.file(finish, () => finish(null)); }
                    catch { finish(null); }
                });
                if (file?.size > 0) return file;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return null;
        };
        const enterTarget = event => {
            if (!hasFiles(event)) return;
            const entry = select(event);
            if (active && active !== entry) active.leave(event);
            const firstEnter = active !== entry;
            active = entry;
            // The native counter must count entry to the pane, not each child.
            const forwarded = new Proxy(event, {
                get(target, property) {
                    if (property === 'type') return firstEnter ? 'dragenter' : 'dragover';
                    // Native overlay rendering follows currentTarget. Use the whole
                    // webview even when the composer portal covers only the prompt.
                    if (property === 'currentTarget') return body;
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
            entry?.enter(forwarded);
            if (event.defaultPrevented) event.stopPropagation();
        };
        const handlers = {
            dragenter: enterTarget,
            dragover: enterTarget,
            dragleave(event) {
                if (!hasFiles(event)) return;
                // This capture listener owns the native counter. Letting an ignored
                // child leave reach React hides its overlay without clearing active.
                event.stopPropagation();
                // Moving across children is still inside the drop target.
                if (event.relatedTarget && body.contains(event.relatedTarget)) return;
                // Chromium can omit relatedTarget when crossing webview children.
                // A leave from the document boundary must still clear active even
                // when hit testing returns the last element inside the webview.
                const boundary = event.target === body || event.target === document.documentElement
                    || event.target === document || event.target === window;
                if (!boundary && !event.relatedTarget && event.clientX > 0 && event.clientY > 0
                    && body.contains(document.elementFromPoint?.(event.clientX, event.clientY))) return;
                active?.leave(event);
                active = undefined;
            },
            drop(event) {
                if (!hasFiles(event)) return;
                const entry = select(event);
                const snapshot = snapshotDrop(event.dataTransfer);
                if (entry && snapshot.pending.length) {
                    const originalInteraction = interaction;
                    const originalLocation = window.location?.href;
                    // Accept now, before awaiting the file promise, and keep the original
                    // composer. A later chat switch must not receive the attachment.
                    event.preventDefault();
                    event.stopPropagation();
                    entry.leave(event);
                    const finish = async () => {
                        const recovered = await Promise.all(snapshot.pending.map(recoverImage));
                        if (!targets.has(entry) || entry.root?.isConnected === false
                            || (entry.root && !entry.root.getClientRects().length)
                            || interaction !== originalInteraction
                            || window.location?.href !== originalLocation) {
                            reportFailure();
                            return;
                        }
                        const replacements = new Map(snapshot.pending.map((item, index) => [item, recovered[index]]));
                        const byFile = new Map(snapshot.pending.filter(item => item.file)
                            .map(item => [item.file, replacements.get(item)]));
                        const files = snapshot.files.map(file => byFile.has(file)
                            ? byFile.get(file) : file).filter(Boolean);
                        for (const file of recovered.filter(Boolean)) if (!files.includes(file)) files.push(file);
                        const items = snapshot.items.map(item => ({
                            kind: item.kind, type: item.type,
                            getAsFile: () => replacements.has(item) ? replacements.get(item) : item.file,
                            webkitGetAsEntry: () => item.entry,
                        }));
                        const transfer = { files, items, types: snapshot.types,
                            getData: type => snapshot.strings.get(type) || '' };
                        const forwarded = new Proxy(event, {
                            get(target, property) {
                                if (property === 'dataTransfer') return transfer;
                                const value = Reflect.get(target, property, target);
                                return typeof value === 'function' ? value.bind(target) : value;
                            },
                        });
                        if (files.length) entry.drop(forwarded);
                        if (recovered.some(file => !file)) reportFailure();
                    };
                    void finish().catch(reportFailure);
                } else {
                    entry?.drop(event);
                }
                active = undefined;
                if (event.defaultPrevented) event.stopPropagation();
            },
            dragend(event) {
                active?.leave(event);
                active = undefined;
            },
            // React can retain the same composer and replace its callbacks on chat
            // navigation. Cancel deferred drops after subsequent user interaction.
            pointerdown() { interaction++; },
            keydown() { interaction++; },
        };
        for (const [type, handler] of Object.entries(handlers)) {
            surface.addEventListener(type, handler, true);
        }
        state = globalThis[key] = { targets, surface, handlers, release(entry) {
            if (active === entry) {
                entry.leave({ type: 'dragleave' });
                active = undefined;
            }
        } };
    }
    const entry = { root, enter, leave, drop };
    state.targets.add(entry);
    return () => {
        state.release(entry);
        state.targets.delete(entry);
        if (state.targets.size) return;
        for (const [type, handler] of Object.entries(state.handlers)) {
            state.surface.removeEventListener(type, handler, true);
        }
        delete globalThis[key];
    };
}
