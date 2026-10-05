import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "scm_toolkit_model_picker", Path(__file__).parents[1] / "scripts/model_picker.py"
)
model_picker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model_picker)


class RecommendationTests(unittest.TestCase):
    def test_recommendations_scale_with_system_memory(self):
        self.assertEqual(
            model_picker.recommend_models(8),
            ("qwen2.5-coder:3b", "qwen2.5-coder:1.5b"),
        )
        self.assertEqual(
            model_picker.recommend_models(16),
            ("qwen2.5-coder:7b", "qwen2.5-coder:3b"),
        )
        self.assertEqual(
            model_picker.recommend_models(32),
            ("qwen2.5-coder:14b", "qwen2.5-coder:7b"),
        )
        self.assertEqual(
            model_picker.recommend_models(64),
            ("qwen2.5-coder:32b", "qwen2.5-coder:14b"),
        )

    def test_unknown_memory_uses_balanced_defaults(self):
        self.assertEqual(
            model_picker.recommend_models(None),
            ("qwen2.5-coder:7b", "qwen2.5-coder:3b"),
        )

    def test_choices_include_installed_current_and_recommended_models(self):
        choices = model_picker.model_choices(
            {"custom-code:latest"},
            "primary:test",
            "fallback:test",
            ("qwen2.5-coder:14b", "qwen2.5-coder:7b"),
        )
        for model in (
            "custom-code:latest",
            "primary:test",
            "fallback:test",
            "qwen2.5-coder:14b",
            "qwen2.5-coder:7b",
        ):
            self.assertIn(model, choices)


class ConfigurationTests(unittest.TestCase):
    @patch("model_picker.subprocess.run")
    def test_set_git_config_writes_global_toolkit_key(self, run):
        run.return_value = types.SimpleNamespace(returncode=0, stdout="", stderr="")
        model_picker.set_git_config(
            "scm-toolkit.ai-commit-low-memory-model", "qwen2.5-coder:3b"
        )
        run.assert_called_once_with(
            [
                model_picker.REAL_GIT,
                "config",
                "--global",
                "scm-toolkit.ai-commit-low-memory-model",
                "qwen2.5-coder:3b",
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_applescript_strings_escape_quotes_and_backslashes(self):
        self.assertEqual(
            model_picker.applescript_string('model\\"name'),
            '"model\\\\\\"name"',
        )


if __name__ == "__main__":
    unittest.main()
