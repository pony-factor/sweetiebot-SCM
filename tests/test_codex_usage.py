import unittest

import codex_usage


FIXTURE = '''function label(e){return (0,R.jsx)(Thing,{id:`composer.mode.local`,rateLimit:limit})}function next(){}
let{data:d}=query(options),u=d===void 0?null:d,plan=u?.plan_type;
className:`hidden in-data-[composer-placement=home]:inline`,children:(0,R.jsx)(label,{...props.localShort})
reset=stamp==null?null:format(stamp),cache[0]=bucket.resetsAt;
(0,R.jsx)(Thing,{title:reset,className:`reset`,children:reset});'''


class CodexUsageTests(unittest.TestCase):
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
