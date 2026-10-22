"""Local, size-bounded diagnostics shared by Sweetiebot's Python commands.

This log records allowlisted operational metadata and validated generated
commit titles for successful AI generations. Never record prompts, staged
diffs, chat context, commit descriptions/bodies, or exception strings.
"""

from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path

MAX_LOG_BYTES = 1024 * 1024
BACKUP_COUNT = 3
FIELDS = frozenset({
    "model", "attempt", "attempts", "reason", "outcome", "error_type",
    "http_status", "duration_ms", "rule", "title",
})


def log_path() -> Path:
    """Keep runtime logs outside Git checkouts and installed source directories."""
    return Path(os.environ.get(
        "SWEETIEBOT_LOG_FILE", "~/Library/Logs/Sweetiebot/sweetiebot.log"
    )).expanduser()


def log_event(component: str, event: str, **details: object) -> bool:
    """Append an operational event; logging failures must not affect commits."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "component": component,
        "event": event,
    }
    for key, value in details.items():
        if key in FIELDS and value is not None and isinstance(value, (str, int, bool)):
            record[key] = value[:240 if key == 'title' else 120] if isinstance(value, str) else value

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
