
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
        self.assertEqual(env["OLLAMA_NUM_PARALLEL"], "6")
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

    def test_existing_four_slot_commit_service_is_upgraded_once(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            agent = home / 'Library/LaunchAgents' / (worker.LABEL + '.plist')
            agent.parent.mkdir(parents=True)
            previous = worker.service_definition('/opt/homebrew/bin/ollama', home)
            previous['EnvironmentVariables']['OLLAMA_NUM_PARALLEL'] = '4'
            agent.write_bytes(plistlib.dumps(previous))
            with patch.object(worker.sys, 'platform', 'darwin'), patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run, patch.object(worker, 'ready', return_value=True):
                worker.install(home, '/opt/homebrew/bin/ollama')
                calls = [call.args[0] for call in run.call_args_list]
                self.assertEqual(calls[1], ['/bin/launchctl', 'bootout', f'gui/{worker.os.getuid()}/{worker.LABEL}'])
                self.assertEqual(calls[2][-1], str(agent))
                self.assertEqual(plistlib.loads(agent.read_bytes())['EnvironmentVariables']['OLLAMA_NUM_PARALLEL'], '6')
                run.reset_mock()
                worker.install(home, '/opt/homebrew/bin/ollama')
                self.assertEqual(len(run.call_args_list), 2, 'unchanged parallel settings do not restart the service')

    def test_bootstrap_retries_while_launchd_finishes_removing_the_old_service(self):
        with patch.object(worker.subprocess, 'run', side_effect=[SimpleNamespace(returncode=5), SimpleNamespace(returncode=0)]) as run, patch.object(worker.time, 'sleep') as sleep:
            worker.bootstrap(Path('/test/worker.plist'))
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(.25)

    def test_recovery_bootstraps_an_installed_but_unloaded_commit_agent(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            agent = home / 'Library/LaunchAgents' / (worker.LABEL + '.plist')
            agent.parent.mkdir(parents=True)
            agent.touch()
            with patch.object(worker.sys, 'platform', 'darwin'), patch.object(Path, 'home', return_value=home), \
                    patch.object(worker, 'ready', side_effect=[False, True]), \
                    patch.object(worker.subprocess, 'Popen') as spawn, \
                    patch.object(worker.subprocess, 'run', side_effect=[
                        SimpleNamespace(returncode=1), SimpleNamespace(returncode=0),
                    ]) as run:
                worker.recover(worker.URL, 2, home / 'jobs')
            spawn.assert_not_called()
            self.assertEqual(run.call_args.args[0],
                             ['/bin/launchctl', 'bootstrap', f'gui/{worker.os.getuid()}', str(agent)])

    def test_recovery_starts_the_cli_on_the_configured_port(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(worker.sys, 'platform', 'linux'), \
                    patch.object(worker.shutil, 'which', return_value='/bin/echo'), \
                    patch.object(worker, 'ready', side_effect=[False, True]), \
                    patch.object(worker.subprocess, 'Popen') as spawn:
                worker.recover('http://127.0.0.1:35434', 2, Path(folder))
            self.assertEqual(spawn.call_args.args[0], ['/bin/echo', 'serve'])
            self.assertEqual(spawn.call_args.kwargs['env']['OLLAMA_HOST'], '127.0.0.1:35434')

    def test_recovery_reports_missing_ollama(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(worker.sys, 'platform', 'linux'), \
                    patch.object(worker.shutil, 'which', return_value=None), \
                    patch.object(worker, 'ready', return_value=False), \
                    self.assertRaisesRegex(worker.OllamaUnavailable, 'Install Ollama'):
                worker.recover(worker.URL, 2, Path(folder))

    def test_recovery_reports_missing_ollama_with_a_leftover_launch_agent(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            agent = home / 'Library/LaunchAgents' / (worker.LABEL + '.plist')
            agent.parent.mkdir(parents=True)
            agent.touch()
            with patch.object(worker.sys, 'platform', 'darwin'), patch.object(Path, 'home', return_value=home), \
                    patch.object(worker, 'installed_binary', return_value=None), \
                    patch.object(worker, 'ready', return_value=False), \
                    patch.object(worker.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
                    self.assertRaisesRegex(worker.OllamaUnavailable, 'Install Ollama'):
                worker.recover(worker.URL, 0.1, home / 'jobs')


if __name__ == "__main__":
    unittest.main()
