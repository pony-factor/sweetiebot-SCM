
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

import json
import contextlib
import io
import subprocess
import os
import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import branch_names
import build_installer_app
import install
import toolkit_settings
import wrapper_dependencies



# Allow direct script execution as well as the CI unittest module runner.
_sb_root = str(_sb_path(__file__).resolve().parents[2])
if _sb_root not in _sb_sys.path:
    _sb_sys.path.insert(0, _sb_root)

from tests.fixtures.installer_support import (
    SETTINGS, GIT_MODEL_FIXTURE, workbench_fixture, pr_explorer_fixture,
    browser_cross_window_fixture, browser_resolver_fixture, browser_open_action_fixture,
)


class GitConfigTests(unittest.TestCase):
    def test_legacy_global_git_namespace_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "gitconfig"
            config.write_text(
                '[scm-toolkit]\n'
                '    ludicrous-mode = true\n'
                '    remote = old\n'
                '    message-placeholder = ""\n'
                '    ai-commit\n'
                '    custom-setting = preserved\n'
                '    single-repository-per-window = false\n'
                '[sweetiebot]\n'
                '    remote = new\n'
                '[user]\n'
                '    name = Unrelated\n'
            )
            with patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(config),
                                         "GIT_CONFIG_NOSYSTEM": "1"}):
                def get(key):
                    return subprocess.run(["git", "config", "--global", "--get", key],
                                          capture_output=True, text=True)
                self.assertTrue(toolkit_settings.read_git_bool("sweetiebot.ludicrous-mode", False))
                self.assertEqual(toolkit_settings.read_git_string("sweetiebot.remote", ""), "new")
                toolkit_settings.migrate_legacy_git_settings()
                self.assertEqual(get("sweetiebot.ludicrous-mode").stdout, "true\n")
                self.assertEqual(get("sweetiebot.remote").stdout, "new\n")
                self.assertEqual(get("sweetiebot.message-placeholder").stdout, "\n")
                self.assertEqual(get("sweetiebot.ai-commit").stdout, "true\n")
                self.assertEqual(get("sweetiebot.custom-setting").stdout, "preserved\n")
                self.assertEqual(get("sweetiebot.single-repository-per-window").stdout, "false\n")
                self.assertFalse(toolkit_settings.read_git_bool("sweetiebot.single-repository-per-window", True))
                self.assertEqual(get("user.name").stdout, "Unrelated\n")
                self.assertEqual(get("scm-toolkit.remote").returncode, 1)
                before = config.read_bytes()
                toolkit_settings.migrate_legacy_git_settings()
                self.assertEqual(config.read_bytes(), before)

    def test_every_default_has_a_git_config_key(self):
        self.assertEqual(
            set(toolkit_settings.DEFAULT_SETTINGS),
            set(toolkit_settings.SETTING_KEYS),
        )

    def test_all_git_settings_use_sweetiebot_namespace(self):
        for name, key in toolkit_settings.SETTING_KEYS.items():
            with self.subTest(setting=name):
                self.assertTrue(key.startswith("sweetiebot."), key)

    @patch("toolkit_settings.subprocess.run")
    def test_boolean_git_config_uses_parsed_value(self, run):
        run.return_value = types.SimpleNamespace(returncode=0, stdout="true\n", stderr="")
        self.assertTrue(install.read_git_bool("sweetiebot.branch-picker", False))

    @patch("toolkit_settings.subprocess.run")
    def test_missing_boolean_git_config_uses_default(self, run):
        run.return_value = types.SimpleNamespace(returncode=1, stdout="", stderr="")
        self.assertTrue(install.read_git_bool("sweetiebot.branch-picker", True))

    def test_manual_commit_spellcheck_is_preview_only(self):
        self.assertFalse(install.DEFAULT_SETTINGS["spellcheckManualCommit"])
        self.assertEqual(
            toolkit_settings.SETTING_KEYS["spellcheckManualCommit"],
            "sweetiebot.spellcheck-preview",
        )

    @patch("toolkit_settings.subprocess.run")
    def test_string_git_config_uses_value(self, run):
        run.return_value = types.SimpleNamespace(returncode=0, stdout="upstream\n", stderr="")
        self.assertEqual(install.read_git_string("sweetiebot.remote", "origin"), "upstream")


