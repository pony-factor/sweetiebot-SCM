function scmToolkitRemainingUsage(usage) {
    const windows = usage?.rate_limit;
    const bucket = [windows?.primary_window, windows?.secondary_window]
        .find(bucket => bucket?.limit_window_seconds === 300 * 60
            && Number.isFinite(bucket.used_percent));
    return bucket ? Math.round(Math.max(0, Math.min(100, 100 - bucket.used_percent))) : null;
}

function scmToolkitUsagePiePercent(value) {
    const percent = Number(value);
    if (!Number.isFinite(percent)) return null;
    return Math.round(Math.max(0, Math.min(100, percent)));
}

function scmToolkitRelativeUsageReset(resetAt, windowMinutes, now = Date.now()) {
    const reset = Number(resetAt);
    const current = Number(now);
    if (!Number.isFinite(reset) || !Number.isFinite(current)) return '';

    const remaining = Math.max(0, reset * 1000 - current);
    if (Number(windowMinutes) >= 10080) {
        const days = Math.ceil(remaining / 86400000);
        return `${days} ${days === 1 ? 'day' : 'days'}`;
    }

    const minutes = Math.ceil(remaining / 60000);
    if (minutes === 1) return '1m';
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function scmToolkitRelativeUsageResetLabel(text, now = Date.now()) {
    const match = String(text || '').trim().match(/^Resets\s+(.+)$/i);
    if (!match || /^in\b/i.test(match[1])) return null;

    const current = new Date(now);
    if (!Number.isFinite(current.getTime())) return null;

    const time = match[1].match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
    if (time) {
        const clockHour = Number(time[1]);
        const minute = Number(time[2]);
        if (clockHour < 1 || clockHour > 12 || minute < 0 || minute > 59) return null;

        let hour = clockHour % 12;
        if (time[3].toUpperCase() === 'PM') hour += 12;
        const reset = new Date(current);
        reset.setHours(hour, minute, 0, 0);
        if (reset.getTime() <= current.getTime()) reset.setDate(reset.getDate() + 1);
        return `Resets in ${scmToolkitRelativeUsageReset(reset.getTime() / 1000, 300, now)}`;
    }

    const date = match[1].match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
    if (!date) return null;
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
        'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(date[1].slice(0, 3).toLowerCase());
    const day = Number(date[2]);
    if (month < 0 || day < 1 || day > 31) return null;

    let year = date[3] ? Number(date[3]) : current.getFullYear();
    let target = new Date(year, month, day);
    if (target.getMonth() !== month || target.getDate() !== day) return null;

    const todayUtc = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate());
    let targetUtc = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
    if (!date[3] && targetUtc < todayUtc) {
        year += 1;
        target = new Date(year, month, day);
        targetUtc = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
    }
    const days = Math.max(0, Math.round((targetUtc - todayUtc) / 86400000));
    if (days === 0) return 'Resets today';
    return `Resets in ${days} ${days === 1 ? 'day' : 'days'}`;
}

function scmToolkitCorrectLastMinuteUsageLabels(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    for (const element of root.querySelectorAll('*')) {
        if (Array.from(element.children || []).length) continue;
        const current = String(element.textContent || '');
        if (!/\bin 0m\b/i.test(current)) continue;
        if (!/(?:rate limit|usage limit|try again)/i.test(current)) continue;
        const corrected = current.replace(/\bin 0m\b/gi, 'in 1m');
        if (corrected !== current) element.textContent = corrected;
    }
}

function scmToolkitApplyUsageDialogRelativeTimes(root, now = Date.now()) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const hideResetTimes =
        typeof scmToolkitHideUsageResetTimes !== 'undefined'
        && scmToolkitHideUsageResetTimes;
    const countdownEnabled =
        typeof scmToolkitUsageResetCountdown === 'undefined'
        || scmToolkitUsageResetCountdown;
    if (!countdownEnabled && !hideResetTimes) return;
    for (const dialog of root.querySelectorAll('[role="dialog"]')) {
        const dialogText = String(dialog.textContent || '');
        if (!/5 hour usage limit/i.test(dialogText) || !/Weekly usage limit/i.test(dialogText)) continue;

        const elements = Array.from(dialog.querySelectorAll('*'));
        for (const element of elements) {
            const current = String(element.textContent || '').trim();
            const absolute = /^Resets\s+(?!in\b|today\b)/i.test(current) ? current : null;
            if (absolute) element.scmToolkitUsageResetSource = absolute;

            const source = element.scmToolkitUsageResetSource;
            if (!source) continue;

            if (hideResetTimes) {
                if (current !== '') element.textContent = '';
                continue;
            }

            const childOwnsReset = Array.from(element.children || []).some(child => {
                const childText = String(child.textContent || '').trim();
                return child.scmToolkitUsageResetSource
                    || /^Resets\s+(?!in\b|today\b)/i.test(childText);
            });
            if (childOwnsReset) continue;

            const relative = scmToolkitRelativeUsageResetLabel(source, now);
            if (relative && current !== relative) element.textContent = relative;
        }
    }
}

let scmToolkitUsageRefetch = null;
let scmToolkitUsageRefreshTimer = null;

function scmToolkitKeepUsageFresh(refetch) {
    if (typeof refetch !== 'function') return;
    scmToolkitUsageRefetch = refetch;
    if (scmToolkitUsageRefreshTimer !== null) return;

    const refresh = () => {
        const current = scmToolkitUsageRefetch;
        if (typeof current !== 'function') return;
        try {
            const result = current();
            if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch {}
    };

    scmToolkitUsageRefreshTimer = setInterval(refresh, 15000);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('focus', refresh);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refresh();
        });
    }
}

(() => {
    const tag = 'scm-toolkit-usage-pie';
    if (customElements.get(tag)) return;
    customElements.define(tag, class extends HTMLElement {
        static get observedAttributes() { return ['percent']; }
        connectedCallback() {
            this.style.display = 'inline-block';
            this.style.width = '12px';
            this.style.height = '12px';
            this.style.flex = 'none';
            this.style.borderRadius = '50%';
            this.style.verticalAlign = '-1px';
            this.update();
        }
        attributeChangedCallback() { this.update(); }
        update() {
            const percent = scmToolkitUsagePiePercent(this.getAttribute('percent'));
            if (percent == null) {
                this.style.background = 'transparent';
                this.removeAttribute('role');
                this.removeAttribute('aria-label');
                this.removeAttribute('title');
                return;
            }
            const degrees = (100 - percent) * 3.6;
            this.style.background =
                `conic-gradient(from 0deg, color-mix(in srgb, currentColor 20%, transparent) 0 ${degrees}deg, currentColor ${degrees}deg 360deg)`;
            const label = `${percent}% Codex usage remaining`;
            this.setAttribute('role', 'img');
            this.setAttribute('aria-label', label);
            this.setAttribute('title', label);
        }
    });
})();

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
            const windowMinutes = Number(this.getAttribute('window-minutes'));
            const relative = scmToolkitRelativeUsageReset(reset, windowMinutes);
            this.textContent = windowMinutes >= 10080 && relative ? `${relative} left` : relative;
        }
    });
})();

(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;

    const refresh = () => {
        scmToolkitApplyUsageDialogRelativeTimes(document);
        scmToolkitCorrectLastMinuteUsageLabels(document);
    };
    const observer = new MutationObserver(refresh);
    observer.observe(document, { childList: true, characterData: true, subtree: true });
    refresh();
    setInterval(refresh, 30000);
})();
