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
            extension = stack.enter_context(patch.object(workspace_search, 'sync_extension'))
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

    def test_busy_lock_skips_repair(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair.fcntl, 'flock', side_effect=BlockingIOError), patch.object(repair.os, 'execv') as execute:
            self.assertEqual(repair.repair([]), 0)
            execute.assert_not_called()

    def test_exec_keeps_lock_and_passes_custom_app_path(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)), \
                patch.object(repair.os, 'set_inheritable') as inherit, patch.object(repair.os, 'execv') as execute:
            repair.repair(['--app', '/Custom/Code.app'])
            inherit.assert_called_once()
            self.assertTrue(inherit.call_args.args[1])
            self.assertEqual(execute.call_args.args[1][-3:], ['--repair', '--app', '/Custom/Code.app'])
