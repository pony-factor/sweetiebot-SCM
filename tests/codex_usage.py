import unittest
import subprocess

import install

import codex_usage


FIXTURE = '''function label(e){return (0,R.jsx)(Thing,{id:`composer.mode.local`,rateLimit:limit})}function next(){}
let{data:d}=query(options),u=d===void 0?null:d,plan=u?.plan_type;
className:`hidden in-data-[composer-placement=home]:inline`,children:(0,R.jsx)(label,{...props.localShort})
reset=stamp==null?null:format(stamp),cache[0]=bucket.resetsAt;
(0,R.jsx)(Thing,{title:reset,className:`reset`,children:reset});'''


class CodexUsageTests(unittest.TestCase):
    def test_usage_meter_and_native_local_mode_are_reversible(self):
        original = FIXTURE + '''function mode(e){let t=cache(3),{composerMode:n,setComposerMode:r}=e,[open,setOpen]=(0,React.useState)(false);return n}'''
        for cloud in (False, True):
            patched = codex_usage.transform(original, pie_indicator=True, cloud_tasks=cloud)
            self.assertIn('jsx)(`scm-toolkit-usage-meter`,{percent,"weekly-percent":scmToolkitWeeklyRemainingUsage(usage)??"unavailable"})', patched)
            self.assertIn('e=scmToolkitLocalComposerProps(e,React.useEffect);', patched)
            self.assertIn(f'const scmToolkitCloudTasks = {str(cloud).lower()}', patched)
            self.assertEqual(codex_usage.transform(patched, pie_indicator=True, cloud_tasks=cloud), patched)
            self.assertEqual(codex_usage.transform(patched, enabled=False), original)
        with self.assertRaisesRegex(ValueError, 'native execution mode controls'):
            codex_usage.transform(original.replace('React.useState', 'React.futureState'), pie_indicator=True)

    def test_combined_usage_and_reset_patches_parse_as_es_module(self):
        original = """function label(e){return (0,R.jsx)(Thing,{id:`composer.mode.local`,rateLimit:limit})}function next(){}
let{data:d}=query(options),u=d===void 0?null:d,plan=u?.plan_type;
const home={className:`hidden in-data-[composer-placement=home]:inline`,children:(0,R.jsx)(label,{...props.localShort})};
let reset,cache=[null];reset=stamp==null?null:format(stamp),cache[0]=bucket.resetsAt;
(0,R.jsx)(Thing,{title:reset,className:`reset`,children:reset});"""
        for pie in (False, True):
            with self.subTest(pie=pie):
                usage = codex_usage.transform(original, hide_reset_times=True, pie_indicator=pie, reset_countdown=False)
                combined = install.transform_codex(usage, hide_reset_times=True, sticker_enabled=False)
                checked = subprocess.run(['node', '--input-type=module', '--check'], input=combined,
                                         text=True, capture_output=True)
                self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_reset_customizations_are_idempotent_and_reversible(self):
        for hide in (False, True):
            with self.subTest(hide=hide):
                patched = codex_usage.transform(FIXTURE, hide_reset_times=hide)
                self.assertEqual(codex_usage.transform(patched, hide_reset_times=hide), patched)
                self.assertEqual(codex_usage.transform(patched, enabled=False), FIXTURE)
                if hide:
                    self.assertIn('reset=null,cache[0]=bucket.resetsAt', patched)
                else:
                    self.assertIn('"reset-at":bucket.resetsAt', patched)

    def test_reset_time_pie_is_opt_in_reversible_and_independent(self):
        patched = codex_usage.transform(FIXTURE, reset_countdown=False, reset_time_pie=True)
        self.assertIn('"show-pie":"true"', patched)
        self.assertIn('"window-minutes":bucket.windowDurationMins', patched)
        self.assertEqual(codex_usage.transform(patched, reset_countdown=False, reset_time_pie=True), patched)
        self.assertEqual(codex_usage.transform(patched, enabled=False), FIXTURE)
        self.assertNotIn('"show-pie":"true"', codex_usage.transform(FIXTURE, reset_countdown=True))
        hidden = codex_usage.transform(FIXTURE, reset_time_pie=True, hide_reset_times=True)
        self.assertNotIn('"show-pie":"true"', hidden)

    def test_hide_only_is_independent_of_countdown(self):
        patched = codex_usage.transform(FIXTURE, hide_reset_times=True, reset_countdown=False)
        self.assertIn('scmToolkitStripUsageResetTime', patched)
        self.assertIn('function label(e)', patched.split(codex_usage.START)[0])
        self.assertEqual(codex_usage.transform(patched, hide_reset_times=True, reset_countdown=False), patched)
        self.assertEqual(codex_usage.transform(patched, enabled=False), FIXTURE)


if __name__ == '__main__':
    unittest.main()
