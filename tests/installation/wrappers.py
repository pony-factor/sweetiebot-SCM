
import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

import json
import contextlib
import io
import subprocess
import os
import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import branch_names
import build_installer_app
import install
import toolkit_settings
import wrapper_dependencies



# Allow direct script execution as well as the CI unittest module runner.
_sb_root = str(_sb_path(__file__).resolve().parents[2])
if _sb_root not in _sb_sys.path:
    _sb_sys.path.insert(0, _sb_root)

from tests.fixtures.installer_support import (
    SETTINGS, GIT_MODEL_FIXTURE, workbench_fixture, pr_explorer_fixture,
    browser_cross_window_fixture, browser_resolver_fixture, browser_open_action_fixture,
)


class AiWrapperTests(unittest.TestCase):
    def test_sync_ai_wrapper_installs_executable_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-git"
            self.assertTrue(install.sync_ai_wrapper(check=True, destination=destination))
            self.assertFalse(destination.exists())

            self.assertTrue(install.sync_ai_wrapper(destination=destination))
            self.assertEqual(destination.read_bytes(), (install.HERE / "ai-commit.py").read_bytes())
            sources = wrapper_dependencies.wrapper_files(install.HERE, destination)
            for target, source in sources.items():
                self.assertEqual(target.read_bytes(), source.read_bytes())
                self.assertTrue(target.stat().st_mode & 0o111)
            wrapper_dependencies.validate_imports(destination.parent)
            backend = destination.with_name("coreml-backend.py")
            self.assertEqual(backend.read_bytes(), (install.HERE / "coreml-backend.py").read_bytes())
            # Exercise the installed wrapper without source-tree imports.
            result = subprocess.run(
                [sys.executable, str(destination), "--version"],
                cwd=tmp, env={**os.environ, "PYTHONPATH": ""},
                text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("git version", result.stdout)
            diagnostics = destination.with_name("sweetiebot-diagnostics.py")
            self.assertEqual(diagnostics.read_bytes(), (install.HERE / "sweetiebot-diagnostics.py").read_bytes())
            async_worker = destination.with_name("sweetiebot-async-commit.py")
            self.assertEqual(async_worker.read_bytes(), (install.HERE / "sweetiebot-async-commit.py").read_bytes())
            self.assertTrue(destination.stat().st_mode & 0o111)
            self.assertFalse(install.sync_ai_wrapper(check=True, destination=destination))

    def test_missing_transitive_dependencies_are_detected_and_repaired(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-git"
            install.sync_ai_wrapper(destination=destination)
            for name in ("toolkit-settings.py", "codex-composer-layout.py",
                         "message-bar.py", "branch-names.py", "branch-name-packs.json"):
                self.assertTrue(destination.with_name(name).is_file(), name)
            missing = destination.with_name("toolkit-settings.py")
            missing.unlink()
            self.assertTrue(install.sync_ai_wrapper(check=True, destination=destination))
            with self.assertRaisesRegex(RuntimeError, "dependencies cannot load"):
                wrapper_dependencies.validate_imports(destination.parent)
            install.sync_ai_wrapper(destination=destination)
            self.assertFalse(install.sync_ai_wrapper(check=True, destination=destination))

    def test_install_restarts_stranded_committed_jobs_with_complete_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "commit-jobs"
            directory = home / "example-job"
            directory.mkdir(parents=True)
            file = directory / "job.json"
            job = {
                "id": "example-job", "root": str(Path(tmp) / "repo"),
                "gitdir": str(Path(tmp) / "repo/.git"),
                "phase": "done",
            }
            file.write_text(json.dumps(job))
            with patch.dict(os.environ, {"SWEETIEBOT_COMMIT_JOBS": str(home)}):
                self.assertFalse(install.resume_stalled_background_jobs())
                self.assertFalse((home / "runtime").exists())

                # A crashed worker must not be treated as successful merely
                # because the initial Git commit already exists.
                job["phase"] = "committed"
                file.write_text(json.dumps(job))
                with patch.object(wrapper_dependencies, "validate_imports") as verify, \
                        patch.object(install.subprocess, "Popen") as launch:
                    self.assertTrue(install.resume_stalled_background_jobs())
                    verify.assert_called_once_with(home / "runtime")
                    args, kwargs = launch.call_args
                    self.assertEqual(args[0][-1], "--resume")
                    self.assertEqual(Path(args[0][1]), home / "runtime/background-commit.py")
                    self.assertTrue(kwargs["start_new_session"])
                self.assertEqual(json.loads(file.read_text())["phase"], "committed")
                self.assertTrue((home / "runtime/toolkit-settings.py").is_file())
                self.assertTrue((home / "runtime/wrapper-dependencies.py").is_file())
                wrapper_dependencies.validate_imports(home / "runtime")

    def test_install_ignores_untrusted_stale_job_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "commit-jobs"
            directory = home / "invalid"
            directory.mkdir(parents=True)
            (directory / "job.json").write_text("not JSON")
            with patch.dict(os.environ, {"SWEETIEBOT_COMMIT_JOBS": str(home)}):
                self.assertFalse(install.resume_stalled_background_jobs())
                self.assertFalse((home / "runtime").exists())

    def test_index_only_reset_works_even_when_a_dependency_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-git"
            install.sync_ai_wrapper(destination=destination)
            repo = Path(tmp) / "repo"
            repo.mkdir()
            real_git = os.environ.get("SCM_TOOLKIT_REAL_GIT", "/usr/bin/git")
            def git(*args):
                return subprocess.run([real_git, *args], cwd=repo, check=True,
                                      text=True, capture_output=True)
            git("init", "-q")
            git("config", "user.name", "Sweetiebot Test")
            git("config", "user.email", "test@example.invalid")
            (repo / "file.txt").write_text("initial")
            git("add", "file.txt")
            git("commit", "-qm", "Initial commit")
            (repo / "file.txt").write_text("changed")
            git("add", "file.txt")
            env = {**os.environ, "PYTHONPATH": "", "SCM_TOOLKIT_REAL_GIT": real_git}
            for missing in ("toolkit-settings.py", "coreml-backend.py",
                            "sweetiebot-diagnostics.py", "background-commit.py"):
                install.sync_ai_wrapper(destination=destination)
                destination.with_name(missing).unlink()
                version = subprocess.run([sys.executable, str(destination), "--version"],
                                         cwd=repo, env=env, text=True, capture_output=True)
                self.assertEqual(version.returncode, 0, version.stderr)
                result = subprocess.run([sys.executable, str(destination), "reset", "-q", "HEAD", "--", "."],
                                        cwd=repo, env=env, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, (missing, result.stderr))
                self.assertEqual(git("diff", "--cached", "--quiet").returncode, 0)
                blocked = subprocess.run([sys.executable, str(destination), "reset", "--hard", "HEAD"],
                                         cwd=repo, env=env, text=True, capture_output=True)
                self.assertNotEqual(blocked.returncode, 0)
                self.assertIn("installation is incomplete", blocked.stderr)
                self.assertNotIn("Traceback", blocked.stderr)

    def test_missing_toolkit_settings_allows_file_checkout_but_blocks_branch_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-git"
            install.sync_ai_wrapper(destination=destination)
            legacy = destination.with_name("git-auto-title")
            legacy.symlink_to(destination)
            repo = Path(tmp) / "repo"
            repo.mkdir()
            real_git = os.environ.get("SCM_TOOLKIT_REAL_GIT", "/usr/bin/git")

            def git(*args):
                return subprocess.run([real_git, *args], cwd=repo, check=True,
                                      text=True, capture_output=True)

            git("init", "-q")
            git("config", "user.name", "Sweetiebot Test")
            git("config", "user.email", "test@example.invalid")
            file = repo / "file.txt"
            file.write_text("original", encoding="utf-8")
            git("add", "file.txt")
            git("commit", "-qm", "Initial commit")
            original_head = git("rev-parse", "HEAD").stdout.strip()
            destination.with_name("toolkit-settings.py").unlink()
            env = {**os.environ, "PYTHONPATH": "", "SCM_TOOLKIT_REAL_GIT": real_git}

            # Both the canonical executable and the old VS Code git.path alias
            # must delegate file-only restoration to Git without importing the
            # missing settings module or losing the current commit.
            for wrapper in (destination, legacy):
                file.write_text("modified", encoding="utf-8")
                restored = subprocess.run(
                    [sys.executable, str(wrapper), "checkout", "-q", "--", "file.txt"],
                    cwd=repo, env=env, text=True, capture_output=True,
                )
                self.assertEqual(restored.returncode, 0, restored.stderr)
                self.assertEqual(file.read_text(encoding="utf-8"), "original")
                self.assertEqual(git("rev-parse", "HEAD").stdout.strip(), original_head)

            blocked = subprocess.run(
                [sys.executable, str(legacy), "checkout", "-b", "should-not-exist"],
                cwd=repo, env=env, text=True, capture_output=True,
            )
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn("installation is incomplete", blocked.stderr)
            self.assertIn("toolkit_settings", blocked.stderr)
            self.assertNotIn("Traceback", blocked.stderr)
            self.assertFalse(git("branch", "--list", "should-not-exist").stdout.strip())
            self.assertEqual(git("rev-parse", "HEAD").stdout.strip(), original_head)

            # The installer already repairs the missing sibling dependency.
            self.assertTrue(install.sync_ai_wrapper(check=True, destination=destination))
            install.sync_ai_wrapper(destination=destination)
            self.assertTrue(destination.with_name("toolkit-settings.py").is_file())
            self.assertFalse(install.sync_ai_wrapper(check=True, destination=destination))

    def test_canonical_installer_call_migrates_existing_legacy_wrapper(self):
        with tempfile.TemporaryDirectory() as tmp:
            primary = Path(tmp) / "bin" / "scm-toolkit-git"
            legacy = Path(tmp) / "bin" / "git-auto-title"
            legacy.parent.mkdir(parents=True)
            legacy.write_text("stale wrapper", encoding="utf-8")

            with patch.object(install, "ai_wrapper_path", return_value=primary), patch.object(
                install, "legacy_ai_wrapper_path", return_value=legacy
            ):
                # Match the normal installer call shape: it supplies the
                # canonical destination explicitly.
                self.assertTrue(
                    install.sync_ai_wrapper(check=True, destination=primary)
                )
                self.assertFalse(legacy.is_symlink())
                self.assertTrue(install.sync_ai_wrapper(destination=primary))
                self.assertFalse(
                    install.sync_ai_wrapper(check=True, destination=primary)
                )

            expected = (install.HERE / "ai-commit.py").read_bytes()
            helper = legacy.with_name(legacy.name + "-spellcheck.py")
            primary_helper = primary.with_name(primary.name + "-spellcheck.py")
            self.assertEqual(primary.read_bytes(), expected)
            self.assertTrue(legacy.is_symlink())
            self.assertEqual(legacy.resolve(), primary.resolve())
            self.assertTrue(helper.is_symlink())
            self.assertEqual(helper.resolve(), primary_helper.resolve())
            self.assertEqual(legacy.read_bytes(), expected)
            self.assertTrue(legacy.stat().st_mode & 0o111)

    def test_custom_wrapper_destination_does_not_rewrite_legacy_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            canonical = Path(tmp) / "bin" / "scm-toolkit-git"
            custom = Path(tmp) / "custom" / "git"
            legacy = Path(tmp) / "bin" / "git-auto-title"
            legacy.parent.mkdir(parents=True)
            legacy.write_text("leave me alone", encoding="utf-8")

            with patch.object(install, "ai_wrapper_path", return_value=canonical), patch.object(
                install, "legacy_ai_wrapper_path", return_value=legacy
            ):
                self.assertTrue(install.sync_ai_wrapper(destination=custom))

            self.assertFalse(legacy.is_symlink())
            self.assertEqual(legacy.read_text(encoding="utf-8"), "leave me alone")

    def test_installed_wrapper_loads_spellcheck_helper_and_core(self):
        import importlib.util
        from importlib.machinery import SourceFileLoader
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "scm-toolkit-git"
            install.sync_ai_wrapper(destination=destination)
            loader = SourceFileLoader("installed_commit_core", str(destination))
            spec = importlib.util.spec_from_file_location("installed_commit_core", destination, loader=loader)
            core = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(core)
            worker = core.load_post_commit_spellcheck()
            helper = destination.with_name(destination.name + "-spellcheck.py")
            self.assertEqual(helper.read_bytes(), (install.HERE / "post-commit-spellcheck.py").read_bytes())
            with patch.object(worker, "CORE_PATH", str(destination)):
                self.assertTrue(callable(worker.load_core().generate_message))
            install.sync_ai_wrapper(remove=True, destination=destination)
            self.assertFalse(helper.exists())
            self.assertFalse(destination.with_name("sweetiebot-diagnostics.py").exists())
            self.assertFalse(destination.with_name("sweetiebot-async-commit.py").exists())

    def test_sync_ai_wrapper_uninstall_removes_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "scm-toolkit-git"
            install.sync_ai_wrapper(destination=destination)
            self.assertTrue(install.sync_ai_wrapper(remove=True, check=True, destination=destination))
            self.assertTrue(destination.exists())
            install.sync_ai_wrapper(remove=True, destination=destination)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_name("sweetiebot-diagnostics.py").exists())
            self.assertFalse(destination.with_name("sweetiebot-async-commit.py").exists())


    def test_sync_model_picker_installs_executable_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-models"
            self.assertTrue(
                install.sync_model_picker(
                    enabled=True, check=True, destination=destination
                )
            )
            self.assertFalse(destination.exists())

            self.assertTrue(
                install.sync_model_picker(enabled=True, destination=destination)
            )
            self.assertEqual(
                destination.read_bytes(),
                (install.HERE / "model-picker.py").read_bytes(),
            )
            self.assertTrue(destination.stat().st_mode & 0o111)

    def test_disabling_model_picker_removes_installed_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "scm-toolkit-models"
            install.sync_model_picker(enabled=True, destination=destination)
            self.assertTrue(destination.exists())

            self.assertTrue(
                install.sync_model_picker(
                    enabled=False, check=True, destination=destination
                )
            )
            self.assertTrue(destination.exists())
            install.sync_model_picker(enabled=False, destination=destination)
            self.assertFalse(destination.exists())

if __name__ == "__main__":
    unittest.main()
