"""Regression tests for the opt-in Core ML backend protocol."""
import importlib.util
from contextlib import ExitStack, nullcontext
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / "scripts"
spec = importlib.util.spec_from_file_location("coreml_backend", ROOT / "coreml_backend.py")
coreml = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coreml)


ai_spec = importlib.util.spec_from_file_location("ai_commit_ane_test", ROOT / "ai_commit.py")
ai_commit = importlib.util.module_from_spec(ai_spec)
ai_spec.loader.exec_module(ai_commit)


class CoreMLBackendTests(unittest.TestCase):
    def tearDown(self):
        coreml.shutdown()

    def test_missing_executable_disables_model_discovery(self):
        with patch.object(coreml.sys, "platform", "darwin"):
            self.assertFalse(coreml.available("/no/such/sweetiebot-ane"))

    def test_coreml_timeout_allows_recurrent_prefill_and_respects_overrides(self):
        with patch.object(ai_commit, "coreml_backend_enabled", return_value=True):
            with patch.object(ai_commit, "git_config_string", return_value=""):
                self.assertEqual(ai_commit.generation_request_seconds(), 300)
            with patch.object(ai_commit, "git_config_string", return_value="60"):
                self.assertEqual(ai_commit.generation_request_seconds(), 60)
        with patch.object(ai_commit, "coreml_backend_enabled", return_value=False), \
                patch.object(ai_commit, "git_config_string", return_value=""):
            self.assertEqual(ai_commit.generation_request_seconds(), 45)

    def test_generation_preserves_prompt_and_schema_with_long_lived_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            command = Path(temp) / "fake_ane"
            command.write_text(
                "#!/usr/bin/env python3\n"
                "import json,sys\n"
                "for line in sys.stdin:\n"
                " request=json.loads(line)\n"
                " print(json.dumps({'response': json.dumps({'subject': '🔩 Connect AI runtime', "
                "'description': 'Add a Core ML bridge.'}), 'done_reason': 'stop'}), flush=True)\n",
                encoding="utf-8",
            )
            command.chmod(command.stat().st_mode | stat.S_IXUSR)
            with patch.object(coreml.sys, "platform", "darwin"):
                payload = {
                    "model": "qwen3.5-2b", "prompt": "summarize a diff",
                    "format": {"type": "object", "properties": {"subject": {"type": "string"}}},
                    "options": {"num_predict": 300},
                }
                first = coreml.generate(str(command), payload, 3)
                worker = coreml.worker_for(str(command))
                before = worker.process.pid
                second = coreml.generate(str(command), payload, 3)
                self.assertEqual(before, worker.process.pid)
                self.assertIn("Connect AI runtime", first["response"])
                self.assertEqual(first, second)

    def test_commit_routing_is_opt_in_and_keeps_ollama_default(self):
        with patch.dict(os.environ, {"SWEETIEBOT_AI_BACKEND": "coreml"}):
            with patch.object(ai_commit.coreml_backend, "available", return_value=True), \
                    patch.object(ai_commit.coreml_backend, "generate",
                                 return_value={"response": "ok", "done_reason": "stop"}) as generate:
                self.assertEqual(ai_commit.configured_models(), ("qwen3.5-2b", "qwen3.5-0.8b"))
                self.assertEqual(ai_commit.installed_local_model_names(),
                                 {"qwen3.5-2b", "qwen3.5-0.8b"})
                result = ai_commit.ollama_json(
                    "/api/generate", {"model": "qwen3.5-2b", "prompt": "test"}, timeout=3)
                self.assertEqual(result["response"], "ok")
                generate.assert_called_once()
        with patch.dict(os.environ, {"SWEETIEBOT_AI_BACKEND": "ollama"}):
            self.assertFalse(ai_commit.coreml_backend_enabled())

    def test_rejects_invalid_model_without_launching(self):
        with patch.object(coreml, "available", return_value=True):
            with self.assertRaises(ValueError):
                coreml.generate("/tmp/ane", {"model": "", "prompt": "hello"}, 1)

    def test_backend_order_normalizes_duplicates_and_preserves_legacy_default(self):
        for value, expected in [(" coreml, ollama,coreml ", ("coreml", "ollama")),
                                ("ollama,coreml", ("ollama", "coreml")),
                                ("unknown", ("ollama",))]:
            with self.subTest(value=value), patch.dict(os.environ, {"SWEETIEBOT_AI_BACKEND": value}):
                self.assertEqual(ai_commit.configured_backends(), expected)

    def test_generation_tries_backend_order_after_failure_or_invalid_output(self):
        for order, invalid in [("coreml,ollama", False), ("ollama,coreml", False),
                               ("coreml,ollama", True)]:
            with self.subTest(order=order, invalid=invalid), ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, {"SWEETIEBOT_AI_BACKEND": order}))
                for name, value in [("git_config_string", None),
                                    ("available_memory_bytes", 32 * 1024**3),
                                    ("generation_attempts", 1), ("commit_fallback_enabled", True),
                                    ("commit_custom_instructions", ""), ("recent_subjects", ""),
                                    ("emoji_priority_enabled", False), ("title_explanations_enabled", False),
                                    ("log_event", None), ("title_generation_slot", nullcontext())]:
                    if name == "git_config_string":
                        stack.enter_context(patch.object(ai_commit, name, side_effect=lambda key, default="": default))
                    else:
                        stack.enter_context(patch.object(ai_commit, name, return_value=value))
                first = order.split(",")[0]
                requests = []
                def request(path, payload=None, timeout=None):
                    backend = "coreml" if ai_commit.coreml_backend_enabled() else "ollama"
                    model = ai_commit.configured_models()[0]
                    if path == "/api/tags":
                        return {"models": [{"name": model}]}
                    if path == "/api/show":
                        return {"thinking": {}}
                    requests.append((backend, payload["model"], ai_commit.generation_request_seconds()))
                    if backend == first:
                        if invalid:
                            return {"response": "not a commit message", "done_reason": "stop"}
                        raise RuntimeError("Backend unavailable")
                    return {"response": json.dumps({"subject": "🔧 Add adapter installation", "description": ""}),
                            "done_reason": "stop"}
                stack.enter_context(patch.object(ai_commit, "ollama_json", side_effect=request))
                title, _ = ai_commit.generate_message(
                    "", "+Install the Core ML adapter alongside the Git wrapper", ["scripts/install.py"],
                    require_model=True, file_context_override="")
                self.assertIn("Add adapter installation", title)
                self.assertEqual([item[0] for item in requests], order.split(","))
                self.assertEqual({item[0]: item[1] for item in requests},
                                 {"coreml": "qwen3.5-2b", "ollama": ai_commit.DEFAULT_MODEL})
                self.assertEqual({item[0]: item[2] for item in requests}, {"coreml": 300, "ollama": 45})
                self.assertIsNone(ai_commit.COMMIT_BACKEND.get())
                self.assertIsNone(ai_commit.GENERATION_DEADLINE.get())

    def test_all_backends_fail_before_simple_fallback_or_strict_error(self):
        for strict in (False, True):
            with self.subTest(strict=strict), patch.dict(os.environ, {"SWEETIEBOT_AI_BACKEND": "coreml,ollama"}), \
                    patch.object(ai_commit, "commit_fallback_enabled", return_value=True), \
                    patch.object(ai_commit, "log_event"), \
                    patch.object(ai_commit, "fallback_message", return_value=("🔧 Update adapter", "")) as fallback:
                attempted = []
                @ai_commit.backend_preference
                def fail(*args, **kwargs):
                    attempted.append(ai_commit.COMMIT_BACKEND.get())
                    self.assertTrue(kwargs["require_model"])
                    raise RuntimeError("Unavailable")
                if strict:
                    with self.assertRaisesRegex(RuntimeError, "No preferred commit backend"):
                        fail("", "", ["adapter.py"], require_model=True, file_context_override="")
                    fallback.assert_not_called()
                else:
                    self.assertEqual(fail("", "", ["adapter.py"], file_context_override=""), ("🔧 Update adapter", ""))
                    fallback.assert_called_once()
                self.assertEqual(attempted, ["coreml", "ollama"])
                self.assertIsNone(ai_commit.COMMIT_BACKEND.get())


if __name__ == "__main__":
    unittest.main()
