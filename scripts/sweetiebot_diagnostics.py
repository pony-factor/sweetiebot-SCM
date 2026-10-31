"""Local, size-bounded diagnostics shared by Sweetiebot's Python commands.

This log records allowlisted operational metadata and validated generated
commit titles and opt-in short explanations for successful AI generations.
Never record prompts, staged
diffs, chat context, commit descriptions/bodies, or exception strings.
"""

from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re

MAX_LOG_BYTES = 1024 * 1024
BACKUP_COUNT = 3
FIELDS = frozenset({
    "model", "attempt", "attempts", "reason", "outcome", "error_type",
    "http_status", "duration_ms", "rule", "title", "explanation",
    "repository", "job_id",
})


def log_path() -> Path:
    """Keep runtime logs outside Git checkouts and installed source directories."""
    return Path(os.environ.get(
        "SWEETIEBOT_LOG_FILE", "~/Library/Logs/Sweetiebot/sweetiebot.log"
    )).expanduser()


def _repository_name() -> str | None:
    """Record only the name of the nearest Git checkout, never its full path."""
    try:
        current = Path.cwd()
        for directory in (current, *current.parents):
            marker = directory / ".git"
            if marker.is_file() or marker.is_dir():
                return directory.name[:100]
    except OSError:
        pass
    return None


def _job_id(value: object) -> str | None:
    """Reject paths, control characters and arbitrary environment contents."""
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,64}", value):
        return value
    return None


def log_event(component: str, event: str, **details: object) -> bool:
    """Append an operational event; logging failures must not affect commits."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "component": component,
        "event": event,
    }
    repository = _repository_name()
    job_id = _job_id(os.environ.get("SWEETIEBOT_BACKGROUND_JOB"))
    if repository:
        record["repository"] = repository
    if job_id:
        record["job_id"] = job_id
    for key, value in details.items():
        if key not in FIELDS or value is None or not isinstance(value, (str, int, bool)):
            continue
        if key == "job_id":
            value = _job_id(value)
            if value is None:
                continue
        elif key == "repository":
            if not isinstance(value, str) or not value or Path(value).name != value or "\\" in value:
                continue
            value = value[:100]
        record[key] = value[:240 if key in {'title', 'explanation'} else 120] if isinstance(value, str) else value

    handler = None
    try:
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Do not allow a configured or preexisting symlink to redirect diagnostics.
        if path.is_symlink():
            return False
        fd = os.open(
            path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        os.close(fd)
        os.chmod(path, 0o600)
        handler = RotatingFileHandler(
            path, maxBytes=MAX_LOG_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger = logging.Logger("sweetiebot.diagnostics", level=logging.WARNING)
        logger.addHandler(handler)
        logger.warning("%s", json.dumps(record, ensure_ascii=False))
        return True
    except (OSError, ValueError, TypeError):
        return False
    finally:
        if handler is not None:
            handler.close()
