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

    def test_every_runtime_extension_asset_is_in_both_installer_inventories(self):
        import build_installer_app
        import extension_assets

        runtime = extension_assets.runtime_files(workspace_search.SOURCE)
        signed = build_installer_app.source_files()
        repaired = workspace_search.source_files()
        for relative, source in runtime.items():
            self.assertEqual(signed[Path("extension") / relative], source)
            self.assertEqual(repaired[Path("codex-customizations/extension") / relative], source)
            self.assertIn(relative, repaired)
        self.assertEqual(
            {path.relative_to("extension") for path in signed
             if path.parts[0] == "extension"},
            set(runtime),
        )
        self.assertEqual(
            {path.relative_to("codex-customizations/extension") for path in repaired
             if path.parts[:2] == ("codex-customizations", "extension")},
            set(runtime),
        )

    def test_unknown_formats_are_packaged_and_temporary_files_excluded(self):
        import build_installer_app
        import extension_assets
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "extension"
            nested = source / "merge/future"
            nested.mkdir(parents=True)
            (nested / "renderer.wasm").write_bytes(b"runtime-data")
            (nested / "theme.woff2").write_bytes(b"font-data")
            (source / ".future-config").write_text("keep this")
            (source / ".DS_Store").write_bytes(b"junk")
            (nested / "renderer.js.swp").write_bytes(b"swap")
            (source / ".env.local").write_text("never package a local secret")
            cache = source / "__pycache__"
            cache.mkdir()
            (cache / "cached.pyc").write_bytes(b"cached")
            editor = source / ".vscode"
            editor.mkdir()
            (editor / "settings.json").write_text("{}")
            expected = {
                Path(".future-config"),
                Path("merge/future/renderer.wasm"),
                Path("merge/future/theme.woff2"),
            }
            self.assertEqual(set(extension_assets.runtime_files(source)), expected)
            with patch.object(build_installer_app, "ROOT", root):
                signed = build_installer_app.source_files()
            repaired = workspace_search.source_files(root)
            self.assertEqual(
                {path.relative_to("extension") for path in signed
                 if path.parts[0] == "extension"}, expected,
            )
            self.assertEqual(
                {path for path in repaired if path.parts[0] != "codex-customizations"
                 and path in expected}, expected,
            )
            self.assertEqual(
                {path.relative_to("codex-customizations/extension") for path in repaired
                 if path.parts[:2] == ("codex-customizations", "extension")},
                expected,
            )
            for relative in expected:
                self.assertEqual(signed[Path("extension") / relative].read_bytes(),
                                 (source / relative).read_bytes())
                self.assertEqual(repaired[relative].read_bytes(),
                                 (source / relative).read_bytes())

            external = root / "private.txt"
            external.write_text("outside")
            (source / "unexpected-link").symlink_to(external)
            with self.assertRaisesRegex(ValueError, "symlinked"):
                extension_assets.runtime_files(source)

    def test_signed_installer_rejects_a_missing_extension_manifest(self):
        import build_installer_app
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(build_installer_app, "ROOT", Path(directory)):
                with self.assertRaisesRegex(FileNotFoundError, "extension/package.json"):
                    build_installer_app.build(Path(directory) / "Installer.app")

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
