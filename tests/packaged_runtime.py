"""Resolve imports from the actual rendered installer payload, not source paths."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import toolkit_settings
import workspace_search
import wrapper_dependencies


class PackagedRuntimeTests(unittest.TestCase):
    def test_all_git_wrapper_python_dependencies_are_packaged(self):
        runtime = wrapper_dependencies.runtime_sources(Path(__file__).resolve().parents[1] / "scripts")
        packaged = workspace_search.source_files()
        self.assertIn("toolkit_settings.py", runtime)
        for name, source in runtime.items():
            key = Path("codex-customizations/scripts") / name
            self.assertIn(key, packaged, name)
            self.assertEqual(packaged[key].read_bytes(), source.read_bytes())

    def test_installed_repair_payload_contains_cannon_and_stop_artwork(self):
        files = workspace_search.source_files()
        for name in ('activity-cannon.png', 'twi-stop.png'):
            key = Path('codex-customizations/assets/imgs') / name
            self.assertIn(key, files)
            self.assertTrue(files[key].read_bytes().startswith(b'\x89PNG\r\n\x1a\n'))

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
