from contextlib import ExitStack
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import install
import repair
import toolkit_settings
import workspace_search
from tests.install import workbench_fixture


class RepairTests(unittest.TestCase):
    def test_repair_restores_workbench_and_stale_runtime_tools(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            js, css = root / 'workbench.js', root / 'workbench.css'
            js.write_text(workbench_fixture())
            css.write_text('base')
            # Test the native Git patch against a temporary application bundle
            # rather than relying on a macOS VS Code installation in CI.
            app = root / 'Code.app'
            git_extension = app / 'Contents/Resources/app/extensions/git/dist/main.js'
            git_extension.parent.mkdir(parents=True)
            git_extension.write_text(
                'class Repository{async commit(e,t=Object.create(null)){'
                'let r=[...this.indexGroup.resourceStates.map(o=>o.resourceUri.fsPath)];'
                'let x=api.workspace.getConfiguration("git",api.Uri.file(this.root));'
                'return "native"}}'
            )
            stack.enter_context(patch('sys.argv', ['install.py', '--repair', '--app', str(app)]))
            stack.enter_context(patch.object(install, 'application_paths', side_effect=lambda _app: ('test', [js, css])))
            stack.enter_context(patch.object(install, 'load_settings', return_value=dict(toolkit_settings.DEFAULT_SETTINGS)))
            stack.enter_context(patch.object(install.github_pr, 'patch_files', return_value=[]))
            stack.enter_context(patch.object(install.browser_pr, 'patch_files', return_value=[]))
            stack.enter_context(patch.object(install.codex_colors, 'stylesheet_path', return_value=None))
            stack.enter_context(patch.object(install.codex_label, 'patch_file', return_value=None))
            stack.enter_context(patch.object(install, 'codex_bundle_paths', return_value=[]))
            for module in (install.codex_context, install.codex_usage, install.codex_composer):
                stack.enter_context(patch.object(module, 'patch_files', return_value=[]))
            stack.enter_context(patch.object(install.codex_keep_awake, 'patch_file', return_value=None))
            stack.enter_context(patch.object(install.codex_startup, 'patch_file', return_value=None))
            stack.enter_context(patch.object(install, 'persist_message_bar_layout'))
            stack.enter_context(patch.object(install, 'invalidate_extension_cache'))
            extensions = root / 'extensions'
            stack.enter_context(patch.object(workspace_search, 'default_extensions_dir', return_value=extensions))
            extension = stack.enter_context(patch.object(workspace_search, 'sync_extension', wraps=workspace_search.sync_extension))
            stack.enter_context(patch.object(workspace_search, 'remove_legacy_extensions', return_value=False))
            wrapper_path = root / 'bin/scm-toolkit-git'
            stack.enter_context(patch.object(install, 'ai_wrapper_path', return_value=wrapper_path))
            stack.enter_context(patch.object(install, 'legacy_ai_wrapper_path', return_value=root / 'bin/git-auto-title'))
            wrapper = stack.enter_context(patch.object(install, 'sync_ai_wrapper', wraps=install.sync_ai_wrapper))
            picker = stack.enter_context(patch.object(install, 'sync_model_picker'))
            install.main()
            self.assertIn(install.START, js.read_text())
            self.assertIn(install.START, css.read_text())
            self.assertIn(install.BACKGROUND_GIT_START, git_extension.read_text())
            destination = workspace_search.extension_destination(extensions)
            helper = wrapper_path.with_name(wrapper_path.name + '-spellcheck.py')
            notice = destination / 'commits' / 'post_commit_spellcheck_notice.js'
            # A later startup must repair these even when the app patch is current.
            helper.write_text('stale helper')
            notice.write_text('stale notice')
            with patch.object(install, 'write_pair') as write:
                install.main()
                write.assert_not_called()
            self.assertEqual(helper.read_bytes(), (install.HERE / 'post_commit_spellcheck.py').read_bytes())
            self.assertEqual(notice.read_bytes(), (workspace_search.SOURCE / 'commits' / notice.name).read_bytes())
            self.assertFalse(install.sync_ai_wrapper(check=True, destination=wrapper_path))
            self.assertFalse(workspace_search.sync_extension(check=True, settings=dict(toolkit_settings.DEFAULT_SETTINGS)))
            picker.assert_not_called()

    def test_bundled_repair_has_workbench_assets(self):
        sources = workspace_search.source_files()
        for name in ('picker.js', 'picker.css', 'hide_progress.css', 'outlined_buttons.css'):
            self.assertIn(Path('codex-customizations/assets/workbench') / name, sources)
        self.assertIn(Path('codex-customizations/scripts/repair.py'), sources)
        self.assertIn(Path('codex-customizations/scripts/update.py'), sources)
        for name in ('github/pr_refresh.js', 'github/pr_actions.js', 'package.json'):
            self.assertIn(Path('codex-customizations/extension') / name, sources)

    def test_remote_update_check_is_shared_between_windows(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair, 'prepare_update', return_value=None) as prepare, \
                patch.object(repair.os, 'execv') as execute:
            repair.repair(['--app', '/Custom/Code.app'])
            repair.repair(['--app', '/Custom/Code.app'])
            cache = Path(directory) / 'Library/Caches/dev.ponyfactor.sweetiebot'
            prepare.assert_called_once_with(cache)
            self.assertEqual(execute.call_count, 2, 'each window can still repair local files')
            self.assertTrue((cache / 'last-remote-check').is_file())

            # Once the shared hourly check expires, any window may fetch again.
            os.utime(cache / 'last-remote-check', (0, 0))
            repair.repair(['--app', '/Custom/Code.app'])
            self.assertEqual(prepare.call_count, 2)

    def test_failed_remote_check_uses_shared_short_backoff(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair, 'prepare_update', side_effect=OSError('offline')) as prepare, \
                patch.object(repair.os, 'execv') as execute:
            repair.repair([])
            repair.repair([])
            cache = Path(directory) / 'Library/Caches/dev.ponyfactor.sweetiebot'
            self.assertEqual(prepare.call_count, 1)
            self.assertEqual(execute.call_count, 2, 'offline repairs still run in every window')
            self.assertFalse((cache / 'last-remote-check').exists())
            os.utime(cache / 'last-remote-failure', (0, 0))
            repair.repair([])
            self.assertEqual(prepare.call_count, 2, 'failed update checks must retry after backoff')

    def test_busy_lock_skips_repair(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair.fcntl, 'flock', side_effect=BlockingIOError), patch.object(repair.os, 'execv') as execute:
            self.assertEqual(repair.repair([]), repair.RETRY_LATER)
            execute.assert_not_called()

    def test_exec_keeps_lock_and_passes_custom_app_path(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair.os, 'set_inheritable') as inherit, patch.object(repair.os, 'execv') as execute:
            with patch.object(repair, 'prepare_update', return_value=None):
                repair.repair(['--app', '/Custom/Code.app'])
            inherit.assert_called_once()
            self.assertTrue(inherit.call_args.args[1])
            self.assertEqual(execute.call_args.args[1][-3:], ['--repair', '--app', '/Custom/Code.app'])

    def test_update_installs_companion_and_records_only_success(self):
        for code in (0, 1):
            with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                    patch.object(repair, 'prepare_update', side_effect=[(Path('/candidate/scripts/install.py'), 'abc'), None]), \
                    patch.object(repair.subprocess, 'run') as run, patch.object(repair.os, 'execv') as execute:
                run.return_value.returncode = code
                self.assertEqual(repair.repair(['--app', '/Custom/Code.app']), code)
                self.assertNotIn('--repair', run.call_args.args[0])
                marker = Path(directory) / 'Library/Caches/dev.ponyfactor.sweetiebot/installed-revision'
                self.assertEqual(marker.exists(), code == 0)
                execute.assert_not_called()

    def test_manual_install_fetches_even_when_revision_is_already_installed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair, 'prepare_update', side_effect=[
                    (Path('/candidate/scripts/install.py'), 'abc'), None]) as prepare, \
                patch.object(repair.subprocess, 'run') as run:
            run.return_value.returncode = 0
            self.assertEqual(repair.repair([], install=True), 0)
            self.assertTrue(prepare.call_args_list[0].kwargs['force'])
            self.assertNotIn('--repair', run.call_args.args[0])

    def test_manual_offline_install_refreshes_the_companion(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair, 'prepare_update', side_effect=OSError), \
                patch.object(repair.os, 'execv') as execute:
            repair.repair(['--app', '/Custom/Code.app'], install=True)
            self.assertNotIn('--repair', execute.call_args.args[1])
            self.assertEqual(execute.call_args.args[1][-2:], ['--app', '/Custom/Code.app'])

    def test_manifest_cache_is_cleared_without_touching_other_cache_files(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)):
            root = Path(directory)
            app = root / 'Code.app'
            product = app / 'Contents/Resources/app/product.json'
            product.parent.mkdir(parents=True)
            product.write_text('{"nameShort":"Code"}')
            cache = root / 'Library/Application Support/Code/CachedExtensions'
            cache.mkdir(parents=True)
            (cache / 'user').write_text('old manifest scan')
            (cache / 'builtin').write_text('preserved')
            install.invalidate_extension_cache(app)
            self.assertFalse((cache / 'user').exists())
            self.assertTrue((cache / 'builtin').exists())
            (cache / 'user').symlink_to(cache / 'builtin')
            install.invalidate_extension_cache(app)
            self.assertTrue((cache / 'user').is_symlink())

    def test_newer_tip_is_installed_before_returning(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair, 'prepare_update', side_effect=[
                    (Path('/candidate/scripts/install.py'), 'abc'),
                    (Path('/candidate/scripts/install.py'), 'latest'), None]), \
                patch.object(repair.subprocess, 'run') as run:
            run.return_value.returncode = 0
            self.assertEqual(repair.repair([]), 0)
            self.assertEqual(run.call_count, 2)
            marker = Path(directory) / 'Library/Caches/dev.ponyfactor.sweetiebot/installed-revision'
            self.assertEqual(marker.read_text(), 'latest\n')

    def test_offline_update_still_repairs(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair, 'prepare_update', side_effect=OSError), patch.object(repair.os, 'execv') as execute:
            repair.repair([])
            execute.assert_called_once()
