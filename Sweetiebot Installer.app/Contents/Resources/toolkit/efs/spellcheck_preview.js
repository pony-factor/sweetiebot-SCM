'use strict';

const { spawn } = require('child_process');
const { resolvePythonExecutable, pythonLaunchError } = require('./python_runtime');

function runSpellcheck(script, cwd, subject) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePythonExecutable(), [script, '--spellcheck-subject'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Commit spellcheck timed out while waiting for Ollama.'));
    }, 45000);
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', fail);
    child.on('error', error => fail(pythonLaunchError(error)));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(stderr.trim() || 'Commit spellcheck failed.'));
        return;
      }
      try {
        const payload = JSON.parse(stdout);
        if (typeof payload.subject !== 'string' || !payload.subject.trim()) {
          throw new Error('Commit spellcheck returned an invalid subject.');
        }
        if (
          payload.subject === subject
          && /manual commit spellcheck skipped/i.test(stderr)
        ) {
          throw new Error(stderr.trim().replace(/^scm-toolkit:\s*/i, ''));
        }
        succeed(payload.subject);
      } catch (error) {
        fail(error);
      }
    });
    child.stdin.end(subject);
  });
}

function hasCodexCoauthor(message) {
  return String(message || '').split(/\r?\n/).some(
    line => /^Co-authored-by:\s*Codex(?: Web)?\s*</i.test(line.trim())
  );
}

function registerSpellcheckPreviewCommand(vscode, extensionContext) {
  extensionContext.subscriptions.push(vscode.commands.registerCommand(
    'sweetiebot.previewCommitSpellcheck',
    async (uri, message) => {
      if (typeof message !== 'string' || !message.trim()) {
        vscode.window.showInformationMessage('Enter a commit message before previewing spelling corrections.');
        return message;
      }
      if (hasCodexCoauthor(message)) {
        vscode.window.showInformationMessage(
          'Codex-attributed commit messages are not passed through manual spellcheck.'
        );
        return message;
      }

      const root = uri ? vscode.Uri.from(uri?.rootUri ?? uri) : undefined;
      if (root && root.scheme !== 'file') {
        throw new Error('Commit spellcheck requires a local Git repository.');
      }
      const originalSubject = message.split(/\r?\n/, 1)[0];
      const script = vscode.Uri.joinPath(extensionContext.extensionUri, 'ai_commit.py').fsPath;
      const corrected = await runSpellcheck(
        script,
        root?.fsPath || extensionContext.extensionPath,
        originalSubject
      );
      if (corrected === originalSubject) {
        vscode.window.showInformationMessage('Sweetiebot found no spelling changes in the commit subject.');
        return message;
      }

      const choice = await vscode.window.showInformationMessage(
        'Apply this spelling correction to the commit subject?',
        {
          modal: true,
          detail: `Original:\n${originalSubject}\n\nSuggested:\n${corrected}`
        },
        'Apply correction',
        'Keep original'
      );
      if (choice !== 'Apply correction') return message;
      return corrected + message.slice(originalSubject.length);
    }
  ));
}

module.exports = { runSpellcheck, hasCodexCoauthor, registerSpellcheckPreviewCommand };
