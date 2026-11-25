import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "seed_brave_profile", Path(__file__).resolve().parents[2] / "extension/branches/seed-brave-profile.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class DevelopmentBrowserTests(unittest.TestCase):
    def test_snapshot_includes_wal_preserves_source_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            normal, test = root / "normal", root / "test"
            normal.mkdir()
            with closing(sqlite3.connect(normal / "Cookies")) as source:
                source.execute("PRAGMA journal_mode=WAL")
                source.execute("CREATE TABLE fixture (value TEXT)")
                source.execute("INSERT INTO fixture VALUES ('synthetic')")
                source.commit()
                self.assertTrue(helper.seed(normal, test, lambda _: False))
                source.execute("INSERT INTO fixture VALUES ('later')")
                source.commit()
                self.assertFalse(helper.seed(normal, test, lambda _: False))
                self.assertEqual(source.execute("SELECT COUNT(*) FROM fixture").fetchone(), (2,))
            target = test / "Default/Cookies"
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with closing(sqlite3.connect(target)) as copied:
                self.assertEqual(copied.execute("SELECT * FROM fixture").fetchall(), [("synthetic",)])

    def test_running_browser_and_existing_sidecars_skip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(helper.seed(root / "normal", root / "test", lambda _: True))
            target = root / "test/Default/Network"
            target.mkdir(parents=True)
            (target / "Cookies-wal").touch()
            self.assertFalse(helper.seed(root / "normal", root / "test", lambda _: False))

    def test_same_profile_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                helper.seed(root / "Default", root, lambda _: False)

    def test_running_browser_during_backup_does_not_publish_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            normal = root / "normal"
            normal.mkdir()
            with closing(sqlite3.connect(normal / "Cookies")) as source:
                source.execute("CREATE TABLE fixture (value TEXT)")
                source.commit()
            states = iter((False, True))
            self.assertFalse(helper.seed(normal, root / "test", lambda _: next(states)))
            self.assertFalse((root / "test/Default/Cookies").exists())


if __name__ == "__main__":
    unittest.main()
