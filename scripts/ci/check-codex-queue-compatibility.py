"""Check real Codex queue bundles without launching Codex or modifying its files."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import importaliases
importaliases.install()
import codex_queued_edit as patcher


def installed_extension(directory):
    candidates = sorted(path for path in Path(directory).glob('openai.chatgpt-*') if path.is_dir())
    if len(candidates) != 1:
        raise ValueError('Expected exactly one freshly installed openai.chatgpt extension.')
    return candidates[0]


def check(extension, report):
    extension = Path(extension)
    manifest = json.loads((extension / 'package.json').read_text())
    if manifest.get('publisher', '').lower() != 'openai' or manifest.get('name') != 'chatgpt':
        raise ValueError('Expected the official openai.chatgpt package.')
    report['version'] = manifest['version']
    report['platform'] = manifest.get('__metadata', {}).get('targetPlatform', 'unspecified')
    patches = patcher.patch_files(extension)
    if len(patches) != 2:
        raise ValueError('Expected both native queue store and row adapters.')
    for path, original, patched in patches:
        kind = 'store' if 'scmToolkitRegisterQueueStore(' in patched.split(patcher.START)[0] else 'rows'
        entry = {'file': str(path.relative_to(extension)), 'adapter': kind, 'status': 'checking'}
        report['assets'].append(entry)
        pristine = patcher.transform(original, kind, False)
        entry['sha256'] = hashlib.sha256(pristine.encode()).hexdigest()
        if patcher.transform(patched, kind) != patched:
            raise ValueError(f'{kind} adapter is not idempotent.')
        if patcher.transform(patched, kind, False) != pristine:
            raise ValueError(f'{kind} adapter cannot restore the exact original bundle.')
        result = subprocess.run(['node', '--input-type=module', '--check'], input=patched,
                                text=True, capture_output=True, timeout=60)
        if result.returncode:
            raise ValueError(f'{kind} adapter produces invalid JavaScript (Node exit {result.returncode}).')
        if path.read_text() != original:
            raise ValueError('Compatibility checks must leave the installed bundle unchanged.')
        entry['status'] = 'passed'
    if {entry['adapter'] for entry in report['assets']} != {'store', 'rows'}:
        raise ValueError('Both distinct queue adapters must pass.')
    report['status'] = 'passed'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument('--extension', type=Path)
    selection.add_argument('--extensions-dir', type=Path)
    parser.add_argument('--channel', choices=('stable', 'pre-release'), default='stable')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args(argv)
    report = {'channel': args.channel, 'status': 'failed', 'assets': []}
    try:
        extension = args.extension or installed_extension(args.extensions_dir)
        check(extension, report)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # No bundle contents, profiles, credentials or Node diagnostic source.
        report['error'] = str(error)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    if report['status'] != 'passed':
        print(f"Codex {report.get('version', 'unknown')} ({args.channel}): {report['error']}", file=sys.stderr)
        return 1
    print(f"Codex {report['version']} ({args.channel}): both queue adapters pass syntax, idempotence and exact restoration.")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
