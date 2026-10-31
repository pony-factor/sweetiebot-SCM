"""Resolve imports from the actual rendered installer payload, not source paths."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import toolkit_settings
import workspace_search


class PackagedRuntimeTests(unittest.TestCase):
    def test_installed_repair_payload_contains_cannon_and_stop_artwork(self):
        files = workspace_search.source_files()
        for name in ('activity-cannon.png', 'twi-stop.png'):
            key = Path('codex-customizations/assets/imgs') / name
            self.assertIn(key, files)
            self.assertTrue(files[key].read_bytes().startswith(b'\x89PNG\r\n\x1a\n'))


    def test_installer_bundles_merge_dashboard_styles_for_install_and_repair(self):
        # Check the signed app payload as well as the extension's saved repair sources.
        import build_installer_app

        stylesheet = Path('extension/merge/header.css')
        bundled = build_installer_app.source_files()
        self.assertIn(stylesheet, bundled)

        with tempfile.TemporaryDirectory() as temporary:
            payload = Path(temporary)
            for relative, source in bundled.items():
                if relative.parts[0] != 'extension':
                    continue
                target = payload / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())

            extension_files = workspace_search.source_files(payload)
            for relative in (Path('merge/header.css'),
                             Path('codex-customizations') / stylesheet):
                self.assertIn(relative, extension_files)
                self.assertEqual(extension_files[relative].read_bytes(),
                                 bundled[stylesheet].read_bytes())

    def test_all_installed_relative_javascript_dependencies_resolve(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative, source in workspace_search.source_files().items():
                # Check the executable extension, not the bundled repair sources.
                if relative.parts[0] == 'codex-customizations':
                    continue
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(workspace_search.expected_bytes(relative, source, dict(toolkit_settings.DEFAULT_SETTINGS)))
            script = r'''
const fs = require('node:fs'), path = require('node:path'), {createRequire} = require('node:module');
const failures = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.js')) {
      const resolve = createRequire(file).resolve;
      for (const match of fs.readFileSync(file,'utf8').matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        try {resolve(match[1]);} catch {failures.push(path.relative(process.argv[1],file) + ' -> ' + match[1]);}
      }
    }
  }
}
walk(process.argv[1]);
if(failures.length) {console.error(failures.join('\n')); process.exitCode=1;}
'''
            result = subprocess.run(['node', '-e', script, str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
