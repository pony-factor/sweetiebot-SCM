import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "git_auto_title_trailing_whitespace", Path(__file__).parents[1] / "scripts/ai_commit.py"
)
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


class TrailingWhitespaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary_directory.name)
        subprocess.run([wrapper.REAL_GIT, "init", "-q", str(self.repo)], check=True)
        self.git("config", "core.hooksPath", "/dev/null")
        self.git("config", "core.autocrlf", "false")
        self.git("config", "user.name", "Test User")
        self.git("config", "user.email", "test@example.com")

    def tearDown(self):
        self.temporary_directory.cleanup()

    def git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [wrapper.REAL_GIT, "-C", str(self.repo), *args],
            check=True,
            capture_output=True,
        )

    def normalize(self) -> list[str]:
        with patch.object(wrapper, "GIT_GLOBAL_ARGS", ["-C", str(self.repo)]):
            return wrapper.normalize_staged_final_newlines()

    def test_strips_trailing_whitespace_only_from_added_lines(self):
        path = self.repo / "example.txt"
        path.write_bytes(b"keep trailing spaces  \nreplace me\n")
        self.git("add", "example.txt")
        self.git("commit", "-qm", "base")

        path.write_bytes(b"keep trailing spaces  \nreplace me   \nnew line\t  \n")
        self.git("add", "example.txt")

        self.assertEqual(self.normalize(), ["example.txt"])
        expected = b"keep trailing spaces  \nreplace me\nnew line\n"
        self.assertEqual(self.git("show", ":example.txt").stdout, expected)
        self.assertEqual(path.read_bytes(), expected)

    def test_strips_added_whitespace_and_preserves_crlf(self):
        self.git("config", "core.autocrlf", "false")
        path = self.repo / "windows.txt"
        path.write_bytes(b"first  \r\nsecond\t \r\n")
        self.git("add", "windows.txt")

        self.assertEqual(self.normalize(), ["windows.txt"])
        expected = b"first\r\nsecond\r\n"
        self.assertEqual(self.git("show", ":windows.txt").stdout, expected)
        self.assertEqual(path.read_bytes(), expected)


    def test_preserves_unstaged_edits_while_trimming_the_index(self):
        path = self.repo / "example.txt"
        path.write_bytes(b"staged spaces  \n\n")
        self.git("add", "example.txt")
        unstaged = b"local edit  \n"
        path.write_bytes(unstaged)
        self.assertEqual(self.normalize(), ["example.txt"])
        self.assertEqual(self.git("show", ":example.txt").stdout, b"staged spaces\n")
        self.assertEqual(path.read_bytes(), unstaged)

    def test_already_clean_added_lines_are_unchanged(self):
        path = self.repo / "example.txt"
        path.write_bytes(b"already clean\n")
        self.git("add", "example.txt")
        self.assertEqual(self.normalize(), [])

    def test_combines_whitespace_cleanup_with_one_final_crlf(self):
        path = self.repo / "example.txt"
        path.write_bytes(b"first  \r\n\r\nlast\t \r\n\r\n\r\n")
        self.git("add", "example.txt")
        self.assertEqual(self.normalize(), ["example.txt"])
        self.assertEqual(self.git("show", ":example.txt").stdout, b"first\r\n\r\nlast\r\n")


if __name__ == "__main__":
    unittest.main()
