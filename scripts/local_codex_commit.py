"""Generate a commit message from staged changes and an in-memory chat snapshot."""

import json
import os
import sys
import tempfile

import ai_commit


def normalize_reviewed_whitespace(paths):
    if (not isinstance(paths, list) or not paths
            or any(not isinstance(path, str) or not path or os.path.isabs(path)
                   or '..' in path.replace('\\', '/').split('/')
                   or not path.lower().endswith(('.md', '.mdx')) for path in paths)):
        raise ValueError('Invalid reviewed Markdown paths.')
    if not ai_commit.staged_whitespace_enabled():
        return
    previous_index = os.environ.get('GIT_INDEX_FILE')
    try:
        # Reuse the ordinary commit normalizer without touching the real index
        # or including any unrelated staged work.
        with tempfile.TemporaryDirectory(prefix='sweetiebot-spellcheck-') as directory:
            os.environ['GIT_INDEX_FILE'] = os.path.join(directory, 'index')
            for args in [('read-tree', 'HEAD'), ('--literal-pathspecs', 'add', '--', *paths)]:
                result = ai_commit.git_bytes(*args)
                if result.returncode:
                    raise RuntimeError('Could not prepare reviewed files for whitespace normalization.')
            ai_commit.normalize_staged_final_newlines()
    finally:
        if previous_index is None:
            os.environ.pop('GIT_INDEX_FILE', None)
        else:
            os.environ['GIT_INDEX_FILE'] = previous_index


def main():
    if sys.argv[1:] == ['--normalize-reviewed-whitespace']:
        normalize_reviewed_whitespace(json.load(sys.stdin))
        return
    if sys.argv[1:] == ['--normalize-staged-whitespace']:
        if ai_commit.staged_whitespace_enabled():
            ai_commit.normalize_staged_final_newlines()
        return
    context = json.load(sys.stdin).get('context', '')
    if not isinstance(context, str):
        raise ValueError('The Codex conversation snapshot is invalid.')
    if ai_commit.staged_whitespace_enabled():
        ai_commit.normalize_staged_final_newlines()
    stat, diff, files = ai_commit.staged_diff()
    if not stat and not diff:
        raise ValueError('Stage the intended changes before using the local Codex commit button.')
    repository_state = (
        ai_commit.git_output('rev-parse', 'HEAD'),
        ai_commit.git_output('symbolic-ref', '--short', '-q', 'HEAD'),
    )
    title, description = ai_commit.generate_message(
        stat, diff, files,
        include_description=ai_commit.should_add_default_branch_description(),
        conversation_context=context[-6000:],
    )
    if ai_commit.staged_diff() != (stat, diff, files) or repository_state != (
        ai_commit.git_output('rev-parse', 'HEAD'),
        ai_commit.git_output('symbolic-ref', '--short', '-q', 'HEAD'),
    ):
        raise ValueError('The staged changes or branch changed during local generation. Try again.')
    print(json.dumps({'message': title + ('\n\n' + description if description else '')}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
