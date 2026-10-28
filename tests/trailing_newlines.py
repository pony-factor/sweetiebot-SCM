import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "git_auto_title_trailing_newlines", Path(__file__).parents[1] / "scripts/ai_commit.py"
)
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


class TrailingNewlineTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary_directory.name)
        subprocess.run(
            [wrapper.REAL_GIT, "init", "-q", str(self.repo)],
            check=True,
        )
        self.git("config", "core.autocrlf", "false")

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

    def test_trims_extra_lf_newlines_without_touching_interior_blank_lines(self):
        path = self.repo / "example.txt"
        path.write_bytes(b"first\n\nsecond\n\n\n")
        self.git("add", "example.txt")

        self.assertEqual(self.normalize(), ["example.txt"])
        expected = b"first\n\nsecond\n"
        self.assertEqual(self.git("show", ":example.txt").stdout, expected)
        self.assertEqual(path.read_bytes(), expected)

    def test_trims_whitespace_only_blank_lines_at_eof(self):
        path = self.repo / "example.txt"
        path.write_bytes(b"first\n\nsecond\n  \n\t\n")
        self.git("add", "example.txt")

        self.assertEqual(self.normalize(), ["example.txt"])
        expected = b"first\n\nsecond\n"
        self.assertEqual(self.git("show", ":example.txt").stdout, expected)
        self.assertEqual(path.read_bytes(), expected)

    def test_trims_whitespace_only_crlf_blank_lines_at_eof(self):
        path = self.repo / "windows.txt"
        path.write_bytes(b"first\r\n\r\nlast\r\n  \r\n\t\r\n")
        self.git("add", "windows.txt")

        self.assertEqual(self.normalize(), ["windows.txt"])
        expected = b"first\r\n\r\nlast\r\n"
        self.assertEqual(self.git("show", ":windows.txt").stdout, expected)
        self.assertEqual(path.read_bytes(), expected)

    def test_trims_extra_crlf_newlines(self):
        self.git("config", "core.autocrlf", "false")
        path = self.repo / "windows.txt"
        path.write_bytes(b"first\r\n\r\nlast\r\n\r\n\r\n")
        self.git("add", "windows.txt")

        self.assertEqual(self.normalize(), ["windows.txt"])
        expected = b"first\r\n\r\nlast\r\n"
        self.assertEqual(self.git("show", ":windows.txt").stdout, expected)
        self.assertEqual(path.read_bytes(), expected)

    def test_single_final_newline_is_unchanged(self):
        path = self.repo / "example.txt"
        path.write_bytes(b"text\n")
        self.git("add", "example.txt")

        self.assertEqual(self.normalize(), [])
        self.assertEqual(self.git("show", ":example.txt").stdout, b"text\n")
        self.assertEqual(path.read_bytes(), b"text\n")

    def test_preserves_unstaged_worktree_edits_while_trimming_index(self):
        path = self.repo / "example.txt"
        path.write_bytes(b"staged\n\n\n")
        self.git("add", "example.txt")
        worktree = b"staged\n\n\nlocal edit\n"
        path.write_bytes(worktree)

        self.assertEqual(self.normalize(), ["example.txt"])
        self.assertEqual(self.git("show", ":example.txt").stdout, b"staged\n")
        self.assertEqual(path.read_bytes(), worktree)


    def test_adds_missing_newline_and_preserves_executable_mode(self):
        path = self.repo / "script.sh"
        path.write_bytes(b"echo example")
        path.chmod(0o755)
        self.git("add", "script.sh")
        self.assertEqual(self.normalize(), ["script.sh"])
        self.assertEqual(self.git("show", ":script.sh").stdout, b"echo example\n")
        self.assertTrue(self.git("ls-files", "--stage", "script.sh").stdout.startswith(b"100755 "))
        self.assertEqual(path.stat().st_mode & 0o777, 0o755)

    def test_binary_non_utf8_empty_and_symlink_are_unchanged(self):
        contents = {"binary.bin": b"data\0\n\n", "encoded.txt": b"\xff\n\n", "empty.txt": b""}
        for name, data in contents.items():
            (self.repo / name).write_bytes(data)
        (self.repo / "shortcut").symlink_to("encoded.txt")
        self.git("add", ".")
        self.assertEqual(self.normalize(), [])
        for name, data in contents.items():
            self.assertEqual(self.git("show", ":" + name).stdout, data)
        self.assertTrue((self.repo / "shortcut").is_symlink())

    def test_respects_cached_attributes(self):
        (self.repo / ".gitattributes").write_text("binary.txt -text\nopaque.txt -diff\nfiltered.txt filter=custom\n")
        for name in ["binary.txt", "opaque.txt", "filtered.txt"]:
            (self.repo / name).write_bytes(b"text\n\n")
        self.git("add", ".")
        # Staged attributes remain authoritative even when the working copy differs.
        (self.repo / ".gitattributes").write_text("")
        self.assertEqual(self.normalize(), [])
        for name in ["binary.txt", "opaque.txt", "filtered.txt"]:
            self.assertEqual(self.git("show", ":" + name).stdout, b"text\n\n")

    def test_normalizes_from_a_subdirectory_with_literal_filename(self):
        (self.repo / "subdir").mkdir()
        path = self.repo / "[report].txt"
        path.write_bytes(b"text\n\n")
        self.git("add", "--", "[report].txt")
        with patch.object(wrapper, "GIT_GLOBAL_ARGS", ["-C", str(self.repo / "subdir")]):
            self.assertEqual(wrapper.normalize_staged_final_newlines(), ["[report].txt"])
        self.assertEqual(self.git("show", ":[report].txt").stdout, b"text\n")


if __name__ == "__main__":
    unittest.main()
