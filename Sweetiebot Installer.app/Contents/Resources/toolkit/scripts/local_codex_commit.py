"""Generate a commit message from staged changes and an in-memory chat snapshot."""

import json
import sys

import ai_commit


def main():
    context = json.load(sys.stdin).get('context', '')
    if not isinstance(context, str):
        raise ValueError('The Codex conversation snapshot is invalid.')
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
        require_model=True,
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
