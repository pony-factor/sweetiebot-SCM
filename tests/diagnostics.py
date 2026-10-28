import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import sweetiebot_diagnostics as diagnostics


class DiagnosticsTests(unittest.TestCase):
    def test_writes_structured_private_log_with_only_allowlisted_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            location = Path(temp) / "nested" / "sweetiebot.log"
            with patch.dict(os.environ, {"SWEETIEBOT_LOG_FILE": str(location)}):
                self.assertTrue(diagnostics.log_event(
                    "commit_title", "output_rejected", model="local",
                    attempt=1, attempts=3, reason="filename_only", outcome="retry",
                    prompt="PRIVATE DIFF", response="PRIVATE CHAT", error="secret",
                ))
            row = json.loads(location.read_text(encoding="utf-8").strip())
            self.assertEqual(row["component"], "commit_title")
            self.assertEqual(row["reason"], "filename_only")
            self.assertEqual(row["attempt"], 1)
            self.assertIn("timestamp", row)
            self.assertNotIn("PRIVATE", location.read_text(encoding="utf-8"))
            self.assertEqual(stat.S_IMODE(location.stat().st_mode), 0o600)

    def test_rotates_and_bounds_log_size(self):
        with tempfile.TemporaryDirectory() as temp:
            location = Path(temp) / "sweetiebot.log"
            with patch.dict(os.environ, {"SWEETIEBOT_LOG_FILE": str(location)}), patch.object(
                diagnostics, "MAX_LOG_BYTES", 500
            ):
                for index in range(20):
                    self.assertTrue(diagnostics.log_event(
                        "commit_title", "output_rejected", model="local",
                        attempt=index, reason="invalid_message",
                    ))
            self.assertTrue(location.with_name("sweetiebot.log.1").exists())
            self.assertLessEqual(location.stat().st_size, 500)
            self.assertFalse(location.with_name("sweetiebot.log.4").exists())

    def test_bad_log_path_does_not_fail_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            blocking_file = Path(temp) / "file"
            blocking_file.write_text("original")
            with patch.dict(os.environ, {
                "SWEETIEBOT_LOG_FILE": str(blocking_file / "cannot-create.log")
            }):
                self.assertFalse(diagnostics.log_event("commit_title", "failed"))
            self.assertEqual(blocking_file.read_text(), "original")

    def test_rejects_symlinked_log(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "private"
            destination.write_text("unchanged")
            log = Path(temp) / "sweetiebot.log"
            log.symlink_to(destination)
            with patch.dict(os.environ, {"SWEETIEBOT_LOG_FILE": str(log)}):
                self.assertFalse(diagnostics.log_event("commit_title", "failed"))
            self.assertEqual(destination.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
