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
    def test_draft_confirmation_survives_update_and_installer_packaging(self):
        import build_installer_app
        import subprocess
        asset = Path('efs/draft_confirmation.html')
        module = Path('efs/draft_handoff.js')
        repo = Path(update.__file__).resolve().parent.parent
        entries = {path.as_posix(): (repo / path).read_text() for path in (asset, module)}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            update.extract_sources(archive(entries), root)
            self.assertEqual((root / asset).read_text(), entries[asset.as_posix()])
            bundled = update.source_files(root)
            self.assertEqual(bundled[Path('codex-customizations') / asset], root / asset)
            self.assertIn(asset, build_installer_app.source_files())
            result = subprocess.run(['node', '-e', 'require(process.argv[1])', str(root / module)],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_github_reaction_asset_survives_update_and_bundled_repair(self):
        asset = Path('assets/github/pr_reaction_hover.js')
        contents = (Path(update.__file__).resolve().parent.parent / asset).read_text()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            update.extract_sources(archive({asset.as_posix(): contents}), root)
            self.assertEqual((root / asset).read_text(), contents)
            bundled = update.source_files(root)
            self.assertEqual(bundled[Path('codex-customizations') / asset], root / asset)

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

    def test_pr_release_cannot_reinstall_a_bootstrap_that_drops_html(self):
        for broken in ('update.py', 'workspace_search.py', 'asset', None):
            with self.subTest(broken=broken), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'upstream.git').mkdir()
                payload = {
                    'scripts/install.py': 'installer', 'scripts/repair.py': 'repair',
                    'scripts/update.py': 'FORMATS = {"efs": {".js", ".html"}}',
                    'scripts/workspace_search.py': 'FORMATS = {"efs": {".js", ".html"}}',
                    'efs/draft_handoff.js': 'handoff',
                    'efs/draft_confirmation.html': '<html>confirmation</html>',
                }
                if broken == 'asset':
                    del payload['efs/draft_confirmation.html']
                elif broken:
                    payload['scripts/' + broken] = 'FORMATS = {"efs": {".js"}}'
                with patch.object(update, 'git', side_effect=[b'', b'abc\n', archive(payload)]):
                    result = update.prepare_update(root)
                self.assertEqual(result is not None, broken is None)

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
                'scripts/ai_commit.py': 'current Git wrapper',
                'scripts/sweetiebot_async_commit.py': 'current async helper',
                'scripts/post_commit_spellcheck.py': 'current spellcheck helper',
                'efs/post_commit_spellcheck_notice.js': 'current notice handler',
                'efs/package.json': '{"publisher":"pony-factor","name":"sweetiebot-scm","version":"0.3.2"}',
            }
            destination = extensions / 'pony-factor.sweetiebot-scm-0.3.2'
            installed = destination / 'codex-customizations'
            wrapper = root / 'bin/scm-toolkit-git'
            helper = wrapper.with_name(wrapper.name + '-spellcheck.py')

            def prepare(force=False):
                with patch.object(update, 'git', side_effect=[b'', b'abc\n', archive(payload)]), patch.dict(update.os.environ, {'SCM_TOOLKIT_AI_WRAPPER_PATH': str(wrapper)}), patch.object(Path, 'home', return_value=root):
                    return update.prepare_update(cache, extensions, force=force)

            self.assertIsNotNone(prepare())
            update.extract_sources(archive(payload), installed)
            # Matching bundle metadata is insufficient without active runtime files.
            self.assertIsNotNone(prepare())
            for relative, source in update.source_files(cache / 'candidate').items():
                if source.is_file():
                    target = destination / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.read_bytes())
            wrapper.parent.mkdir()
            wrapper.write_text(payload['scripts/ai_commit.py'])
            helper.write_text(payload['scripts/post_commit_spellcheck.py'])
            wrapper.chmod(0o755)
            helper.chmod(0o755)
            async_helper = wrapper.with_name('sweetiebot_async_commit.py')
            self.assertIsNotNone(prepare())
            async_helper.write_text(payload['scripts/sweetiebot_async_commit.py'])
            async_helper.chmod(0o755)
            self.assertIsNone(prepare())
            legacy = root / '.local/bin/git-auto-title'
            legacy.parent.mkdir(parents=True)
            legacy.write_text('old standalone wrapper')
            self.assertIsNotNone(prepare())
            legacy.unlink()
            legacy.symlink_to(wrapper)
            self.assertIsNotNone(prepare())
            legacy.with_name(legacy.name + '-spellcheck.py').symlink_to(helper)
            self.assertIsNone(prepare())
            for target in [destination / 'post_commit_spellcheck_notice.js', destination / 'ai_commit.py', wrapper, helper, async_helper]:
                expected = target.read_bytes()
                target.write_text('stale runtime')
                self.assertIsNotNone(prepare())
                target.write_bytes(expected)
                self.assertIsNone(prepare())
            helper.chmod(0o644)
            self.assertIsNotNone(prepare())
            helper.chmod(0o755)
            self.assertIsNone(prepare())
            self.assertIsNotNone(prepare(force=True))
            (installed / 'scripts/codex_composer.py').write_text('old composer')
            self.assertIsNotNone(prepare())
            (installed / 'scripts/codex_composer.py').unlink()
            self.assertIsNotNone(prepare())
