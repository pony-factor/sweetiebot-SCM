#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request

REAL_GIT = os.environ.get("SCM_TOOLKIT_REAL_GIT", "/usr/bin/git")
OLLAMA_BASE = "http://127.0.0.1:11434"
OLLAMA_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
COMMON_MODELS = (
    "qwen2.5-coder:0.5b",
    "qwen2.5-coder:1.5b",
    "qwen2.5-coder:3b",
    "qwen2.5-coder:7b",
    "qwen2.5-coder:14b",
    "qwen2.5-coder:32b",
)


def git_config_string(key: str, default: str = "") -> str:
    result = subprocess.run(
        [REAL_GIT, "config", "--global", "--get", key],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return default
    value = result.stdout.strip()
    return value or default


def git_config_bool(key: str, default: bool) -> bool:
    result = subprocess.run(
        [REAL_GIT, "config", "--global", "--type=bool", "--get", key],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return default
    return result.stdout.strip() == "true"


def set_git_config(key: str, value: str) -> None:
    result = subprocess.run(
        [REAL_GIT, "config", "--global", key, value],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"Unable to set {key}")


def system_memory_gib() -> float | None:
    try:
        result = subprocess.run(
            ["/usr/sbin/sysctl", "-n", "hw.memsize"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode != 0:
            return None
        return int(result.stdout.strip()) / 1024**3
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def recommend_models(total_gib: float | None) -> tuple[str, str]:
    if total_gib is None:
        return "qwen2.5-coder:7b", "qwen2.5-coder:3b"
    if total_gib < 12:
        return "qwen2.5-coder:3b", "qwen2.5-coder:1.5b"
    if total_gib < 24:
        return "qwen2.5-coder:7b", "qwen2.5-coder:3b"
    if total_gib < 48:
        return "qwen2.5-coder:14b", "qwen2.5-coder:7b"
    return "qwen2.5-coder:32b", "qwen2.5-coder:14b"


def installed_local_models() -> set[str]:
    try:
        request = urllib.request.Request(f"{OLLAMA_BASE}/api/tags", method="GET")
        with OLLAMA_OPENER.open(request, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return set()

    names = set()
    for model in payload.get("models", []):
        for key in ("name", "model"):
            value = model.get(key)
            if isinstance(value, str) and value:
                names.add(value)
    return names


def model_choices(
    installed: set[str],
    primary: str,
    low_memory: str,
    recommended: tuple[str, str],
) -> list[str]:
    values = set(COMMON_MODELS)
    values.update(installed)
    values.update((primary, low_memory, *recommended))
    values.discard("")
    return sorted(values)


def applescript_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def run_applescript(script: str) -> str:
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", script],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        if "User canceled" in result.stderr:
            return ""
        raise RuntimeError(result.stderr.strip() or "Model picker failed")
    return result.stdout.strip()


def choose_from_list(title: str, prompt: str, choices: list[str], default: str) -> str:
    items = ", ".join(applescript_string(item) for item in [*choices, "Other..."])
    default_item = default if default in choices else choices[0]
    script = (
        f"set picked to choose from list {{{items}}} "
        f"with title {applescript_string(title)} "
        f"with prompt {applescript_string(prompt)} "
        f"default items {{{applescript_string(default_item)}}} "
        'OK button name "Select" cancel button name "Cancel"\n'
        'if picked is false then return ""\n'
        "return item 1 of picked"
    )
    selected = run_applescript(script)
    if selected != "Other...":
        return selected

    other_script = (
        f"display dialog {applescript_string('Enter an Ollama model tag:')} "
        f"with title {applescript_string(title)} default answer \"\" "
        'buttons {"Cancel", "Use"} default button "Use"\n'
        "return text returned of result"
    )
    return run_applescript(other_script)


def show_message(title: str, message: str) -> None:
    script = (
        f"display alert {applescript_string(title)} "
        f"message {applescript_string(message)} "
        'buttons {"OK"} default button "OK"'
    )
    run_applescript(script)


def main() -> None:
    if not git_config_bool("scm-toolkit.ai-model-picker", True):
        print(
            "scm-toolkit: model picker is disabled by scm-toolkit.ai-model-picker",
            file=sys.stderr,
        )
        raise SystemExit(1)

    total_gib = system_memory_gib()
    recommended = recommend_models(total_gib)
    installed = installed_local_models()
    primary = git_config_string("scm-toolkit.ai-commit-model", recommended[0])
    low_memory = git_config_string(
        "scm-toolkit.ai-commit-low-memory-model", recommended[1]
    )
    choices = model_choices(installed, primary, low_memory, recommended)

    memory_label = (
        f"{total_gib:.0f} GiB system memory"
        if total_gib is not None
        else "system memory could not be detected"
    )
    recommendation = (
        f"Recommended for {memory_label}: {recommended[0]} primary, "
        f"{recommended[1]} low-memory fallback."
    )

    primary_choice = choose_from_list(
        "Sweetiebot SCM AI Models",
        recommendation + "\n\nChoose the normal commit-title model.",
        choices,
        primary,
    )
    if not primary_choice:
        return

    low_choice = choose_from_list(
        "Sweetiebot SCM AI Models",
        recommendation + "\n\nChoose the model used when available memory is low.",
        choices,
        low_memory,
    )
    if not low_choice:
        return

    set_git_config("scm-toolkit.ai-commit-model", primary_choice)
    set_git_config("scm-toolkit.ai-commit-low-memory-model", low_choice)

    missing = [
        model for model in (primary_choice, low_choice) if model not in installed
    ]
    message = (
        f"Primary: {primary_choice}\nLow-memory fallback: {low_choice}\n\n"
        "Saved to the [scm-toolkit] section of ~/.gitconfig."
    )
    if missing:
        pulls = "\n".join(f"ollama pull {model}" for model in dict.fromkeys(missing))
        message += (
            "\n\nThese selected models are not currently reported by local Ollama. "
            "Install them before use:\n" + pulls
        )
    show_message("Sweetiebot SCM AI Models", message)


if __name__ == "__main__":
    main()
