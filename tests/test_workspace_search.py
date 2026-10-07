from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest

import toolkit_settings
import workspace_search


DEFAULTS = dict(toolkit_settings.DEFAULT_SETTINGS)


class WorkspaceSearchInstallerTests(unittest.TestCase):
    def test_saved_feature_preferences_reach_installed_defaults(self):
        settings = dict(DEFAULTS, autoPublishNewBranches=True, automaticBranchCleanup=False,
                        workspaceSearchAutoReindex=False, workspaceSearchMode="exact",
                        workspaceSearchResultLimit="35", workspaceSearchMaxFileSizeMB="2.5")
        properties = workspace_search.render_package(settings)["contributes"]["configuration"]["properties"]
        self.assertTrue(properties["scmToolkit.autoPublishNewBranches"]["default"])
        self.assertFalse(properties["scmToolkit.automaticBranchCleanup"]["default"])
        self.assertFalse(properties["scmToolkit.workspaceSearch.autoReindex"]["default"])
        self.assertEqual(properties["scmToolkit.workspaceSearch.mode"]["default"], "exact")
        self.assertEqual(properties["scmToolkit.workspaceSearch.resultLimit"]["default"], 35)
        self.assertEqual(properties["scmToolkit.workspaceSearch.maxFileSizeMB"]["default"], 2.5)

    def test_embedding_selection_reaches_installed_manifest(self):
        package = workspace_search.render_package(dict(DEFAULTS, workspaceSearchEmbeddingModel="custom:embed"))
        self.assertEqual(package["contributes"]["configuration"]["properties"]["scmToolkit.workspaceSearch.embeddingModel"]["default"], "custom:embed")

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

    def test_workspace_search_reindexes_automatically(self):
        package = json.loads((workspace_search.SOURCE / "package.json").read_text())
        command_ids = {command["command"] for command in package["contributes"]["commands"]}
        extension = (workspace_search.SOURCE / "extension.js").read_text()

        self.assertIn("onStartupFinished", package["activationEvents"])
        self.assertNotIn(
            "onCommand:scmToolkit.workspaceSearch.reindex",
            package["activationEvents"],
        )
        self.assertNotIn("scmToolkit.workspaceSearch.reindex", command_ids)
        self.assertIn("const INDEX_SYNC_INTERVAL_MS = 2 * 60 * 1000;", extension)
        self.assertIn("void index.load().then(() => index.refresh())", extension)
        self.assertNotIn("index.refresh({ force: true })", extension)
        self.assertNotIn(
            "registerCommand('scmToolkit.workspaceSearch.reindex'",
            extension,
        )
        view = (workspace_search.SOURCE / "view.js").read_text()
        search_index = (workspace_search.SOURCE / "search_index.js").read_text()
        ollama = (workspace_search.SOURCE / "ollama.js").read_text()
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
        self.assertFalse(DEFAULTS["workspaceSearchAskOllama"])
        self.assertFalse(properties["scmToolkit.workspaceSearch.askOllama"]["default"])
        self.assertEqual(properties["scmToolkit.workspaceSearch.chatModel"]["default"], "")

    def test_ask_ollama_manifest_requires_opt_in_model(self):
        settings = dict(
            DEFAULTS,
            workspaceSearchAskOllama=True,
            workspaceSearchChatModel="qwen3:8b",
        )
        package = workspace_search.render_package(settings)
        properties = package["contributes"]["configuration"]["properties"]

        self.assertTrue(properties["scmToolkit.workspaceSearch.askOllama"]["default"])
        self.assertEqual(properties["scmToolkit.workspaceSearch.chatModel"]["default"], "qwen3:8b")
        view = (workspace_search.SOURCE / "view.js").read_text()
        self.assertIn("if (this.getSettings().askOllama) await this.askOllama()", view)
        self.assertIn("const askButton = askEnabled", view)
        self.assertNotIn("resolveChatModel", view)

    def test_standalone_manifest_uses_activity_bar_and_efs_label(self):
        settings = dict(DEFAULTS, workspaceSearchActivityBar=True)
        package = workspace_search.render_package(settings)
        container = package["contributes"]["viewsContainers"]["activitybar"][0]

        self.assertEqual(DEFAULTS["workspaceSearchLabel"], "EFS")
        self.assertEqual(container["id"], workspace_search.STANDALONE_CONTAINER_ID)
        self.assertEqual(container["title"], "EFS")
        self.assertEqual(container["icon"], "media/efs.svg")
        self.assertEqual(
            list(package["contributes"]["views"]),
            [workspace_search.STANDALONE_CONTAINER_ID],
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
            subprocess.run(
                [sys.executable, "-I", "-B", "-c",
                 "import sys; sys.path.insert(0, sys.argv[1]); import configurator",
                 str(destination)],
                check=True, capture_output=True, text=True, cwd=root,
            )
            self.assertTrue((destination / "toolkit_settings.py").is_file())
            self.assertTrue((destination / "branch_names.py").is_file())
            self.assertTrue((destination / "branch_name_packs.json").is_file())
            self.assertTrue((destination / "chatgpt_integration.py").is_file())
            self.assertTrue((destination / "media" / "efs.svg").is_file())
            self.assertTrue((destination / "THIRD_PARTY_NOTICES.md").is_file())
            self.assertFalse(
                workspace_search.sync_extension(
                    check=True,
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )

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

            self.assertTrue(
                workspace_search.sync_extension(
                    extensions_dir=root,
                    settings=DEFAULTS,
                )
            )
            self.assertFalse(stale.exists())
            self.assertTrue(
                workspace_search.destination_matches(
                    workspace_search.extension_destination(root),
                    settings=DEFAULTS,
                )
            )


if __name__ == "__main__":
    unittest.main()
