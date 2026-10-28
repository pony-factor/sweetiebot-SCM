import json
import unittest
from unittest.mock import patch, Mock

import github_apps
import github_apps_ui


class AppSettingsTests(unittest.TestCase):
    def test_public_status_never_accesses_keychain(self):
        with patch.object(github_apps, 'git_setting', return_value=''), \
                patch.object(github_apps.ctypes, 'CDLL') as native:
            status = github_apps.app_status()
        native.assert_not_called()
        self.assertEqual(status['mode'], 'legacy')
        self.assertEqual(status['apps']['kefania']['slug'], 'kefania-pony')
        self.assertNotIn('key', status['apps']['kefania'])

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
