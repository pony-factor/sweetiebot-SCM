
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

import re
import json
import io
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import configurator
import install
import branch_names
import toolkit_settings
from pathlib import Path



# Allow direct script execution as well as the CI unittest module runner.
_sb_root = str(_sb_path(__file__).resolve().parents[2])
if _sb_root not in _sb_sys.path:
    _sb_sys.path.insert(0, _sb_root)

from tests.fixtures.configurator_support import form_values


class OllamaTests(unittest.TestCase):
    @patch("configurator.urllib.request.build_opener")
    def test_reads_models_from_local_ollama(self, build_opener):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"models": [{"name": "qwen:test"}, {"model": "other:test"}]}
        ).encode()
        build_opener.return_value.open.return_value = response

        models, status = configurator.fetch_ollama_models()

        self.assertEqual(models, ["other:test", "qwen:test"])
        self.assertIn("2 local Ollama models", status)
        build_opener.return_value.open.assert_called_once_with(
            "http://127.0.0.1:11434/api/tags", timeout=2
        )


class ModelSetupTests(unittest.TestCase):
    def test_missing_embedding_model_blocks_save_even_with_chat_models(self):
        settings = dict(install.DEFAULT_SETTINGS)
        with patch("configurator.fetch_ollama_models", return_value=(["qwen2.5-coder:7b", "qwen2.5-coder:3b"], "Ollama ready")):
            with self.assertRaisesRegex(ValueError, "Search embedding model.*not installed"):
                configurator.validate_models(settings)

    def test_chat_model_cannot_be_used_for_embeddings(self):
        settings = dict(install.DEFAULT_SETTINGS, workspaceSearchEmbeddingModel="qwen2.5-coder:3b")
        with patch("configurator.fetch_ollama_models", return_value=(["qwen2.5-coder:7b", "qwen2.5-coder:3b"], "Ready")), patch("configurator.ollama_request", return_value=io.BytesIO(b'{"capabilities":["completion"]}')):
            with self.assertRaisesRegex(ValueError, "does not support embeddings"):
                configurator.validate_models(settings)

    def test_spellcheck_model_is_only_required_when_preview_is_enabled(self):
        settings = dict(
            install.DEFAULT_SETTINGS,
            aiCommit=False,
            workspaceSearchEmbeddingModel="embed",
            spellcheckModel="missing:spell",
        )
        with patch("configurator.fetch_ollama_models", return_value=(["embed:latest"], "Ready")), patch(
            "configurator.ollama_request", return_value=io.BytesIO(b'{"capabilities":["embedding"]}')
        ):
            configurator.validate_models(settings)
            settings["spellcheckManualCommit"] = True
            with self.assertRaisesRegex(ValueError, "Spellcheck model.*not installed"):
                configurator.validate_models(settings)

    def test_optional_chat_model_need_not_be_installed_when_disabled(self):
        settings = dict(install.DEFAULT_SETTINGS, aiCommit=False, workspaceSearchEmbeddingModel="embed", workspaceSearchChatModel="missing:chat")
        with patch("configurator.fetch_ollama_models", return_value=(["embed:latest"], "Ready")), patch("configurator.ollama_request", return_value=io.BytesIO(b'{"capabilities":["embedding"]}')):
            configurator.validate_models(settings)

    def test_rejects_empty_or_invalid_download_tag(self):
        for value in ["", "name\nother", "-option", "name;command"]:
            with self.assertRaises(ValueError):
                configurator.model_tag(value)

    def test_rendered_setup_script_is_valid_javascript(self):
        import subprocess
        import tempfile
        from pathlib import Path
        page = configurator.render_form(install.DEFAULT_SETTINGS, ["</script>"], "Ready", "test-token", "Save")
        script = page.split("<script>")[1].split("</script>")[0]
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "setup.js"
            path.write_text(script)
            subprocess.run(["node", "--check", str(path)], check=True, capture_output=True)
        self.assertIn('name="workspaceSearchEmbeddingModel"', page)
        self.assertIn('class="download-model"', page)

    def test_model_picker_uses_anchored_custom_dropdown(self):
        page = configurator.render_form(
            install.DEFAULT_SETTINGS,
            ["qwen3-embedding:0.6b", "qwen2.5-coder:7b"],
            "Ready",
            "test-token",
            "Save",
        )

        self.assertIn('class="model-picker"', page)
        self.assertIn('class="model-options" role="listbox"', page)
        self.assertIn('role="combobox"', page)
        self.assertIn('class="model-picker-toggle"', page)
        self.assertIn('position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:1000', page)
        self.assertIn("function openModelPicker", page)
        self.assertIn("function chooseModel", page)
        self.assertIn("You can still enter a model tag manually.", page)
        self.assertNotIn("<datalist", page)
        self.assertNotIn('list="ollama-models"', page)

if __name__ == "__main__":
    unittest.main()
