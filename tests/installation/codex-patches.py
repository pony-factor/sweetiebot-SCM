
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


class CodexCountdownTests(unittest.TestCase):
    def modern_fixture(self):
        return (
            'let e=n.reset_at==null?null:format(d,n.reset_at,true);'
            'x=e==null?n.title:n.title.replaceAll(`{time}`,e),'
            'b=e==null?n.description:n.description.replaceAll(`{time}`,e),other=true;'
            '(0,J.jsx)(`span`,{children:b});'
            'const id=`codex.rateLimitUpsellBanner.dismiss`;'
            'let f=a.weeklyWindow.resetsAt==null?null:format(d,a.weeklyWindow.resetsAt,true);'
            '(0,J.jsx)(Button,{});'
            'pe=f==null?S.description:S.description.replace(`{time}`,f),unused=true;'
        )

    def test_backend_banner_and_weekly_reset_round_trip(self):
        original = self.modern_fixture()
        patched = install.transform_codex(original, enabled=True)
        self.assertIn('scmToolkitUsageResetMessage(n.title,n.reset_at,J.jsx)', patched)
        self.assertIn('scmToolkitUsageResetMessage(n.description,n.reset_at,J.jsx)', patched)
        self.assertIn('scmToolkitUsageResetMessage(S.description,a.weeklyWindow.resetsAt,J.jsx)', patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)
        self.assertTrue(install.codex_bundle_matches(original))
        self.assertEqual(install.transform_codex(patched, enabled=True), patched)

    def test_transcript_reset_uses_live_countdown_and_restores_original(self):
        transcript = (
            'u=e==null?null:format(r,e);'
            '(0,J.jsx)(Message,{id:`localConversation.usageLimit.upgrade.noReset`});'
        )
        for variant in ('upgrade', 'upgradeOrAddCredits', 'addCredits', 'retry'):
            transcript += (
                '(0,J.jsx)(Message,{id:`localConversation.usageLimit.' + variant + '`, '
                'defaultMessage:`Try again at {resetDate}.`,values:{resetDate:r}});'
            ).replace('`, defaultMessage:', '`,defaultMessage:')
        original = self.modern_fixture() + transcript
        patched = install.transform_codex(original, enabled=True)
        self.assertIn('u=e==null?null:(0,J.jsx)(`scm-toolkit-usage-reset-countdown`,{"reset-at":e})', patched)
        self.assertIn('usageLimit.upgradeOrAddCredits.countdown', patched)
        self.assertIn('defaultMessage:`Try again in {resetDate}.`', patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)
        self.assertEqual(install.transform_codex(patched, enabled=True), patched)

        # Reset-time hiding must preserve the native transcript formatter.
        hidden = install.transform_codex(patched, hide_reset_times=True)
        self.assertIn('u=e==null?null:format(r,e);', hidden)
        self.assertNotIn('usageLimit.upgradeOrAddCredits.countdown', hidden)
        self.assertEqual(install.transform_codex(hidden, hide_reset_times=True), hidden)
        self.assertEqual(install.transform_codex(hidden, remove=True), original)
        self.assertEqual(install.transform_codex(hidden, enabled=True), patched)

    def test_installer_app_includes_bundled_twilight_artwork(self):
        self.assertIn(Path("assets/imgs/twi-stop.png"), build_installer_app.source_files())

    def test_semantic_rate_limit_bundle_can_be_discovered_after_copy_changes(self):
        source = 'const view={"data-composer-navigation-target":true,"data-testid":"codex-rate-limit-alert",role:"alert"};'
        self.assertTrue(install.codex_bundle_matches(source))
        changed = install.transform_codex(source, sticker_enabled=False)
        self.assertIn(install.CODEX_LIMIT_START, changed)
        self.assertIn("scmToolkitSemanticRateLimitNodes", changed)
        self.assertEqual(install.transform_codex(changed, remove=True), source)
        self.assertFalse(install.codex_bundle_matches('const docs="quota limit";'))

    def test_sticker_can_be_disabled_without_disabling_compaction(self):
        original = 'const modernStatus = "You’re out of Codex messages";'
        disabled = install.transform_codex(original, sticker_enabled=False)
        self.assertIn(install.CODEX_LIMIT_START, disabled)
        self.assertIn("scmToolkitCompactUntimedRateLimitBranch", disabled)
        self.assertIn("const scmToolkitRateLimitStickerEnabled = false;", disabled)
        self.assertNotIn("data:image/png;base64,", disabled)
        self.assertEqual(install.transform_codex(disabled, sticker_enabled=False), disabled)
        self.assertEqual(install.transform_codex(disabled, remove=True), original)

    def test_rate_limit_sticker_works_without_legacy_transcript_ids(self):
        original = 'const modernStatus = "You’re out of Codex messages";'
        patched = install.transform_codex(original)
        self.assertIn(install.CODEX_LIMIT_START, patched)
        self.assertIn("data:image/png;base64,", patched)
        self.assertNotIn("__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__", patched)
        self.assertIn("scmToolkitFooterRateLimitNotice", patched)
        self.assertEqual(install.transform_codex(patched), patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_rate_limited_transcript_compaction_preserves_timed_messages(self):
        no_reset = (
            "(0,J.jsx)(Message,{id:`localConversation.usageLimit.upgrade.noReset`,"
            "defaultMessage:`You've hit your usage limit. Upgrade your plan or "
            "add credits to continue, or try again later.`});"
        )
        timed = (
            "(0,J.jsx)(Message,{id:`localConversation.usageLimit.retry`,"
            "defaultMessage:`Try again at {resetDate}.`});"
        )
        original = no_reset + timed
        patched = install.transform_codex(original)
        self.assertIn("localConversation.usageLimit.upgrade.noReset.scmShort", patched)
        self.assertIn("defaultMessage:`Rate limited`", patched)
        self.assertIn("defaultMessage:`Try again at {resetDate}.`", patched)
        self.assertIn("scmToolkitSyncResetShortcut", patched)
        self.assertEqual(install.transform_codex(patched), patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_hiding_times_compacts_timed_transcript_before_render(self):
        original = "(0,J.jsx)(Message,{id:`localConversation.usageLimit.retry`,defaultMessage:`You've hit your usage limit. Try again at {resetDate}.`});"
        patched = install.transform_codex(original, hide_reset_times=True, sticker_enabled=False)
        self.assertIn('id:`localConversation.usageLimit.retry.scmShort`,defaultMessage:`Rate limited`', patched)
        self.assertEqual(install.transform_codex(patched, hide_reset_times=True, sticker_enabled=False), patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_hiding_times_compacts_backend_banner_before_render(self):
        original = 'let{title:E,description:D}=T,O;if(changed){let e=n.ctas.filter(xt);render(e)};M=(0,J.jsx)(`span`,{ref:i,className:`whitespace-pre-wrap`,children:D});format({id:`codex.rateLimitUpsellBanner.dismiss`,defaultMessage:`Dismiss usage banner`});'
        patched = install.transform_codex(original, hide_reset_times=True, sticker_enabled=False)
        self.assertIn('let{title:E,description:D}=scmToolkitCompactHiddenLimitBanner(T),O', patched)
        self.assertIn('let e=scmToolkitIsHiddenLimitBanner(T)?[]:n.ctas.filter(xt);', patched)
        self.assertIn('`span`,{"data-scm-toolkit-rate-limited":scmToolkitIsHiddenLimitBanner(T)?"true":void 0,ref:i,', patched)
        self.assertEqual(install.transform_codex(patched, hide_reset_times=True, sticker_enabled=False), patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_transcript_compaction_never_targets_unrelated_messages(self):
        original = "(0,J.jsx)(Message,{id:`other.noReset`,defaultMessage:`Try again later.`});"
        self.assertEqual(install.transform_codex(original), original)

    def test_previous_transcript_reset_edit_is_restored(self):
        original = 'u=e==null?null:format(r,e);'
        replacement = 'u=null/* scm-toolkit-hide-transcript-reset */'
        installed = original.replace(original[:-1], replacement)
        installed += install.CODEX_HIDE_RESET_START
        installed += '/* edits:' + json.dumps([[original[:-1], replacement]]) + ' */\n'
        installed += install.CODEX_HIDE_RESET_END
        self.assertEqual(install.transform_codex(installed, remove=True), original)
        repaired = install.transform_codex(installed, hide_reset_times=True)
        self.assertTrue(repaired.startswith(original))
        self.assertEqual(install.transform_codex(repaired, remove=True), original)

    def test_legacy_countdown_metadata_can_still_be_removed(self):
        original = self.fixture()
        before, after = install.codex_countdown_edit(original)
        patched = original.replace(before, after) + install.CODEX_START
        patched += '/* edit:' + json.dumps([before, after]) + ' */\n' + install.CODEX_END
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def fixture(self):
        return (
            "function banner(){let V={},ne=123,We=false,Ge="
            "ne==null?null:oE(V,ne,We),unused=true;"
            "return (0,L4.jsx)(Y,{id:`codex.upsellBanner.general.title`,"
            "defaultMessage:`You’re out of Codex messages`,"
            "values:{resetDate:Ge}})}"
        )

    def test_countdown_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexUsageResetCountdown"])
        self.assertTrue(install.DEFAULT_SETTINGS["codexUsagePieIndicator"])
        self.assertFalse(install.DEFAULT_SETTINGS["codexCloudTasks"])
        self.assertFalse(install.DEFAULT_SETTINGS["codexResetTimePieIndicator"])
        self.assertFalse(install.DEFAULT_SETTINGS["codexHideUsageResetTimes"])

    def test_hide_reset_times_without_countdown(self):
        original = self.modern_fixture()
        patched = install.transform_codex(original, hide_reset_times=True)
        self.assertIn(install.CODEX_HIDE_RESET_START, patched)
        self.assertNotIn(install.CODEX_START, patched)
        self.assertEqual(install.transform_codex(patched, hide_reset_times=True), patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_codex_countdown_install_and_remove_round_trip(self):
        original = self.fixture()
        patched = install.transform_codex(original, enabled=True)

        self.assertIn("scm-toolkit-usage-reset-countdown", patched)
        self.assertIn('"reset-at":ne', patched)
        self.assertEqual(patched.count(install.CODEX_START), 1)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_codex_countdown_disabled_removes_existing_patch(self):
        original = self.fixture()
        patched = install.transform_codex(original, enabled=True)

        without_countdown = install.transform_codex(patched, enabled=False)
        self.assertNotIn(install.CODEX_START, without_countdown)
        self.assertIn(install.CODEX_LIMIT_START, without_countdown)
        self.assertEqual(without_countdown, install.transform_codex(original, enabled=False))
        self.assertEqual(install.transform_codex(without_countdown, remove=True), original)


class CodexPromotionTests(unittest.TestCase):
    def test_split_usage_and_promotion_chunks_are_both_discovered(self):
        with tempfile.TemporaryDirectory() as directory:
            extension = Path(directory)
            assets = extension / 'webview/assets'
            assets.mkdir(parents=True)
            banner = assets / 'usage-new-hash.js'
            banner.write_text(CodexCountdownTests().modern_fixture())
            promo = assets / 'promotion-new-hash.js'
            promo.write_text('const title=`Enable Fast mode`;')
            (assets / 'locale.js').write_text('"codex.rateLimitUpsellBanner.dismiss":"Dismiss usage banner"')
            self.assertEqual(set(install.codex_bundle_paths(extension)), {banner, promo})
            self.assertEqual(install.codex_bundle_path(extension), banner)

    def test_bundle_discovery_supports_split_extension_chunks(self):
        with tempfile.TemporaryDirectory() as directory:
            extension = Path(directory)
            assets = extension / "webview/assets"
            assets.mkdir(parents=True)
            (assets / "app-initial-test.js").write_text("const app = {};")
            bundle = assets / "home-announcement-state-test.js"
            bundle.write_text("const title=`Enable Fast mode`;")
            self.assertEqual(install.codex_bundle_path(extension), bundle)

    def test_promotion_hiding_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexHidePromotions"])

    def test_codex_promotion_install_and_remove_round_trip(self):
        original = "const promo=`Enable Fast mode`;const action=`Enable now`;"
        patched = install.transform_codex(original, hide_promotions=True)

        self.assertIn("scm-toolkit-codex-promotions:start", patched)
        self.assertIn("Enable Fast mode", patched)
        self.assertIn("Enable now", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_promotions_and_countdown_can_coexist(self):
        original = CodexCountdownTests().fixture()
        patched = install.transform_codex(
            original, enabled=True, hide_promotions=True
        )

        self.assertIn("scm-toolkit-usage-reset-countdown", patched)
        self.assertIn("scm-toolkit-codex-promotions:start", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_bundle_match_accepts_fast_mode_promotion(self):
        self.assertTrue(
            install.codex_bundle_matches(
                "const title=`Enable Fast mode`;const action=`Enable now`;"
            )
        )


class CodexTimestampTests(unittest.TestCase):
    def test_chat_timestamp_hiding_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexHideChatTimestamps"])

    def test_codex_timestamp_hiding_install_and_remove_round_trip(self):
        original = "const app='codex';"
        patched = install.transform_codex(original, hide_timestamps=True)

        self.assertIn("scm-toolkit-codex-timestamps:start", patched)
        self.assertIn("data-scm-toolkit-hidden-chat-timestamp", patched)
        self.assertIn("looksLikeTimestamp", patched)
        self.assertIn("data-scm-toolkit-activity-cannon", patched)
        self.assertIn("data:image/png;base64,", patched)
        self.assertNotIn("__SCM_TOOLKIT_ACTIVITY_CANNON__", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_timestamp_hiding_can_coexist_with_other_codex_patches(self):
        original = CodexCountdownTests().fixture()
        patched = install.transform_codex(
            original,
            enabled=True,
            hide_promotions=True,
            hide_timestamps=True,
        )

        self.assertIn("scm-toolkit-usage-reset-countdown", patched)
        self.assertIn("scm-toolkit-codex-promotions:start", patched)
        self.assertIn("scm-toolkit-codex-timestamps:start", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)


class CodexWindowLabelRenderingTests(unittest.TestCase):
    def test_replaces_entire_codex_header_and_restores_on_default(self):
        original = "const app='codex';"
        patched = install.transform_codex(original, window_label="CelestAI")
        self.assertIn(install.CODEX_WINDOW_LABEL_START, patched)
        self.assertIn('const label = "CelestAI";', patched)
        self.assertTrue(install.codex_bundle_matches(patched))
        self.assertEqual(install.transform_codex(patched, window_label="CelestAI"), patched)
        updated = install.transform_codex(patched, window_label="Luna")
        self.assertIn('const label = "Luna";', updated)
        self.assertNotIn('const label = "CelestAI";', updated)
        self.assertEqual(install.transform_codex(patched, window_label="Codex"), original)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_label_is_scoped_and_reversible_with_other_patches(self):
        original = "const app='codex';"
        patched = install.transform_codex(original, hide_dictation=True, window_label="CelestAI")
        self.assertIn(install.CODEX_DICTATION_START, patched)
        self.assertIn(install.CODEX_WINDOW_LABEL_START, patched)
        self.assertEqual(install.transform_codex(patched, hide_dictation=True), install.transform_codex(original, hide_dictation=True))
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_malformed_header_patch_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "Incomplete Codex window-label patch"):
            install.transform_codex("const app='codex';" + install.CODEX_WINDOW_LABEL_START, window_label="CelestAI")


class CodexModelLabelTests(unittest.TestCase):
    def test_toggle_and_removal_preserve_other_patches(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexShortModelLabels"])
        original = "const app='codex';"
        other = install.transform_codex(original, hide_dictation=True)
        patched = install.transform_codex(other, hide_dictation=True, short_model_labels=True)
        self.assertIn(install.CODEX_LABELS_START, patched)
        self.assertEqual(install.transform_codex(patched, hide_dictation=True, short_model_labels=True), patched)
        self.assertEqual(install.transform_codex(patched, hide_dictation=True), other)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_incomplete_patch_is_rejected(self):
        with self.assertRaises(ValueError):
            install.transform_codex("const app='codex';" + install.CODEX_LABELS_END)

    def test_model_control_bundle_is_discovered(self):
        self.assertTrue(install.codex_bundle_matches('"data-composer-navigation-target":`reasoning`,"data-selected-reasoning-effort":effort'))


class CodexDictationTests(unittest.TestCase):
    def test_dictation_hiding_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexHideDictation"])

    def test_codex_dictation_hiding_install_and_remove_round_trip(self):
        original = "const app='codex';"
        patched = install.transform_codex(original, hide_dictation=True)

        self.assertIn("scm-toolkit-codex-dictation:start", patched)
        self.assertIn("data-scm-toolkit-hidden-dictation", patched)
        self.assertIn("looksLikeDictation", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_dictation_hiding_can_coexist_with_other_codex_patches(self):
        original = CodexCountdownTests().fixture()
        patched = install.transform_codex(
            original,
            enabled=True,
            hide_promotions=True,
            hide_timestamps=True,
            hide_dictation=True,
        )

        self.assertIn("scm-toolkit-usage-reset-countdown", patched)
        self.assertIn("scm-toolkit-codex-promotions:start", patched)
        self.assertIn("scm-toolkit-codex-timestamps:start", patched)
        self.assertIn("scm-toolkit-codex-dictation:start", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

if __name__ == "__main__":
    unittest.main()