class InstallerScriptsLayoutTests(unittest.TestCase):
    def test_install_command_runs_from_checkout_root(self):
        root = Path(__file__).resolve().parents[2]
        launcher = root / "scripts/install.command"
        self.assertTrue(launcher.is_file())
        self.assertTrue(launcher.stat().st_mode & 0o111)
        self.assertFalse((root / "Install Sweetiebot.command").exists())
        source = launcher.read_text(encoding="utf-8")
        self.assertIn('cd -- "$(dirname -- "$0")/.."', source)
        self.assertIn("python3 scripts/build-installer-app.py", source)
        self.assertIn('open "$PWD/Sweetiebot Installer.app"', source)

    def test_ci_runner_and_inventory_share_directory(self):
        root = Path(__file__).resolve().parents[2]
        self.assertTrue((root / "scripts/ci/ci-test-runner.py").is_file())
        self.assertTrue((root / "scripts/ci/ci-test-groups.json").is_file())
        self.assertFalse((root / "scripts/ci-test-runner.py").exists())
        self.assertFalse((root / "scripts/ci-test-groups.json").exists())
        workflow = (root / ".github/workflows/check.yml").read_text(encoding="utf-8")
        self.assertEqual(workflow.count("scripts/ci/ci-test-runner.py"), 3)


class ResolvedCountdownTests(unittest.TestCase):
    def fixture(self):
        return (
            'import{n as initCopy,t as resolveCopy}from"./banner-copy-fixture.js";'
            'function render(props){let cache=[],{banner:b}=props,intl={};'
            'let copy;cache[0]!==b?(copy=resolveCopy(b,intl),cache[0]=b,cache[1]=copy):copy=cache[1];'
            'let{title:title,description:description}=copy,actions;'
            'actions=b.banner_type?b.ctas:[];'
            'return(0,React.jsx)(`span`,{children:description})}'
            'const dismiss=`codex.rateLimitUpsellBanner.dismiss`;'
        )

    def test_resolved_copy_is_reversible_and_idempotent(self):
        original = self.fixture()
        patched = install.transform_codex(original, enabled=True, sticker_enabled=False)
        self.assertIn('copy=scmToolkitUsageResetCopy(b,intl,resolveCopy,React.jsx),', patched)
        self.assertEqual(install.transform_codex(patched, enabled=True, sticker_enabled=False), patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)
        disabled = install.transform_codex(patched, enabled=False, sticker_enabled=False)
        self.assertNotIn(install.CODEX_START, disabled)
        self.assertEqual(install.transform_codex(disabled, remove=True), original)

    def test_rejects_ambiguous_or_changed_resolved_banner(self):
        original = self.fixture()
        for source in (original + original,
                       original.replace('children:description', 'children:other'),
                       original.replace('b.ctas', 'other.ctas')):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'resolved usage-banner'):
                install.codex_countdown_edits(source)

    def test_unrelated_helper_is_not_treated_as_a_countdown_target(self):
        with self.assertRaisesRegex(ValueError, 'reset-time anchor'):
            install.codex_countdown_edits(self.fixture().replace('banner-copy-', 'unrelated-copy-'))

    def test_minified_dollar_aliases_are_supported(self):
        original = self.fixture().replace('resolveCopy', '$resolve').replace('React', '$jsx')
        original = original.replace('copy', '$copy').replace('banner-$copy-', 'banner-copy-')
        edits = install.codex_countdown_edits(original)
        self.assertEqual(len(edits), 1)
        self.assertIn('scmToolkitUsageResetCopy(b,intl,$resolve,$jsx.jsx)', edits[0][1])

    def test_patched_component_renders_a_countdown_and_preserves_native_resolver(self):
        original = self.fixture()
        for before, after in install.codex_countdown_edits(original):
            original = original.replace(before, after)
        executable = original.split(';', 1)[1] + (install.CODEX_ASSETS / 'countdown.js').read_text()
        script = '''
const assert = require('node:assert/strict');
const React = {jsx: (tag, props) => ({tag, props})};
const HTMLElement = class {};
const customElements = {get() {return true}};
let nativeCalls = 0;
function resolveCopy(banner, intl) {nativeCalls++;return {title:'Native title',description:'Native date'}}
SOURCE
const banner = {banner_type:'limit',ctas:[],reset_at:1800003600,title:'Title',description:'Try again at {time}.'};
const rendered = render({banner});
assert.equal(nativeCalls, 1);
assert.equal(rendered.props.children[0], 'Try again in ');
assert.equal(rendered.props.children[1].tag, 'scm-toolkit-usage-reset-countdown');
assert.equal(rendered.props.children[1].props['reset-at'], 1800003600);
'''.replace('SOURCE', executable)
        subprocess.run(['node', '-e', script], check=True, capture_output=True)


class WorkbenchFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "Code.app"
        resources = self.app / "Contents/Resources/app"
        workbench = resources / "out/vs/workbench"
        workbench.mkdir(parents=True)
        (resources / "package.json").write_text(json.dumps({"version": "1.143.1"}))
        self.paths = [workbench / "workbench.desktop.main.js", workbench / "workbench.desktop.main.css"]
        self.original = [workbench_fixture(), "base-css"]
        for path, content in zip(self.paths, self.original):
            path.write_text(content)
        mkdtemp = tempfile.mkdtemp
        self.backups = patch.object(install.tempfile, "mkdtemp", side_effect=lambda **kwargs: mkdtemp(dir=self.root, **kwargs))
        self.backups.start()
        self.addCleanup(self.backups.stop)
        self.output = io.StringIO()
        redirect = contextlib.redirect_stdout(self.output)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)

    def contents(self):
        return [path.read_text() for path in self.paths]


class WorkbenchRepairTests(WorkbenchFixture):
    def test_cli_repairs_scm_without_touching_optional_extensions(self):
        with patch("sys.argv", ["install.py", "--app", str(self.app), "--workbench-only", "--repair"]), \
                patch.object(install, "load_settings", return_value=SETTINGS), \
                patch.object(install, "codex_bundle_paths", side_effect=ValueError("Unsupported Codex extension build")) as codex, \
                patch.object(install.workspace_search, "sync_extension") as extension, \
                patch.object(install, "sync_ai_wrapper") as wrapper, \
                patch.object(install, "persist_message_bar_layout") as persist:
            install.main()
        codex.assert_not_called()
        extension.assert_not_called()
        wrapper.assert_not_called()
        persist.assert_not_called()
        js, css = self.contents()
        self.assertIn("scmToolkitCreateControls(this,", js)
        self.assertIn('"commitButtonLabel":"Send"', js)
        self.assertIn(install.START, css)
        self.assertTrue((self.paths[0].parent / "sweetiebot/manifest.json").is_file())
        backups = list(self.root.glob("sweetiebot-scm-repair-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual([(backups[0] / path.name).read_text() for path in self.paths], self.original)

    def test_check_does_not_write_bundles_components_or_backups(self):
        with patch("sys.argv", ["install.py", "--app", str(self.app), "--workbench-only", "--check"]), \
                patch.object(install, "load_settings", return_value=SETTINGS):
            install.main()
        self.assertEqual(self.contents(), self.original)
        self.assertFalse((self.paths[0].parent / "sweetiebot").exists())
        self.assertEqual(list(self.root.glob("sweetiebot-scm-repair-*")), [])

    def test_unsupported_workbench_preserves_both_files(self):
        self.paths[0].write_text("unsupported workbench")
        before = self.contents()
        with self.assertRaisesRegex(ValueError, "Unsupported VS Code build"):
            install.repair_workbench(self.app, SETTINGS)
        self.assertEqual(self.contents(), before)
        self.assertFalse((self.paths[0].parent / "sweetiebot").exists())

    def test_incomplete_patch_preserves_both_files(self):
        self.paths[0].write_text(self.original[0] + install.START)
        before = self.contents()
        with self.assertRaisesRegex(ValueError, "Incomplete toolkit installation"):
            install.repair_workbench(self.app, SETTINGS)
        self.assertEqual(self.contents(), before)

    def test_concurrent_application_edit_is_preserved(self):
        transform = install.transform
        def changed(*args, **kwargs):
            result = transform(*args, **kwargs)
            self.paths[0].write_text("concurrent application edit")
            return result
        with patch.object(install, "transform", side_effect=changed), \
                self.assertRaisesRegex(RuntimeError, "VS Code changed during validation"):
            install.repair_workbench(self.app, SETTINGS)
        self.assertEqual(self.contents(), ["concurrent application edit", self.original[1]])
        self.assertEqual(list(self.root.glob("sweetiebot-scm-repair-*")), [])

    def test_repeated_repair_is_idempotent(self):
        install.repair_workbench(self.app, SETTINGS)
        first = self.contents()
        install.repair_workbench(self.app, SETTINGS)
        self.assertEqual(self.contents(), first)
        self.assertEqual(len(list(self.root.glob("sweetiebot-scm-repair-*"))), 1)
        self.assertEqual(first[0].count(install.START), 1)

    def test_incompatible_modes_are_rejected_before_loading_settings(self):
        for flag in ("--uninstall", "--configure", "--codex-only", "--ui-only"):
            with self.subTest(flag=flag), \
                    patch("sys.argv", ["install.py", "--workbench-only", flag]), \
                    patch.object(install, "load_settings") as settings, \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                install.main()
            settings.assert_not_called()


class IndependentRepairTests(WorkbenchFixture):
    def setUp(self):
        super().setUp()
        self.settings = dict(toolkit_settings.DEFAULT_SETTINGS, **SETTINGS)
        resources = self.app / 'Contents/Resources/app'
        self.git_extension = resources / 'extensions/git/dist/main.js'
        self.git_extension.parent.mkdir(parents=True)
        self.git_extension.write_text(
            'class Repository{async commit(e,t=Object.create(null)){'
            'let r=[...this.indexGroup.resourceStates.map(o=>o.resourceUri.fsPath)];'
            'let x=api.workspace.getConfiguration("git",api.Uri.file(this.root));return "native"}'
            'async updateWhenIdleAndWait(){await this.whenIdleAndFocused(),await this.status(),await pause(5e3)}}'
            'decorate([debounce(1e3)],Repository.prototype,"eventuallyUpdateWhenIdleAndWait",1)'
            + GIT_MODEL_FIXTURE)
        self.preload = resources / 'out/vs/platform/browserView/electron-browser/preload-browserView.js'
        self.preload.parent.mkdir(parents=True)
        self.preload.write_text('"vscode:browserView:preloadReady";')
        self.native_main = resources / 'out/mainImpl.js'
        self.native_main.write_text(
            'static getOrCreateGlobal(n){let e=electron.fromPartition("persist:vscode-browser");'
            'return Sessions._bySession.get(e)??n.createInstance(Sessions,"global",e,"global")}'
            'static getOrCreateWorkspace(n,e,t){let r=join(t,e,"browserStorage"),'
            'o=electron.fromPath(r.fsPath);return Sessions._bySession.get(o)}'
            'return Sessions.getOrCreate(this.instantiationService,e,r,'
            'this.environmentMainService.workspaceStorageHome,o.openedWorkspace?.id,t)'
            + install.browser_pr.BACKGROUND_ANCHOR + '1000}')
        self.codex = self.root / 'codex/index.js'
        self.codex.parent.mkdir()
        self.codex.write_text(install.CODEX_START + 'installed unsupported countdown' + install.CODEX_END)
        self.manifest = self.codex.with_name('package.json')
        self.manifest.write_text('original manifest')
        self.styles = self.root / 'codex/webview/assets/main.css'
        self.styles.parent.mkdir(parents=True)
        self.styles.write_text('original CSS')
        self.files = self.paths + [self.git_extension, self.preload, self.native_main,
                                  self.codex, self.manifest, self.styles]
        for target, name, value in (
                (install, 'load_settings', self.settings),
                (install, 'ai_wrapper_path', self.root / 'bin/git-wrapper'),
                (install, 'sync_ai_wrapper', False),
                (install, 'sync_model_picker', False),
                (install, 'resume_stalled_background_jobs', False),
                (install, 'persist_message_bar_layout', None),
                (install, 'invalidate_extension_cache', None),
                (install.workspace_search, 'sync_extension', False),
                (install.workspace_search, 'remove_legacy_extensions', False),
                (install.github_pr, 'patch_files', []),
                (install.codex_label, 'patch_file', (self.manifest, 'original manifest', 'planned manifest')),
                (install.codex_colors, 'stylesheet_path', self.styles),
                (install.codex_colors, 'transform', 'planned CSS'),
                (install, 'codex_bundle_paths', [self.codex])):
            mock = patch.object(target, name, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)
        for module in (install.codex_context, install.codex_drafts, install.codex_usage,
                       install.codex_composer, install.codex_queued_edit):
            mock = patch.object(module, 'patch_files', return_value=[])
            mock.start()
            self.addCleanup(mock.stop)
        for module in (install.codex_keep_awake, install.codex_startup):
            mock = patch.object(module, 'patch_file', return_value=None)
            mock.start()
            self.addCleanup(mock.stop)
        mock = patch.object(install, 'transform_codex', side_effect=ValueError(
            'Unsupported Codex extension build: reset-time anchor does not match.'))
        self.codex_transform = mock.start()
        self.addCleanup(mock.stop)

    def run_installer(self, *flags):
        with patch('sys.argv', ['install.py', '--app', str(self.app), *flags]):
            install.main()

    def test_core_repair_recovers_profile_and_ui_without_optional_integrations(self):
        with patch.object(install, 'plan_codex_patches', side_effect=AssertionError('optional Codex')), \
                patch.object(install.github_pr, 'patch_files', side_effect=AssertionError('optional GitHub')), \
                patch.object(install, 'sync_ai_wrapper', side_effect=AssertionError('Git wrapper')), \
                patch.object(install, 'resume_stalled_background_jobs', side_effect=AssertionError('commit jobs')):
            self.run_installer('--core-only')
        self.assertIn(install.START, self.paths[0].read_text())
        self.assertIn(install.browser_pr.STORAGE_START, self.native_main.read_text())
        self.assertIn('Sweetiebot core repair complete.', self.output.getvalue())
        self.assertIn('full VS Code quit and restart', self.output.getvalue())

    def test_core_repair_restores_scm_even_if_browser_is_unsupported(self):
        self.native_main.write_text('unsupported browser lifecycle')
        self.run_installer('--core-only')
        self.assertIn(install.START, self.paths[0].read_text())
        self.assertEqual(self.native_main.read_text(), 'unsupported browser lifecycle')
        self.assertNotIn(install.browser_pr.START, self.preload.read_text())
        self.assertIn('browser repair skipped', self.output.getvalue())

    def test_core_repair_restores_browser_even_if_workbench_is_unsupported(self):
        self.paths[0].write_text('unsupported workbench lifecycle')
        with self.assertRaises(ValueError):
            self.run_installer('--core-only')
        self.assertEqual(self.paths[0].read_text(), 'unsupported workbench lifecycle')
        self.assertIn(install.browser_pr.STORAGE_START, self.native_main.read_text())
        self.assertIn(install.browser_pr.START, self.preload.read_text())
        self.assertIn('continuing browser repair', self.output.getvalue())
        self.assertIn('full VS Code quit and restart', self.output.getvalue())
        self.assertNotIn('Sweetiebot core repair complete.', self.output.getvalue())

    def test_core_check_never_writes_when_workbench_is_unsupported(self):
        self.paths[0].write_text('unsupported workbench lifecycle')
        before = [p.read_bytes() for p in self.files]
        with self.assertRaises(ValueError):
            self.run_installer('--core-only', '--check')
        self.assertEqual([p.read_bytes() for p in self.files], before)

    def test_core_check_never_writes(self):
        before = [p.read_bytes() for p in self.files]
        self.run_installer('--core-only', '--check')
        self.assertEqual([p.read_bytes() for p in self.files], before)

    def test_full_repair_restores_browser_and_scm_after_late_codex_failure(self):
        self.run_installer('--repair')
        self.codex_transform.assert_called_once()
        self.assertIn(install.START, self.paths[0].read_text())
        self.assertIn(install.browser_pr.STORAGE_START, self.native_main.read_text())
        self.assertIn(install.browser_pr.START, self.preload.read_text())
        self.assertEqual(self.manifest.read_text(), 'original manifest')
        self.assertEqual(self.styles.read_text(), 'original CSS')
        self.assertIn('installed unsupported countdown', self.codex.read_text())
        self.assertIn('Codex customizations skipped', self.output.getvalue())
        self.assertIn('full VS Code quit and restart', self.output.getvalue())

    def test_check_validates_independent_repairs_without_writes(self):
        before = [p.read_bytes() for p in self.files]
        self.run_installer('--check')
        self.assertEqual([p.read_bytes() for p in self.files], before)
        self.assertFalse((self.paths[0].parent / 'sweetiebot').exists())
        self.assertIn('Codex customizations skipped', self.output.getvalue())
        self.assertIn('Validated SCM and browser patches', self.output.getvalue())

    def test_missing_optional_asset_does_not_block_native_repairs(self):
        with patch.object(install.codex_colors, 'stylesheet_path', side_effect=FileNotFoundError('missing optional CSS')):
            self.run_installer('--repair')
        self.assertIn(install.browser_pr.STORAGE_START, self.native_main.read_text())
        self.assertEqual(self.manifest.read_text(), 'original manifest')
        self.assertIn('missing optional CSS', self.output.getvalue())

    def test_repeated_repair_reports_skipped_codex_when_native_files_are_current(self):
        self.run_installer('--repair')
        before = [p.read_bytes() for p in self.files]
        self.output.seek(0)
        self.output.truncate()
        with patch.object(install, 'write_pair') as write:
            self.run_installer('--repair')
        write.assert_not_called()
        self.assertEqual([p.read_bytes() for p in self.files], before)
        self.assertIn('SCM and browser patches (Codex customizations skipped) is already up to date', self.output.getvalue())

    def test_explicit_codex_and_uninstall_modes_fail_without_writes(self):
        before = [p.read_bytes() for p in self.files]
        for flag in ('--codex-only', '--uninstall'):
            with self.subTest(flag=flag), self.assertRaisesRegex(ValueError, 'reset-time anchor'):
                self.run_installer(flag)
            self.assertEqual([p.read_bytes() for p in self.files], before)

    def test_unsupported_native_workbench_still_fails_closed(self):
        self.paths[0].write_text('unsupported native workbench')
        before = [p.read_bytes() for p in self.files]
        with self.assertRaisesRegex(ValueError, 'Unsupported VS Code build'):
            self.run_installer('--repair')
        self.codex_transform.assert_not_called()
        self.assertEqual([p.read_bytes() for p in self.files], before)

    def test_supported_codex_plan_is_installed_with_native_repairs(self):
        self.codex_transform.side_effect = None
        self.codex_transform.return_value = 'supported Codex patch'
        self.run_installer('--repair')
        self.assertEqual(self.codex.read_text(), 'supported Codex patch')
        self.assertEqual(self.styles.read_text(), 'planned CSS')
        self.assertEqual(self.manifest.read_text(), 'planned manifest')
        self.assertIn(install.browser_pr.STORAGE_START, self.native_main.read_text())
        self.assertNotIn('Codex customizations skipped', self.output.getvalue())

if __name__ == "__main__":
    unittest.main()
