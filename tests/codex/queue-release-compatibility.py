"""Regression coverage for the real-release compatibility CI entry point."""

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('queue_release_check', ROOT / 'scripts/ci/check-codex-queue-compatibility.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
from tests.codex.queued_edit import INLINE_STORE, ROWS


class QueueReleaseCompatibilityTests(unittest.TestCase):
    def fixture(self, directory, store=INLINE_STORE, rows=ROWS):
        extension = Path(directory) / 'extensions/openai.chatgpt-1.2.3'
        assets = extension / 'webview/assets'
        assets.mkdir(parents=True)
        (extension / 'package.json').write_text(json.dumps({
            'publisher': 'OpenAI', 'name': 'chatgpt', 'version': '1.2.3'}))
        (assets / 'native-store.js').write_text(store)
        (assets / 'native-rows.js').write_text(rows)
        return extension

    def run_probe(self, directory):
        report = Path(directory) / 'artifacts/report.json'
        with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
            result = probe.main(['--extensions-dir', str(Path(directory) / 'extensions'),
                                 '--channel', 'pre-release', '--report', str(report)])
        return result, json.loads(report.read_text())

    def test_real_bundle_contract_passes_without_changing_the_input(self):
        with TemporaryDirectory() as directory:
            extension = self.fixture(directory)
            before = {path: path.read_bytes() for path in extension.rglob('*') if path.is_file()}
            result, report = self.run_probe(directory)
            self.assertEqual(result, 0)
            self.assertEqual(report['status'], 'passed')
            self.assertEqual(report['version'], '1.2.3')
            self.assertEqual(report['channel'], 'pre-release')
            self.assertEqual({entry['adapter'] for entry in report['assets']}, {'store', 'rows'})
            self.assertTrue(all(len(entry['sha256']) == 64 for entry in report['assets']))
            self.assertTrue(all(path.read_bytes() == data for path, data in before.items()))

    def test_future_native_store_drift_is_a_failing_ci_check(self):
        with TemporaryDirectory() as directory:
            extension = self.fixture(directory, store=INLINE_STORE.replace('getTurnCoordinator()', 'changedCoordinator()'))
            before = (extension / 'webview/assets/native-store.js').read_bytes()
            result, report = self.run_probe(directory)
            self.assertEqual(result, 1)
            self.assertEqual(report['status'], 'failed')
            self.assertIn('Unsupported Codex queue', report['error'])
            self.assertEqual((extension / 'webview/assets/native-store.js').read_bytes(), before)

    def test_syntax_failure_is_reported_without_uploading_bundle_contents(self):
        with TemporaryDirectory() as directory:
            self.fixture(directory, rows=ROWS + ';const = "private diagnostic fixture";')
            result, report = self.run_probe(directory)
            self.assertEqual(result, 1)
            self.assertIn('invalid JavaScript', report['error'])
            self.assertNotIn('private diagnostic fixture', json.dumps(report))

    def test_missing_or_multiple_installs_never_silently_skip_checks(self):
        with TemporaryDirectory() as directory:
            result, report = self.run_probe(directory)
            self.assertEqual(result, 1)
            self.assertIn('exactly one', report['error'])
            self.fixture(directory)
            (Path(directory) / 'extensions/openai.chatgpt-other').mkdir()
            result, report = self.run_probe(directory)
            self.assertEqual(result, 1)
            self.assertIn('exactly one', report['error'])


if __name__ == '__main__':
    unittest.main()
