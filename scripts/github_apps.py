"""Public App configuration and write-only macOS Keychain credential management."""

import ctypes
import json
import re
import subprocess
import sys
from pathlib import Path

SERVICE = b"com.sweetiebot.github-apps"
ROLES = {"kefania", "lindsey"}


def git_setting(name, value=None):
    args = ["git", "config", "--global"]
    args += ["--get", "scm-toolkit." + name] if value is None else ["scm-toolkit." + name, value]
    result = subprocess.run(args, capture_output=True, text=True, timeout=5)
    if value is not None and result.returncode:
        raise RuntimeError("Could not save GitHub App settings.")
    return result.stdout.strip() if result.returncode == 0 else ""


def app_status():
    # Never retrieve a password to render this page.
    return {"mode": git_setting("github-app-identity-mode") or "legacy",
            "keychainAvailable": sys.platform == "darwin",
            "apps": {role: {"id": git_setting(role + "-app-id"),
                            "slug": git_setting(role + "-app-slug") or role + "-pony",
                            "keyStored": git_setting(role + "-app-keychain") == "true"}
                     for role in sorted(ROLES)}}


def store_key(role, key):
    """Pass key bytes directly to Keychain Services, never argv, files or logs."""
    if role not in ROLES or sys.platform != "darwin":
        raise ValueError("Secure App credential storage currently requires macOS Keychain.")
    data = key.encode("utf-8")
    if len(data) > 32768 or not re.fullmatch(
            r"-----BEGIN (RSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+-----END (RSA )?PRIVATE KEY-----\s*", key):
        raise ValueError("Choose an unencrypted GitHub App PEM private key.")
    validation = subprocess.run(["node", "-e", """
try {
  const key = require('node:crypto').createPrivateKey(require('node:fs').readFileSync(0));
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) process.exit(1);
} catch { process.exit(1); }
"""], input=data, capture_output=True, timeout=10)
    if validation.returncode:
        raise ValueError("Choose a valid RSA GitHub App private key (2048 bits or larger).")
    security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    core = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    pointer = ctypes.c_void_p
    integer = ctypes.c_uint32
    security.SecKeychainFindGenericPassword.argtypes = [pointer, integer, ctypes.c_char_p,
        integer, ctypes.c_char_p, pointer, pointer, ctypes.POINTER(pointer)]
    security.SecKeychainAddGenericPassword.argtypes = [pointer, integer, ctypes.c_char_p,
        integer, ctypes.c_char_p, integer, ctypes.c_char_p, pointer]
    security.SecKeychainItemModifyAttributesAndData.argtypes = [pointer, pointer, integer, ctypes.c_char_p]
    core.CFRelease.argtypes = [pointer]
    account = role.encode()
    item = pointer()
    # NULL password outputs locate the item without reading its secret.
    status = security.SecKeychainFindGenericPassword(None, len(SERVICE), SERVICE,
        len(account), account, None, None, ctypes.byref(item))
    if status == 0:
        try:
            status = security.SecKeychainItemModifyAttributesAndData(item, None, len(data), data)
        finally:
            core.CFRelease(item)
    elif status == -25300:  # errSecItemNotFound
        status = security.SecKeychainAddGenericPassword(None, len(SERVICE), SERVICE,
            len(account), account, len(data), data, None)
    if status:
        raise RuntimeError("Keychain could not save the App key. Unlock your login keychain and retry.")


def save_app(values):
    role = values.get("role", [""])[0]
    app_id = values.get("id", [""])[0].strip()
    slug = values.get("slug", [""])[0].strip().lower()
    if role not in ROLES or not re.fullmatch(r"[0-9]+", app_id) or not re.fullmatch(
            r"[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?", slug):
        raise ValueError("Enter a valid App ID and App slug.")
    key = values.get("key", [""])[0].strip()
    if key:
        store_key(role, key)
    git_setting(role + "-app-id", app_id)
    git_setting(role + "-app-slug", slug)
    if key:
        git_setting(role + "-app-keychain", "true")
    return {"message": "App settings saved." + (" Private key stored in macOS Keychain." if key else ""),
            **app_status()}


def save_mode(mode):
    if mode not in {"legacy", "separate-apps"}:
        raise ValueError("Choose a supported App identity mode.")
    if mode == "separate-apps":
        status = app_status()
        if any(not app["id"] or not app["keyStored"] for app in status["apps"].values()):
            raise ValueError("Save both App IDs and private keys before enabling separate Apps.")
    git_setting("github-app-identity-mode", mode)
    return {"message": "App identity mode saved. New local actions use this mode immediately."}


def check_connection(role, repository):
    if role not in ROLES or not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Enter the repository as owner/name.")
    here = Path(__file__).resolve().parent
    module = here / "github_app_identity.js"
    if not module.exists():
        module = here.parent / "extension" / "github_app_identity.js"
    # Only the success identity is returned. Tokens and subprocess errors never
    # reach the page. No PR, comment or merge is created by this check.
    program = """
const {getRoleInstallationToken} = require(process.argv[1]);
process.env.SWEETIEBOT_BOT_IDENTITY_MODE = 'separate-apps';
getRoleInstallationToken(process.argv[2], process.argv[3]).then(
  result => console.log(JSON.stringify({login: result.login})),
  error => { console.log(JSON.stringify({error: error.message})); process.exitCode = 1; });
"""
    result = subprocess.run(["node", "-e", program, str(module), role, repository],
                            capture_output=True, text=True, timeout=95)
    try:
        payload = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise RuntimeError("App connection check could not run. Check Node and Keychain access.") from None
    if result.returncode:
        # Authentication module emits fixed, credential-free messages.
        raise RuntimeError(payload.get("error", "App authentication failed."))
    return {"message": "Connected as " + payload["login"] + " for " + repository + "."}
