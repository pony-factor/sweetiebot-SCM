
import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

import toolkit_settings
import workspace_search
from wrapper_dependencies import runtime_sources


DEFAULTS = dict(toolkit_settings.DEFAULT_SETTINGS)


class WorkspaceSearchInstallerTests(unittest.TestCase):
    @staticmethod
    def install_wrapper_fixture(root):
        """Mirror the complete production Git wrapper dependency closure."""
        dependencies = runtime_sources(workspace_search.HERE)
        for name, source in dependencies.items():
            (root / name).write_bytes(source.read_bytes())
        # Keep the installed import alias finder with the hyphenated modules.
        assert (root / 'importaliases.py').is_file()
        assert (root / 'wrapper-dependencies.py').is_file()

    def test_pony_publisher_is_bundled_beside_background_worker(self):
        files = workspace_search.source_files()
        self.assertEqual(files[Path('pony-git-publish.js')].read_bytes(),
                         (Path(__file__).resolve().parent.parent.parent / 'extension/commits/pony-git-publish.js').read_bytes())

    def test_bundled_git_wrapper_can_switch_branches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.install_wrapper_fixture(root)
            repo = root / 'repo'
            repo.mkdir()
            subprocess.run(['/usr/bin/git', 'init', '--quiet', str(repo)], check=True)
            result = subprocess.run(
                [sys.executable, str(root / 'ai-commit.py'), 'checkout', '-b', 'branch-switch'],
                cwd=repo, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('Traceback', result.stderr)

    def test_completed_base_command_is_bundled_with_its_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.install_wrapper_fixture(root)
            subprocess.run(['/usr/bin/git', 'init', '-q', '-b', 'main', str(root)], check=True)
            subprocess.run(['/usr/bin/git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                            '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'initial'], cwd=root, check=True)
            result = subprocess.run([sys.executable, str(root / 'merged-branch.py'),
                                     '--completed-base', 'refs/heads/main'], cwd=root, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), subprocess.check_output(
                ['/usr/bin/git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip())

    def test_ludicrous_mode_is_only_in_magic_wand_settings(self):
        properties = workspace_search.render_package(DEFAULTS)["contributes"]["configuration"]["properties"]
        self.assertNotIn("sweetiebot.ludicrousMode", properties)
        self.assertNotIn("ludicrousMode", toolkit_settings.VSCODE_SETTINGS["vscodeSettings"])

    def test_pony_information_has_no_sidebar_view(self):
        for activity_bar in (False, True):
            package = workspace_search.render_package(dict(DEFAULTS, workspaceSearchActivityBar=activity_bar))
            views = [view for group in package["contributes"]["views"].values() for view in group]
            self.assertNotIn("sweetiebot.ponyInfo", [view["id"] for view in views])

    def test_saved_feature_preferences_reach_installed_defaults(self):
        settings = dict(DEFAULTS, autoPublishNewBranches=True, automaticBranchCleanup=False,
                        workspaceSearchAutoReindex=False, workspaceSearchMode="exact",
                        workspaceSearchResultLimit="35", workspaceSearchMaxFileSizeMB="2.5",
                        workspaceSearchPlaceholder="SATS")
        properties = workspace_search.render_package(settings)["contributes"]["configuration"]["properties"]
        self.assertTrue(properties["sweetiebot.autoPublishNewBranches"]["default"])
        self.assertFalse(properties["sweetiebot.automaticBranchCleanup"]["default"])
        self.assertFalse(properties["sweetiebot.workspaceSearch.autoReindex"]["default"])
        self.assertEqual(properties["sweetiebot.workspaceSearch.mode"]["default"], "exact")
        self.assertEqual(properties["sweetiebot.workspaceSearch.placeholder"]["default"], "SATS")
        self.assertEqual(properties["sweetiebot.workspaceSearch.resultLimit"]["default"], 35)
        self.assertEqual(properties["sweetiebot.workspaceSearch.maxFileSizeMB"]["default"], 2.5)

    def test_embedding_selection_reaches_installed_manifest(self):
        package = workspace_search.render_package(dict(DEFAULTS, workspaceSearchEmbeddingModel="custom:embed"))
        self.assertEqual(package["contributes"]["configuration"]["properties"]["sweetiebot.workspaceSearch.embeddingModel"]["default"], "custom:embed")

    def test_extension_registers_settings_launcher(self):
        package = json.loads((workspace_search.SOURCE / "package.json").read_text())
        command_ids = {command["command"] for command in package["contributes"]["commands"]}

        self.assertIn("onCommand:sweetiebot.openSettings", package["activationEvents"])
        self.assertIn("sweetiebot.openSettings", command_ids)
        self.assertIn("sweetiebot.chatgpt.searchRepositories", command_ids)
        self.assertIn(
            "onCommand:sweetiebot.chatgpt.searchRepositories",
            package["activationEvents"],
        )
        self.assertIn(
            "vscode.commands.registerCommand('sweetiebot.openSettings'",
            (workspace_search.SOURCE / "extension.js").read_text(),
        )

    def test_extension_uses_sweetiebot_identity(self):
        package = json.loads((workspace_search.SOURCE / "package.json").read_text())

        self.assertEqual(package["publisher"], "pony-factor")
        self.assertEqual(package["name"], "sweetiebot-scm")
        with tempfile.TemporaryDirectory() as tmp:
            destination = workspace_search.extension_destination(Path(tmp))
        self.assertEqual(
            destination.name,
            f"pony-factor.sweetiebot-scm-{package['version']}",
        )

    def test_workspace_search_reindexes_automatically(self):
        package = json.loads((workspace_search.SOURCE / "package.json").read_text())
        command_ids = {command["command"] for command in package["contributes"]["commands"]}
        extension = (workspace_search.SOURCE / "extension.js").read_text()

        self.assertIn("onStartupFinished", package["activationEvents"])
        self.assertNotIn(
            "onCommand:sweetiebot.workspaceSearch.reindex",
            package["activationEvents"],
        )
        self.assertNotIn("sweetiebot.workspaceSearch.reindex", command_ids)
        self.assertIn("const INDEX_SYNC_INTERVAL_MS = 2 * 60 * 1000;", extension)
        self.assertIn("void index.load().then(() => index.refresh())", extension)
        self.assertNotIn("index.refresh({ force: true })", extension)
        self.assertNotIn(
            "registerCommand('sweetiebot.workspaceSearch.reindex'",
            extension,
        )
        view = (workspace_search.SOURCE / "search" / "view.js").read_text()
        search_index = (workspace_search.SOURCE / "search" / "index.js").read_text()
        ollama = (workspace_search.SOURCE / "search" / "ollama.js").read_text()
        self.assertNotIn("Reindex", view)
        self.assertNotIn("type:'reindex'", view)
        self.assertNotIn("this.index.dirty.size", view)
        self.assertIn("if (this.dirty.size) void this.refresh().then(() => {", search_index)
        self.assertIn("keep_alive: '30m'", ollama)

    def test_default_manifest_stays_in_source_control(self):
        package = workspace_search.render_package(DEFAULTS)

        self.assertFalse(DEFAULTS["workspaceSearchActivityBar"])
        self.assertEqual(list(package["contributes"]["views"]), ["scm"])
        self.assertNotIn("viewsContainers", package["contributes"])
        self.assertEqual(package["contributes"]["views"]["scm"][0]["name"], "EFS")
        properties = package["contributes"]["configuration"]["properties"]
        self.assertEqual(DEFAULTS["workspaceSearchPlaceholder"], "Search your workspace…")
        self.assertFalse(DEFAULTS["workspaceSearchAskOllama"])
        self.assertFalse(properties["sweetiebot.workspaceSearch.askOllama"]["default"])
        self.assertEqual(properties["sweetiebot.workspaceSearch.chatModel"]["default"], "")

    def test_ask_ollama_manifest_requires_opt_in_model(self):
        settings = dict(
            DEFAULTS,
            workspaceSearchAskOllama=True,
            workspaceSearchChatModel="qwen3:8b",
        )
        package = workspace_search.render_package(settings)
        properties = package["contributes"]["configuration"]["properties"]

        self.assertTrue(properties["sweetiebot.workspaceSearch.askOllama"]["default"])
        self.assertEqual(properties["sweetiebot.workspaceSearch.chatModel"]["default"], "qwen3:8b")
        view = (workspace_search.SOURCE / "search" / "view.js").read_text()
        self.assertIn("if (this.getSettings().askOllama) await this.askOllama()", view)
        self.assertIn("const askButton = askEnabled", view)
        self.assertNotIn("resolveChatModel", view)

    def test_standalone_manifest_uses_activity_bar_and_efs_label(self):
        settings = dict(DEFAULTS, workspaceSearchActivityBar=True)
        package = workspace_search.render_package(settings)
        container = package["contributes"]["viewsContainers"]["activitybar"][0]

        self.assertEqual(DEFAULTS["workspaceSearchLabel"], "EFS")
        self.assertEqual(container["id"], workspace_search.STANDALONE_CONTAINER_ID)
        self.assertRegex(container["id"], r"^[A-Za-z0-9_-]+$")
        self.assertEqual(container["title"], "EFS")
        self.assertEqual(container["icon"], "media/efs.svg")
        self.assertEqual(
            list(package["contributes"]["views"]),
            [workspace_search.STANDALONE_CONTAINER_ID, "scm"],
        )


    def test_standalone_activity_bar_icon_is_upright(self):
        icon_path = workspace_search.HERE.parent / "assets/imgs/efs.svg"
        icon = ET.fromstring(icon_path.read_text())
        self.assertFalse(
            any("rotate(" in element.attrib.get("transform", "") for element in icon.iter()),
            "The Activity Bar icon should remain upright even if other EFS artwork is tilted.",
        )
        # The installer is generated; its assets must come from source files.
        import build_installer_app

        image_root = workspace_search.HERE.parent / "assets/imgs"
        for name, relative_path in workspace_search.IMAGE_SOURCES.items():
            source = image_root / relative_path
            self.assertTrue(source.is_file(), name)
            self.assertEqual(workspace_search.source_files()[Path("media") / name], source)
            self.assertEqual(
                build_installer_app.source_files()[Path("assets/imgs") / relative_path],
                source,
            )
            # Retain the checked-in extension media mirrors for development use.
            self.assertEqual((workspace_search.SOURCE / "media" / name).read_bytes(), source.read_bytes())
        readme = workspace_search.SOURCE / "README.md"
        self.assertEqual(workspace_search.source_files()[Path("README.md")], readme)
        self.assertIn("## Credits", readme.read_text())
        self.assertIn("The Overmare Studios", readme.read_text())
        self.assertIn("CaptainPudgeMuffin", readme.read_text())
        self.assertEqual(
            build_installer_app.source_files()[Path("assets/imgs/README.md")],
            image_root / "README.md",
        )

    def test_standalone_manifest_uses_custom_label(self):
        settings = dict(
            DEFAULTS,
            workspaceSearchActivityBar=True,
            workspaceSearchLabel="Research",
        )
        package = workspace_search.render_package(settings)

        self.assertEqual(
            package["contributes"]["viewsContainers"]["activitybar"][0]["title"],
            "Research",
        )
        view = package["contributes"]["views"][workspace_search.STANDALONE_CONTAINER_ID][0]
        self.assertEqual(view["name"], "Research")
        self.assertEqual(view["contextualTitle"], "Research")

    def test_extension_stylesheets_survive_installer_and_repair_bundles(self):
        import build_installer_app
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stylesheet = root / "extension/merge/header.css"
            stylesheet.parent.mkdir(parents=True)
            stylesheet.write_text(".merge-header { display: flex; }\n")
            files = workspace_search.source_files(root)
            self.assertEqual(files[Path("merge/header.css")], stylesheet)
            self.assertEqual(
                files[Path("codex-customizations/extension/merge/header.css")], stylesheet)
            with patch.object(build_installer_app, "ROOT", root):
                self.assertEqual(
                    build_installer_app.source_files()[Path("extension/merge/header.css")],
                    stylesheet)

    def test_chromium_ci_uses_one_latest_runner(self):
        workflow = (Path(__file__).resolve().parent.parent.parent / ".github/workflows/check.yml").read_text()
        browser = workflow.split("  codex-webview-browser:\n", 1)[1].split("\n  bot-app-identities:", 1)[0]
        self.assertEqual(browser.count("runs-on: ubuntu-latest"), 1)
        self.assertNotIn("matrix:", browser)
        self.assertNotIn("ubuntu-24.04", browser)
        self.assertNotIn("ubuntu-26.04", browser)
        self.assertRegex(browser, r"python -m pip install playwright(?:==[0-9.]+)?")
        self.assertIn("python -m playwright install --with-deps chromium", browser)

    def test_installs_exact_extension_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = workspace_search.extension_destination(root)

            self.assertTrue(
                workspace_search.sync_extension(
                    check=True,
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertFalse(destination.exists())
            self.assertTrue(
                workspace_search.sync_extension(
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertTrue(
                workspace_search.destination_matches(
                    destination,
                    settings=DEFAULTS,
                )
            )
            self.assertTrue((destination / "configurator.py").is_file())
            self.assertTrue((destination / "codex-sticker.py").is_file())
            self.assertTrue((destination / "codex-button-icon.py").is_file())
            self.assertTrue((destination / "commit-hotkey.py").is_file())
            self.assertTrue((destination / "toolkit-settings.py").is_file())
            # Run outside the source tree so missing packaged imports cannot
            # resolve through the test runner's scripts path.
            result = subprocess.run(
                [sys.executable, "-E", "-s", "-B", str(destination / "configurator.py"), "--help"],
                cwd=tmp, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            icon = subprocess.run(
                [sys.executable, "-E", "-s", "-B", "-c",
                 "import sys; sys.path.insert(0, sys.argv[1]); "
                 "import importaliases; importaliases.install(); "
                 "import codex_button_icon; "
                 "assert codex_button_icon.icon_data_url().startswith('data:image/png;base64,')",
                 str(destination)],
                cwd=tmp, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(icon.returncode, 0, icon.stderr)
            self.assertTrue((destination / "branch-names.py").is_file())
            self.assertTrue((destination / "branch-name-packs.json").is_file())
            self.assertTrue((destination / "local-setup.py").is_file())
            self.assertFalse((destination / "chatgpt_integration.py").exists())
            for name, relative_path in workspace_search.IMAGE_SOURCES.items():
                self.assertEqual(
                    (destination / "media" / name).read_bytes(),
                    (workspace_search.HERE.parent / "assets/imgs" / relative_path).read_bytes(),
                )
            self.assertEqual(
                (destination / "README.md").read_bytes(),
                (workspace_search.SOURCE / "README.md").read_bytes(),
            )
            self.assertFalse(
                workspace_search.sync_extension(
                    check=True,
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )

    def test_installed_tree_matches_all_runtime_sources_including_unknown_formats(self):
        import shutil
        import extension_assets
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sources/extension"
            shutil.copytree(workspace_search.SOURCE, source)
            nested = source / "merge/deeply/nested"
            nested.mkdir(parents=True)
            (nested / "view.wasm").write_bytes(b"arbitrary runtime asset")
            (source / ".DS_Store").write_bytes(b"unwanted metadata")
            junk = source / "__pycache__"
            junk.mkdir()
            (junk / "local.pyc").write_bytes(b"temporary")
            installed_root = root / "installed"
            with patch.object(workspace_search, "SOURCE", source):
                self.assertTrue(workspace_search.sync_extension(
                    extensions_dir=installed_root, settings=DEFAULTS))
                destination = workspace_search.extension_destination(installed_root)
                sources = workspace_search.source_files()
                runtime = extension_assets.runtime_files(source)
                actual = {
                    path.relative_to(destination)
                    for path in destination.rglob("*") if path.is_file()
                }
                # Compare the entire actual install with the expected managed
                # inventory (including generated package defaults and icons).
                self.assertEqual(actual, set(sources))
                for relative, source_path in sources.items():
                    self.assertEqual(
                        (destination / relative).read_bytes(),
                        workspace_search.expected_bytes(relative, source_path, DEFAULTS),
                    )
                # Every nonexcluded runtime source must be present; new file
                # extensions cannot disappear just because an allowlist is stale.
                self.assertTrue(set(runtime).issubset(actual))
                self.assertEqual((destination / "merge/deeply/nested/view.wasm").read_bytes(),
                                 b"arbitrary runtime asset")
                self.assertFalse((destination / ".DS_Store").exists())
                self.assertFalse((destination / "__pycache__").exists())
                self.assertTrue(workspace_search.destination_matches(
                    destination, settings=DEFAULTS))

    def test_python_bytecode_caches_do_not_reinstall_extension(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = workspace_search.extension_destination(root)
            workspace_search.sync_extension(extensions_dir=root, settings=DEFAULTS)
            cache = destination / '__pycache__'
            cache.mkdir()
            (cache / 'configurator.cpython-313.pyc').write_bytes(b'generated')
            (destination / 'configurator.pyo').write_bytes(b'generated')
            self.assertTrue(workspace_search.destination_matches(destination, settings=DEFAULTS))
            self.assertFalse(workspace_search.sync_extension(
                check=True, extensions_dir=root, settings=DEFAULTS
            ))
            self.assertTrue(cache.exists(), 'a no-op check must preserve generated files')

            (destination / 'configurator.py').write_text('# stale managed code')
            self.assertFalse(workspace_search.destination_matches(destination, settings=DEFAULTS))
            self.assertTrue(workspace_search.sync_extension(
                check=True, extensions_dir=root, settings=DEFAULTS
            ))
            self.assertTrue(workspace_search.sync_extension(
                extensions_dir=root, settings=DEFAULTS
            ))
            self.assertTrue(workspace_search.destination_matches(destination, settings=DEFAULTS))

    def test_settings_server_does_not_write_python_bytecode(self):
        extension = (workspace_search.SOURCE / 'extension.js').read_text()
        self.assertIn("PYTHONDONTWRITEBYTECODE: '1'", extension)

    def test_setting_change_marks_extension_for_update(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            destination = workspace_search.extension_destination(root)
            workspace_search.sync_extension(
                extensions_dir=root,
                settings=DEFAULTS,
            )

            standalone = dict(DEFAULTS, workspaceSearchActivityBar=True)
            self.assertFalse(
                workspace_search.destination_matches(
                    destination,
                    settings=standalone,
                )
            )
            self.assertTrue(
                workspace_search.sync_extension(
                    check=True,
                    extensions_dir=root,
                    settings=standalone,
                )
            )

    def test_removes_installed_extension(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace_search.sync_extension(
                extensions_dir=root,
                settings=DEFAULTS,
            )
            self.assertTrue(
                workspace_search.sync_extension(
                    remove=True,
                    check=True,
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertTrue(
                workspace_search.sync_extension(
                    remove=True,
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertEqual(workspace_search.installed_versions(root), [])

    def test_upgrade_removes_stale_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "jfwooten4.scm-toolkit-workspace-search-0.0.1"
            stale.mkdir(parents=True)
            (stale / "old.txt").write_text("old")
            registry = root / "extensions.json"
            unrelated = {"identifier": {"id": "other.extension"}, "version": "1.2"}
            current = {"identifier": {"id": workspace_search.extension_identity()}}
            registry.write_text(json.dumps([
                unrelated, current,
                {"identifier": {"id": "jfwooten4.scm-toolkit-workspace-search"}},
            ]))
            self.assertTrue(workspace_search.remove_legacy_extensions(root, check=True))
            self.assertTrue(stale.exists(), "Check mode must preserve installation")

            self.assertTrue(
                workspace_search.sync_extension(
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertFalse(stale.exists())
            self.assertEqual(json.loads(registry.read_text()), [unrelated, current])
            self.assertFalse(workspace_search.remove_legacy_extensions(root, check=True))
            self.assertTrue(
                workspace_search.destination_matches(
                    workspace_search.extension_destination(root),
                    settings=DEFAULTS,
                )
            )


if __name__ == "__main__":
    unittest.main()
