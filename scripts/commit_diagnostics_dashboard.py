"""Safe, read-only Sweetiebot activity snapshot for the local Settings page."""
from __future__ import annotations

from collections import Counter
import json
import os
from pathlib import Path

from sweetiebot_diagnostics import log_path

MARKER = "sweetiebot-background-commit.json"
MAX_FILE_BYTES = 2 * 1024 * 1024


def _json(path):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None


def _active_jobs():
    home = Path(os.environ.get(
        "SWEETIEBOT_COMMIT_JOBS",
        "~/Library/Application Support/Sweetiebot/commit-jobs")).expanduser()
    jobs, known_queues = [], {}
    for path in sorted(home.glob("*/job.json"))[:500]:
        if path.parent.is_symlink():
            continue
        job = _json(path)
        if not isinstance(job, dict):
            continue
        gitdir, job_id = job.get("gitdir"), job.get("id")
        if not isinstance(gitdir, str) or not isinstance(job_id, str):
            continue
        if gitdir not in known_queues:
            marker = _json(Path(gitdir) / MARKER)
            entries = marker.get("jobs", [marker]) if isinstance(marker, dict) else []
            known_queues[gitdir] = {
                item["id"] for item in entries
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            } if isinstance(entries, list) else set()
        if job_id not in known_queues[gitdir] or job.get("phase") in ("done", "cancelled"):
            continue
        if not isinstance(job.get("root"), str) or not isinstance(job.get("branch"), str):
            continue
        error = job.get("error")
        jobs.append({
            "id": job_id[:32], "repository": Path(job["root"]).name[:100],
            "branch": job["branch"].removeprefix("rextension/heads/")[:120],
            "phase": str(job.get("phase", "unknown"))[:30],
            "error": error[:300] if isinstance(error, str) else "",
        })
    return sorted(jobs, key=lambda j: (j["repository"].lower(), j["branch"], j["id"]))


def _events():
    path = log_path()
    result = []
    for candidate in [path, *(Path(str(path) + f".{i}") for i in range(1, 4))]:
        try:
            if candidate.is_symlink() or not candidate.is_file() or candidate.stat().st_size > MAX_FILE_BYTES:
                continue
            lines = candidate.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError):
            continue
        for line in lines:
            try:
                item = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(item, dict):
                continue
            event = {
                key: (value[:240 if key in {'title', 'explanation'} else 120] if isinstance(value, str) else value)
                for key in ("timestamp", "component", "event", "model", "reason",
                            "outcome", "error_type", "http_status", "attempt",
                            "attempts", "duration_ms", "title", "rule", "explanation")
                if isinstance((value := item.get(key)), (str, int)) and not isinstance(value, bool)
            }
            if event.get("timestamp") and event.get("event"):
                result.append(event)
    return sorted(result, key=lambda e: e["timestamp"], reverse=True)


def read_diagnostics():
    """Never expose messages, prompts, diffs, or raw job journal contents."""
    jobs, events = _active_jobs(), _events()
    counts = Counter(event["event"] for event in events)
    durations = [e["duration_ms"] for e in events
                 if e["event"] == "generation_completed"
                 and isinstance(e.get("duration_ms"), int)
                 and 0 <= e["duration_ms"] <= 3600000]
    return {
        "jobs": jobs,
        "events": events[:60],
        "summary": {
            "pending": len(jobs),
            "generating": sum(j["phase"] == "generating" for j in jobs),
            "blocked": sum(j["phase"] == "blocked" for j in jobs),
            "retries": sum(e.get("outcome") == "retry" for e in events),
            "fallbacks": counts["fallback_used"] + counts["async_fallback"],
            "generated": counts["generation_completed"],
            "averageGenerationMs": round(sum(durations) / len(durations)) if durations else None,
            "eventsRetained": len(events),
        },
    }


