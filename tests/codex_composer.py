import json
from pathlib import Path
import tempfile
import subprocess
import shutil
import unittest
from unittest.mock import patch

import codex_composer


class RetiredComposerPatchTests(unittest.TestCase):
    def test_custom_placeholders_use_external_display_and_restore_exact_source(self):
        source = ('a.formatMessage({id:`homePage.composer.placeholder.askAnything.v2`,'
                  'defaultMessage:`Ask anything`,description:`New chat`});'
                  'b.formatMessage({id:`composer.placeholder.localFollowUp.locally`,'
                  'defaultMessage:`Ask for changes`,description:`Follow up`})')
        settings = {'codexNewChatPlaceholder': 'Soar', 'codexFollowUpPlaceholder': 'Flap'}
        patched = codex_composer.transform_placeholders(source, settings)
        self.assertIn('new Set(["Soar", "Flap"])', patched)
        self.assertIn('aria-hidden', patched)
        self.assertEqual(codex_composer.transform_placeholders(patched, settings), patched)
        self.assertEqual(codex_composer.transform_placeholders(patched, {}), source)

    def test_legacy_placeholder_patch_is_upgraded(self):
        original = ('a.formatMessage({id:`composer.placeholder.localFollowUp.locally`,'
                    'defaultMessage:`Ask for changes`,description:`Follow up`})')
        replacement = '("Flap"/* scm-toolkit:codexFollowUpPlaceholder */)'
        legacy = (replacement + codex_composer.PLACEHOLDER_START
                  + json.dumps([[original, replacement]]) + codex_composer.PLACEHOLDER_END)
        patched = codex_composer.transform_placeholders(legacy, {'codexFollowUpPlaceholder': 'Flap'})
        self.assertIn(codex_composer.PLACEHOLDER_DISPLAY_START, patched)
        self.assertEqual(codex_composer.transform_placeholders(patched, {}), original)

    def test_send_wing_patch_is_independent_and_reversible(self):
        source = '/* composer.placeholder.localFollowUp.locally */\nbase;'
        wing = codex_composer.transform_layout(source, inline=False, wing_button=True)
        self.assertIn(codex_composer.WING_START, wing)
        self.assertIn('scm-toolkit-pegasus-send', wing)
        self.assertNotIn(codex_composer.LAYOUT_START, wing)
        self.assertEqual(codex_composer.transform_layout(wing, False, wing_button=True), wing)
        self.assertEqual(codex_composer.transform_layout(wing, False), source)
        both = codex_composer.transform_layout(source, False, paste_button=True, wing_button=True)
        self.assertIn(codex_composer.PASTE_START, both)
        self.assertEqual(codex_composer.transform_layout(both, False), source)
        with self.assertRaisesRegex(ValueError, 'send wing'):
            codex_composer.transform_layout(source + codex_composer.WING_START, False)

    def test_click_send_interrupt_patch_is_reversible(self):
        source = '/* composer.placeholder.localFollowUp.locally */\nbase;'
        enabled = codex_composer.transform_layout(source, inline=False, interrupt_send=True)
        self.assertIn(codex_composer.INTERRUPT_START, enabled)
        self.assertIn('scmToolkitCodexInterruptSend', enabled)
        self.assertEqual(codex_composer.transform_layout(enabled, False, interrupt_send=True), enabled)
        self.assertEqual(codex_composer.transform_layout(enabled, False), source)
        with self.assertRaisesRegex(ValueError, 'interrupt'):
            codex_composer.transform_layout(source + codex_composer.INTERRUPT_START, False)

    def test_clipboard_native_service_discovery_and_reinstallation(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'app-initial-fixture.js'
            source = '/* composer.placeholder.localFollowUp.locally */class E{constructor(e){this.dictation=new D(e,()=>this.isInputActive)}}'
            bundle.write_text(source)
            self.assertIsNone(codex_composer.clipboard_module(bundle))
            (bundle.parent / 'index.extension-current.js').write_text(
                'import{a,b}from"./app-initial-fixture.js";b();export{a as appServices};')
            module = codex_composer.clipboard_module(bundle)
            patched = codex_composer.transform_layout(source, False, True, module)
            self.assertIn('"./index.extension-current.js" /* scm-toolkit-native-clipboard */', patched)
            self.assertEqual(codex_composer.transform_layout(patched, False, True, module), patched)
            self.assertEqual(codex_composer.transform_layout(patched, False, False), source)

    def test_split_composer_editor_and_rpc_bundles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / 'webview/assets'
            assets.mkdir(parents=True)
            composer = assets / 'renamed-composer-current.js'
            editor = assets / 'renamed-editor-current.js'
            composer.write_text('a.formatMessage({id:`composer.placeholder.localFollowUp.locally`,defaultMessage:`Ask`,description:`Follow up`});')
            editor.write_text('class E{constructor(e){this.dictation=new D(e,()=>this.isInputActive)}}')
            (assets / 'rpc-current.js').write_text('export{native as appServices};')
            (assets / 'fr-FR-current.js').write_text('{"composer.placeholder.localFollowUp.locally":"Ask"}')
            patches = list(codex_composer.patch_files(root, inline=True, paste_button=True))
            self.assertEqual({p for p, _, _ in patches}, {composer, editor})
            for path, original, patched in patches:
                self.assertEqual(codex_composer.transform_layout(patched, True, True, './rpc-current.js'), patched)
                self.assertEqual(codex_composer.transform_layout(patched, False, False), original)
                if path == composer:
                    self.assertIn('scmToolkitCodexClipboardSubmit', patched)
                    self.assertIn('"./rpc-current.js"', patched)
                else:
                    self.assertIn('this.view.dom.__scmToolkitComposer=this', patched)
                    self.assertNotIn('scmToolkitCodexClipboardSubmit', patched)

    @unittest.skipUnless(shutil.which('node'), 'Node required for runtime safety')
    def test_optional_payload_failure_cannot_block_native_loading(self):
        payload = codex_composer.runtime_payload('fixture', 'throw new Error("upstream DOM changed");')
        script = ('const vm=require("node:vm"),assert=require("node:assert/strict");'
                  'const jobs=[];let warnings=0;const context={document:{readyState:"complete"},'
                  'setTimeout:job=>jobs.push(job),console:{warn(){warnings++}}};'
                  'vm.runInNewContext(' + json.dumps(payload + 'globalThis.nativeLoaded=true;') + ',context);'
                  'assert.equal(context.nativeLoaded,true);assert.equal(warnings,0);'
                  'jobs.forEach(job=>job());assert.equal(warnings,1);'
                  'vm.runInNewContext(' + json.dumps(payload) + ',{});')
        subprocess.run(['node', '-e', script], check=True, capture_output=True, text=True)

    @unittest.skipUnless(shutil.which('node'), 'Node required for runtime safety')
    def test_native_constructor_survives_changed_or_readonly_editor_dom(self):
        source = ('class E{constructor(e){this.view=e;this.dictation=new D(e,()=>this.isInputActive)}}')
        patched = codex_composer.transform_layout(source, False, True, './rpc.js')
        script = ('const assert=require("node:assert/strict");let calls=0;class D{constructor(){calls++}};'
                  + patched + ';new E(undefined);new E({dom:Object.freeze({})});'
                  'new E({get dom(){throw new Error("DOM moved")}});'
                  'assert.equal(calls,3);')
        subprocess.run(['node', '-e', script], check=True, capture_output=True, text=True)

    def test_inline_location_is_reversible_and_preserves_native_source(self):
        source = '/* composer.placeholder.localFollowUp.locally */\nbase;'
        patched = codex_composer.transform_layout(source)
        self.assertTrue(patched.startswith(source))
        self.assertIn(codex_composer.LAYOUT_START + ';\n', patched)
        self.assertEqual(codex_composer.transform_layout(patched), patched)
        self.assertEqual(codex_composer.transform_layout(patched, False), source)
        self.assertEqual(codex_composer.transform(patched), patched)


    def test_clipboard_button_patch_is_reversible_and_independent_of_location(self):
        source = '/* composer.placeholder.localFollowUp.locally */\nbase;'
        patched = codex_composer.transform_layout(source, inline=False, paste_button=True)
        self.assertIn(codex_composer.PASTE_START, patched)
        self.assertNotIn(codex_composer.LAYOUT_START, patched)
        self.assertIn('scm-toolkit-codex-clipboard-submit', patched)
        self.assertEqual(codex_composer.transform_layout(patched, False, True), patched)
        self.assertEqual(codex_composer.transform_layout(patched, False, False), source)

    def test_clipboard_patch_refuses_partial_marker(self):
        source = 'base' + codex_composer.PASTE_START + 'incomplete'
        with self.assertRaisesRegex(ValueError, 'clipboard'):
            codex_composer.transform_layout(source, False, True)

    def test_transform_removes_injected_payload(self):
        patched = (
            "base"
            + codex_composer.START
            + "/* edits:[] */\nlegacy injected javascript"
            + codex_composer.END
        )
        self.assertEqual(codex_composer.transform(patched), "base")

    def test_transform_restores_exact_pr_93_metadata_format(self):
        original = "function demo(){return value??fallback}"
        replacement = 'function demo(){return "Message"??value??fallback}'
        metadata = "/* edits:" + json.dumps([[original, replacement]]) + " */\n"
        patched = replacement + codex_composer.START + metadata + "legacy" + codex_composer.END

        self.assertEqual(codex_composer.transform(patched), original)

    def test_repair_writes_only_previously_patched_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "openai.chatgpt-test"
            assets = root / "webview" / "assets"
            assets.mkdir(parents=True)
            clean = assets / "app-initial-clean.js"
            clean.write_text("clean")
            patched = assets / "app-initial-patched.js"
            patched.write_text(
                "base"
                + codex_composer.START
                + "/* edits:[] */\nlegacy"
                + codex_composer.END
            )

            repaired = codex_composer.repair(root)

            self.assertEqual(repaired, [patched])
            self.assertEqual(clean.read_text(), "clean")
            self.assertEqual(patched.read_text(), "base")

    def test_repair_validates_all_bundles_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "openai.chatgpt-test"
            assets = root / "webview" / "assets"
            assets.mkdir(parents=True)
            first = assets / "app-initial-a.js"
            first.write_text(
                "first"
                + codex_composer.START
                + "/* edits:[] */\nlegacy"
                + codex_composer.END
            )
            broken = assets / "app-initial-b.js"
            broken.write_text(
                "second"
                + codex_composer.START
                + "missing metadata"
                + codex_composer.END
            )

            with self.assertRaisesRegex(ValueError, "missing edit metadata"):
                codex_composer.repair(root)

            self.assertIn(codex_composer.START, first.read_text())

    def test_clean_source_is_unchanged_and_not_selected(self):
        self.assertEqual(codex_composer.transform("clean"), "clean")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "openai.chatgpt-test"
            assets = root / "webview" / "assets"
            assets.mkdir(parents=True)
            (assets / "app-initial-clean.js").write_text("clean")
            self.assertEqual(list(codex_composer.patch_files(root)), [])

    def test_repair_restores_partial_failed_write_and_previous_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = root / "webview" / "assets"
            assets.mkdir(parents=True)
            original = "base" + codex_composer.START + "/* edits:[] */\nlegacy" + codex_composer.END
            first = assets / "app-initial-a.js"
            second = assets / "app-initial-b.js"
            first.write_text(original)
            second.write_text(original)
            write_text = Path.write_text
            failed = False

            def fail_once(path, content, *args, **kwargs):
                nonlocal failed
                if path == second and not failed:
                    failed = True
                    write_text(path, "partial")
                    raise OSError("interrupted write")
                return write_text(path, content, *args, **kwargs)

            with patch.object(Path, "write_text", fail_once):
                with self.assertRaisesRegex(OSError, "interrupted write"):
                    codex_composer.repair(root)
            self.assertEqual(first.read_text(), original)
            self.assertEqual(second.read_text(), original)


if __name__ == "__main__":
    unittest.main()
