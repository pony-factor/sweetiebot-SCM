import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

import github_apps
import github_apps_ui


class AppSettingsTests(unittest.TestCase):
    def test_gui_path_uses_homebrew_node_for_pem_validation(self):
        # This test exercises the Finder PATH fallback on a Linux CI runner.
        # Simulate macOS so the real Keychain-only guard remains in production.
        with patch.object(github_apps.sys, 'platform', 'darwin'), \
                patch.object(github_apps.shutil, 'which', return_value=None), \
                patch.object(Path, 'is_file', return_value=True), \
                patch.object(github_apps.os, 'access', return_value=True), \
                patch.object(github_apps.subprocess, 'run', return_value=Mock(returncode=1)) as run, \
                patch.object(github_apps.ctypes, 'CDLL') as native:
            with self.assertRaisesRegex(ValueError, 'valid RSA'):
                github_apps.store_key('kefania', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')
        self.assertEqual(run.call_args.args[0][0], '/opt/homebrew/bin/node')
        self.assertNotIn('AAAA', ' '.join(run.call_args.args[0]))
        native.assert_not_called()

    def test_node_failures_are_actionable_and_do_not_expose_input(self):
        with patch.object(github_apps.shutil, 'which', return_value=None), \
                patch.object(Path, 'is_file', return_value=False), \
                patch.object(github_apps.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'Node.js was not found'):
                github_apps.run_node('test')
        run.assert_not_called()
        for failure in (OSError('private-test-material'),
                        subprocess.TimeoutExpired('node', 10, output='private-test-material')):
            with self.subTest(failure=type(failure).__name__), \
                    patch.object(github_apps.shutil, 'which', return_value='/node'), \
                    patch.object(github_apps.subprocess, 'run', side_effect=failure):
                with self.assertRaises(RuntimeError) as caught:
                    github_apps.run_node('test')
                self.assertNotIn('private-test-material', str(caught.exception))

    def test_connection_uses_source_and_installed_module_layouts(self):
        for layout in ('extension/github/app_identity.js', 'scripts/github/app_identity.js',
                       'scripts/github_app_identity.js'):
            with self.subTest(layout=layout), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                module = root / layout
                module.parent.mkdir(parents=True)
                module.touch()
                with patch.object(github_apps, '__file__', str(root / 'scripts/github_apps.py')), \
                        patch.object(github_apps, 'run_node', return_value=Mock(
                            returncode=0, stdout='{"login":"kefania-pony[bot]"}')) as run:
                    result = github_apps.check_connection('kefania', 'owner/repo')
                self.assertEqual(run.call_args.args[1], str(module.resolve()))
                self.assertIn('Connected as kefania-pony[bot]', result['message'])

    def test_public_status_never_accesses_keychain(self):
        with patch.object(github_apps, 'git_setting', return_value=''), \
                patch.object(github_apps.ctypes, 'CDLL') as native:
            status = github_apps.app_status()
        native.assert_not_called()
        self.assertEqual(status['mode'], 'legacy')
        self.assertEqual(status['apps']['kefania']['slug'], 'kefania-pony')
        self.assertEqual(status['apps']['kefania']['id'], '5436431')
        self.assertEqual(status['apps']['lindsey']['id'], '5436447')
        self.assertNotIn('key', status['apps']['kefania'])

    def test_default_ids_preserve_saved_ids_and_custom_apps(self):
        settings = {'kefania-app-id': '1234', 'lindsey-app-slug': 'custom-lindsey'}
        with patch.object(github_apps, 'git_setting', side_effect=lambda name: settings.get(name, '')):
            status = github_apps.app_status()
        self.assertEqual(status['apps']['kefania']['id'], '1234')
        self.assertEqual(status['apps']['lindsey']['slug'], 'custom-lindsey')
        self.assertEqual(status['apps']['lindsey']['id'], '')

    def test_private_key_never_saved_in_git_configuration(self):
        settings = {}

        def config(name, value=None):
            if value is not None:
                settings[name] = value
            return settings.get(name, '')

        with patch.object(github_apps, 'git_setting', side_effect=config), \
                patch.object(github_apps, 'store_key') as store:
            result = github_apps.save_app({'role': ['kefania'], 'id': ['1234'],
                'slug': ['kefania-pony'], 'key': ['private-test-material']})
        store.assert_called_once_with('kefania', 'private-test-material')
        self.assertNotIn('private-test-material', json.dumps(settings))
        self.assertNotIn('private-test-material', json.dumps(result))
        self.assertTrue(result['apps']['kefania']['keyStored'])

    def test_keychain_failure_prevents_public_configuration_changes(self):
        with patch.object(github_apps, 'store_key', side_effect=RuntimeError('Locked')), \
                patch.object(github_apps, 'git_setting') as config:
            with self.assertRaisesRegex(RuntimeError, 'Locked'):
                github_apps.save_app({'role': ['lindsey'], 'id': ['1234'],
                    'slug': ['lindsey-pony'], 'key': ['test-key']})
        config.assert_not_called()

    def test_enable_requires_both_saved_credentials(self):
        with patch.object(github_apps, 'git_setting', return_value='') as config:
            with self.assertRaisesRegex(ValueError, 'both App IDs'):
                github_apps.save_mode('separate-apps')
        self.assertTrue(all(len(call.args) == 1 for call in config.call_args_list))

    def test_invalid_role_and_repository_do_not_start_runner(self):
        with patch.object(github_apps.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                github_apps.check_connection('other', 'owner/repo')
            with self.assertRaises(ValueError):
                github_apps.check_connection('lindsey', '../repo')
        run.assert_not_called()

    def test_connection_failure_does_not_return_subprocess_stderr(self):
        with patch.object(github_apps.subprocess, 'run', return_value=Mock(
                returncode=1, stdout='', stderr='private-test-material')):
            with self.assertRaises(RuntimeError) as failure:
                github_apps.check_connection('kefania', 'owner/repo')
        self.assertNotIn('private-test-material', str(failure.exception))

    def test_credential_controls_have_no_autosave_names(self):
        self.assertNotIn('name=', github_apps_ui.APP_PANEL)
        self.assertNotIn('name=', github_apps_ui.APP_SCRIPT)
        self.assertNotIn('localStorage', github_apps_ui.APP_SCRIPT)


if __name__ == '__main__':
    unittest.main()
