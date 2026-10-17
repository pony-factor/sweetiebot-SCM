import unittest
import tempfile
import plistlib
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
        self.assertEqual(env["OLLAMA_NUM_PARALLEL"], "4")
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

    def test_existing_serial_commit_service_is_upgraded_once(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            agent = home / 'Library/LaunchAgents' / (worker.LABEL + '.plist')
            agent.parent.mkdir(parents=True)
            previous = worker.service_definition('/opt/homebrew/bin/ollama', home)
            previous['EnvironmentVariables']['OLLAMA_NUM_PARALLEL'] = '1'
            agent.write_bytes(plistlib.dumps(previous))
            with patch.object(worker.sys, 'platform', 'darwin'), patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run, patch.object(worker, 'ready', return_value=True):
                worker.install(home, '/opt/homebrew/bin/ollama')
                calls = [call.args[0] for call in run.call_args_list]
                self.assertEqual(calls[1], ['/bin/launchctl', 'bootout', f'gui/{worker.os.getuid()}/{worker.LABEL}'])
                self.assertEqual(calls[2][-1], str(agent))
                self.assertEqual(plistlib.loads(agent.read_bytes())['EnvironmentVariables']['OLLAMA_NUM_PARALLEL'], '4')
                run.reset_mock()
                worker.install(home, '/opt/homebrew/bin/ollama')
                self.assertEqual(len(run.call_args_list), 2, 'unchanged parallel settings do not restart the service')


if __name__ == "__main__":
    unittest.main()