DIAGNOSTICS_STYLE = """
.diagnostics-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:12px 0 16px}
.diagnostics-toolbar small{margin-right:auto;max-width:390px}
.diagnostics-toolbar label{display:flex;align-items:center;gap:6px;color:var(--muted)}
.diagnostics-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:10px}
.diagnostics-stat{padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px}
.diagnostics-stat strong{font-size:23px;font-variant-numeric:tabular-nums}
.diagnostics h3{font-size:14px;margin:22px 0 8px}
.diagnostics-scroll{overflow:auto;max-width:100%;border:1px solid var(--line);border-radius:8px}
.diagnostics-table{width:100%;min-width:700px;border-collapse:collapse;text-align:left}
.diagnostics-table th,.diagnostics-table td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.diagnostics-table th{color:var(--muted);font-size:12px}
.diagnostics-table tr:last-child td{border-bottom:0}
.diagnostics-error{display:block;color:#ffb3ad;font-size:12px;margin-top:4px}
.diagnostics-phase[data-phase="blocked"]{color:#ffb3ad}
.diagnostics-phase[data-phase="generating"]{color:#7ee787}
.diagnostics-explanation{margin-top:6px;font-size:12px;max-width:440px}\n.diagnostics-explanation summary{cursor:pointer;color:var(--accent)}\n.diagnostics-explanation p{margin:5px 0 0;color:var(--muted);line-height:1.4}\n#diagnostics-status{color:var(--muted);font-size:12px;min-height:18px}
"""

DIAGNOSTICS_PANEL = """
<div class="diagnostics" id="diagnostics-dashboard">
<p class="status">Live background commit queues across repositories and retained Ollama failure/performance events. This view is read-only.</p>
<div class="diagnostics-toolbar">
<small>Validated AI titles and opt-in explanations are logged locally and included in exports; prompts, diffs and commit bodies are not. Queue errors may include local paths.</small>
<label><input type="checkbox" id="diagnostics-auto-refresh" checked> Auto-refresh (10s)</label>
<button type="button" id="diagnostics-refresh">Refresh</button>
<button type="button" id="diagnostics-export" disabled>Export report</button>
</div>
<div class="diagnostics-stats" aria-live="polite">
<div class="diagnostics-stat"><strong id="diag-pending">—</strong><small>Pending commits</small></div>
<div class="diagnostics-stat"><strong id="diag-generating">—</strong><small>Generating titles</small></div>
<div class="diagnostics-stat"><strong id="diag-blocked">—</strong><small>Blocked</small></div>
<div class="diagnostics-stat"><strong id="diag-retries">—</strong><small>Logged retries</small></div>
<div class="diagnostics-stat"><strong id="diag-duration">—</strong><small>Average generation</small></div>
</div>
<p id="diagnostics-status" role="status" aria-live="polite">Loading diagnostics…</p>
<h3>Queued commits — all repositories</h3>
<div class="diagnostics-scroll"><table class="diagnostics-table"><thead><tr><th>Repository</th><th>Branch</th><th>Phase / issue</th><th>Job</th></tr></thead><tbody id="diagnostics-jobs"></tbody></table></div>
<h3>Recent diagnostic events</h3>
<p class="status">Counts and averages use only retained logs (up to four rotating files). New successful AI generations show their final title and duration. Enable Explain AI commit title choices in Ollama settings for optional notes; earlier events cannot be reconstructed.</p>
<div class="diagnostics-scroll"><table class="diagnostics-table"><thead><tr><th>Time</th><th>Event</th><th>Final title</th><th>Duration</th><th>Details</th></tr></thead><tbody id="diagnostics-events"></tbody></table></div>
</div>
"""

