from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import install
import repair
import toolkit_settings
import workspace_search
from test_install import workbench_fixture


class RepairTests(unittest.TestCase):
    def test_repair_restores_workbench_without_reinstalling_companion(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            js, css = root / 'workbench.js', root / 'workbench.css'
            js.write_text(workbench_fixture())
            css.write_text('base')
            stack.enter_context(patch('sys.argv', ['install.py', '--repair']))
            stack.enter_context(patch.object(install, 'application_paths', return_value=('test', [js, css])))
            stack.enter_context(patch.object(install, 'load_settings', return_value=dict(toolkit_settings.DEFAULT_SETTINGS)))
            stack.enter_context(patch.object(install.github_pr, 'patch_files', return_value=[]))
            stack.enter_context(patch.object(install.codex_colors, 'stylesheet_path', return_value=None))
            stack.enter_context(patch.object(install, 'codex_bundle_paths', return_value=[]))
            for module in (install.codex_context, install.codex_usage, install.codex_composer):
                stack.enter_context(patch.object(module, 'patch_files', return_value=[]))
            stack.enter_context(patch.object(install.codex_keep_awake, 'patch_file', return_value=None))
            stack.enter_context(patch.object(install.codex_startup, 'patch_file', return_value=None))
            extension = stack.enter_context(patch.object(workspace_search, 'sync_extension'))
            stack.enter_context(patch.object(workspace_search, 'remove_legacy_extensions', return_value=False))
            wrapper = stack.enter_context(patch.object(install, 'sync_ai_wrapper'))
            picker = stack.enter_context(patch.object(install, 'sync_model_picker'))
            install.main()
            self.assertIn(install.START, js.read_text())
            self.assertIn(install.START, css.read_text())
            with patch.object(install, 'write_pair') as write:
                install.main()
                write.assert_not_called()
            extension.assert_not_called()
            wrapper.assert_not_called()
            picker.assert_not_called()

    def test_bundled_repair_has_workbench_assets(self):
        sources = workspace_search.source_files()
        for name in ('picker.js', 'picker.css', 'hide_progress.css', 'outlined_buttons.css'):
            self.assertIn(Path('codex-customizations/assets/workbench') / name, sources)
        self.assertIn(Path('codex-customizations/scripts/repair.py'), sources)
        self.assertIn(Path('codex-customizations/scripts/update.py'), sources)
        for name in ('github_pr_refresh.js', 'github_pr_actions.js', 'package.json'):
            self.assertIn(Path('codex-customizations/efs') / name, sources)

    def test_busy_lock_skips_repair(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair.fcntl, 'flock', side_effect=BlockingIOError), patch.object(repair.os, 'execv') as execute:
            self.assertEqual(repair.repair([]), 0)
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
                    patch.object(repair, 'prepare_update', return_value=(Path('/candidate/scripts/install.py'), 'abc')), \
                    patch.object(repair.subprocess, 'run') as run, patch.object(repair.os, 'execv') as execute:
                run.return_value.returncode = code
                repair.repair(['--app', '/Custom/Code.app'])
                self.assertNotIn('--repair', run.call_args.args[0])
                marker = Path(directory) / 'Library/Caches/dev.ponyfactor.sweetiebot/installed-revision'
                self.assertEqual(marker.exists(), code == 0)
                self.assertEqual(execute.called, code != 0)

    def test_offline_update_still_repairs(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair, 'prepare_update', side_effect=OSError), patch.object(repair.os, 'execv') as execute:
            repair.repair([])
            execute.assert_called_once()
