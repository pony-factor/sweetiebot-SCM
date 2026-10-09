import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import update


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as files:
        for name, contents in entries.items():
            info = tarfile.TarInfo(name)
            data = contents.encode()
            info.size = len(data)
            files.addfile(info, io.BytesIO(data))
        link = tarfile.TarInfo('scripts/link.py')
        link.type, link.linkname = tarfile.SYMTYPE, '/outside'
        files.addfile(link)
    return output.getvalue()


class UpdateTests(unittest.TestCase):
    def test_extract_only_distribution_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            update.extract_sources(archive({'scripts/update.py': 'ok', '../escape.py': 'bad',
                                           'scripts/config.env': 'excluded', 'README.md': 'excluded',
                                           'assets/browser/pull_request_submit.js': 'browser'}), root)
            self.assertEqual([p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()],
                             ['scripts/update.py', 'assets/browser/pull_request_submit.js'])
            self.assertFalse((root / 'scripts/link.py').exists())

    def test_updates_use_sources_without_a_generated_installer_app(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            update.extract_sources(archive({
                'scripts/branch_name_packs.json': '{"version": 1}',
                'Sweetiebot Installer.app/Contents/Resources/toolkit/scripts/branch_name_packs.json': 'stale',
            }), root)
            self.assertEqual(
                (root / 'scripts/branch_name_packs.json').read_text(),
                '{"version": 1}',
            )
            self.assertFalse((root / 'Sweetiebot Installer.app').exists())

    def test_skip_old_bootstrap(self):
        for supports_updates in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                payload = {'scripts/install.py': 'installer'}
                if supports_updates:
                    payload['scripts/update.py'] = 'updater'
                    payload['scripts/repair.py'] = 'repair'
                with patch.object(update, 'git', side_effect=[b'', b'', b'abc\n', archive(payload)]):
                    result = update.prepare_update(root)
                self.assertEqual(result is not None, supports_updates)

    def test_same_revision_repairs_missing_or_stale_installed_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache, extensions = root / 'cache', root / 'extensions'
            cache.mkdir()
            (cache / 'upstream.git').mkdir()
            (cache / 'installed-revision').write_text('abc\n')
            payload = {
                'scripts/install.py': 'installer', 'scripts/update.py': 'updater',
                'scripts/repair.py': 'repair', 'scripts/codex_composer.py': 'new placeholders',
                'efs/package.json': '{"publisher":"pony-factor","name":"sweetiebot-scm","version":"0.3.2"}',
            }
            installed = extensions / 'pony-factor.sweetiebot-scm-0.3.2/codex-customizations'

            def prepare():
                with patch.object(update, 'git', side_effect=[b'', b'abc\n', archive(payload)]):
                    return update.prepare_update(cache, extensions)

            self.assertIsNotNone(prepare())
            update.extract_sources(archive(payload), installed)
            self.assertIsNone(prepare())
            (installed / 'scripts/codex_composer.py').write_text('old composer')
            self.assertIsNotNone(prepare())
            (installed / 'scripts/codex_composer.py').unlink()
            self.assertIsNotNone(prepare())