DIAGNOSTICS_SCRIPT = """
const diagnosticsRoot = document.getElementById('diagnostics-dashboard');
if (diagnosticsRoot) {
  let diagnosticsReport = null;
  let loadingDiagnostics = false;
  const diagStatus = document.getElementById('diagnostics-status');
  const jobRows = document.getElementById('diagnostics-jobs');
  const eventRows = document.getElementById('diagnostics-events');
  const exportButton = document.getElementById('diagnostics-export');
  const cell = (row, value) => {
    const td = document.createElement('td');
    td.textContent = String(value);
    row.appendChild(td);
    return td;
  };
  const placeholder = (parent, columns, message) => {
    const row = document.createElement('tr');
    cell(row, message).colSpan = columns;
    parent.appendChild(row);
  };
  async function refreshDiagnostics() {
    if (loadingDiagnostics) return;
    loadingDiagnostics = true;
    try {
      const response = await fetch('/diagnostics' + location.search, {cache: 'no-store'});
      if (!response.ok) throw new Error('Local diagnostics request failed (' + response.status + ').');
      diagnosticsReport = await response.json();
      const summary = diagnosticsReport.summary;
      for (const [id, value] of [
        ['diag-pending', summary.pending],
        ['diag-generating', summary.generating],
        ['diag-blocked', summary.blocked],
        ['diag-retries', summary.retries],
        ['diag-duration', summary.averageGenerationMs === null ? '—' : (summary.averageGenerationMs / 1000).toFixed(1) + 's']
      ]) document.getElementById(id).textContent = String(value);
      jobRows.replaceChildren();
      eventRows.replaceChildren();
      if (!diagnosticsReport.jobs.length) placeholder(jobRows, 4, 'No pending background commits.');
      for (const job of diagnosticsReport.jobs) {
        const row = document.createElement('tr');
        cell(row, job.repository);
        cell(row, job.branch);
        const phase = cell(row, job.phase);
        phase.className = 'diagnostics-phase';
        phase.dataset.phase = job.phase;
        if (job.error) {
          const error = document.createElement('span');
          error.className = 'diagnostics-error';
          error.textContent = job.error;
          phase.appendChild(error);
        }
        cell(row, job.id.slice(0, 8));
        jobRows.appendChild(row);
      }
      if (!diagnosticsReport.events.length) placeholder(eventRows, 5, 'No recorded diagnostic events.');
      for (const event of diagnosticsReport.events) {
        const row = document.createElement('tr');
        const date = new Date(event.timestamp);
        cell(row, Number.isNaN(date.getTime()) ? event.timestamp : date.toLocaleString());
        cell(row, (event.component || 'Sweetiebot') + ' · ' + event.event);
        const titleCell = cell(row, event.title || '—');
        if (event.title && (event.explanation || event.rule)) {
          const details = document.createElement('details');
          details.className = 'diagnostics-explanation';
          const summary = document.createElement('summary');
          summary.textContent = 'Why this title?';
          details.appendChild(summary);
          if (event.explanation) {
            const note = document.createElement('p');
            note.textContent = 'AI explanation: ' + event.explanation;
            details.appendChild(note);
          }
          const facts = [];
          if (event.rule === 'priority') facts.push('Emoji: configured priority rule');
          if (event.rule === 'change_type') facts.push('Emoji: change-type selection');
          if (Number.isInteger(event.attempts)) facts.push(event.attempts + ' generation attempt(s)');
          if (facts.length) {
            const ruleNote = document.createElement('p');
            ruleNote.textContent = facts.join(' · ');
            details.appendChild(ruleNote);
          }
          titleCell.appendChild(details);
        }
        cell(row, Number.isFinite(event.duration_ms) ? (event.duration_ms / 1000).toFixed(1) + 's' : '—');
        cell(row, [
          event.outcome, event.reason, event.error_type, event.model,
          event.attempt && ('attempt ' + event.attempt + (event.attempts ? '/' + event.attempts : '')),
          event.http_status && ('HTTP ' + event.http_status)
        ].filter(Boolean).join(' · ') || '—');
        eventRows.appendChild(row);
      }
      exportButton.disabled = false;
      diagStatus.textContent = 'Updated ' + new Date().toLocaleTimeString()
        + ' · ' + summary.eventsRetained + ' retained events · '
        + summary.generated + ' timed titles · ' + summary.fallbacks + ' fallbacks';
    } catch (error) {
      diagStatus.textContent = 'Diagnostics unavailable: ' + error.message;
    } finally {
      loadingDiagnostics = false;
    }
  }
  document.getElementById('diagnostics-refresh').addEventListener('click', refreshDiagnostics);
  exportButton.addEventListener('click', () => {
    if (!diagnosticsReport) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(diagnosticsReport, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sweetiebot-diagnostics.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const panel = diagnosticsRoot.closest('.settings-panel');
  document.querySelector('[aria-controls="' + panel.id + '"]')?.addEventListener('click', refreshDiagnostics);
  setInterval(() => {
    if (!panel.hidden && document.getElementById('diagnostics-auto-refresh').checked) void refreshDiagnostics();
  }, 10000);
  void refreshDiagnostics();
}
"""