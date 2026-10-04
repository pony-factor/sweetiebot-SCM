function scmToolkitRemainingUsage(usage) {
    const windows = usage?.rate_limit;
    const percentages = [windows?.primary_window, windows?.secondary_window]
        .filter(bucket => bucket && [300, 10080].includes(bucket.limit_window_seconds / 60))
        .map(bucket => bucket.used_percent)
        .filter(Number.isFinite)
        .map(used => Math.max(0, Math.min(100, 100 - used)));
    return percentages.length ? Math.round(Math.min(...percentages)) : null;
}

(() => {
    const tag = 'scm-toolkit-menu-reset';
    if (customElements.get(tag)) return;
    customElements.define(tag, class extends HTMLElement {
        static get observedAttributes() { return ['reset-at', 'window-minutes']; }
        connectedCallback() {
            this.style.display = 'inline-flex';
            this.style.alignItems = 'center';
            this.style.justifyContent = 'center';
            this.update();
            this.timer = setInterval(() => this.update(), 1000);
        }
        disconnectedCallback() { clearInterval(this.timer); }
        attributeChangedCallback() { this.update(); }
        update() {
            const raw = this.getAttribute('reset-at');
            const reset = Number(raw);
            if (raw == null || !Number.isFinite(reset)) {
                this.textContent = '';
                return;
            }
            const remaining = Math.max(0, reset * 1000 - Date.now());
            if (Number(this.getAttribute('window-minutes')) >= 10080) {
                const days = Math.ceil(remaining / 86400000);
                this.textContent = `${days} ${days === 1 ? 'day' : 'days'} left`;
            } else {
                const minutes = Math.ceil(remaining / 60000);
                this.textContent = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
            }
        }
    });
})();
