import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import ollama_concurrency as worker


class WorkerTests(unittest.TestCase):
    def test_worker_is_isolated_with_shared_weights_and_bounded_memory(self):
        definition = worker.service_definition("/opt/homebrew/bin/ollama", Path("/Users/test"))
        env = definition["EnvironmentVariables"]
        self.assertEqual(env["OLLAMA_HOST"], "127.0.0.1:11435")
        self.assertEqual(env["OLLAMA_MODELS"], "/Users/test/.ollama/models")
        self.assertEqual(env["OLLAMA_MAX_LOADED_MODELS"], "1")
        self.assertEqual(env["OLLAMA_NUM_PARALLEL"], "1")
        self.assertEqual(env["OLLAMA_KV_CACHE_TYPE"], "q8_0")
        self.assertEqual(definition["ProgramArguments"], ["/opt/homebrew/bin/ollama", "serve"])

    def test_existing_worker_is_not_restarted_and_endpoint_changes_only_when_ready(self):
        with patch.object(worker.sys, "platform", "darwin"), patch.object(worker.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run, patch.object(worker, "ready", return_value=True):
            worker.install(Path("/Users/test"), "/opt/homebrew/bin/ollama")
        self.assertEqual(len(run.call_args_list), 2)
        self.assertEqual(run.call_args_list[0].args[0][1], "print")
        self.assertEqual(run.call_args_list[1].args[0], ["/usr/bin/git", "config", "--global", worker.CONFIG_KEY, worker.URL])

    def test_failed_worker_does_not_change_commit_endpoint(self):
        with patch.object(worker.sys, "platform", "darwin"), patch.object(worker.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run, patch.object(worker, "ready", return_value=False), patch.object(worker.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "endpoint was not changed"):
                worker.install(Path("/Users/test"), "/opt/homebrew/bin/ollama")
        self.assertEqual(len(run.call_args_list), 1)


if __name__ == "__main__":
    unittest.main()
