import { spawn } from 'child_process';
import simpleGit from 'simple-git';
import { log } from '../utils/logger.js';

const CLAUDE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function buildPrompt(task, projectState) {
  const recentWork = projectState.completed
    .slice(-2)
    .map(c => c.task)
    .join(', ') || 'None';

  return `Task: ${task.task}

${task.details ? `Details: ${task.details}` : ''}

Project: ${projectState.name}
Tech stack: ${projectState.context.techStack.join(', ') || 'Not specified'}
Preferences: ${projectState.context.preferences.join(', ') || 'None'}
Recent work: ${recentWork}

Please implement this task. Write the code, make sure it works, and commit your changes with a descriptive commit message.

IMPORTANT SAFETY RULES:
- NEVER delete, reset, or drop databases. If migrations are out of sync, create a new migration to bring them in line — do NOT reset.
- NEVER run destructive commands like "prisma migrate reset", "prisma db push --force-reset", or "DROP TABLE".
- If you encounter a database drift issue, fix it with a new migration or by updating the schema to match reality.
- Work with the existing data — there is real test data in the database that must be preserved.
- If you truly cannot proceed without a destructive action, stop and explain why instead of doing it.`;

}

function runClaude(prompt, cwd, taskDescription) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const startTime = Date.now();

    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      cleanup();
      reject(new Error(`Claude timed out after ${CLAUDE_TIMEOUT / 1000}s`));
    }, CLAUDE_TIMEOUT);

    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      log.info(`⏳ Claude still working on: ${taskDescription || 'task'} (${mins}m ${secs}s elapsed)`);
    }, 60000);

    function cleanup() {
      clearTimeout(killTimer);
      clearInterval(heartbeat);
    }

    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      cleanup();
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code} after ${elapsed}s${stderr ? ` — ${stderr}` : ''}`));
      } else {
        log.info(`✅ Claude finished in ${elapsed}s (${stdout.length} chars output)`);
        resolve(stdout);
      }
    });

    child.on('error', (err) => {
      cleanup();
      reject(new Error(`claude CLI failed: ${err.message}`));
    });
  });
}

/**
 * After Claude runs, inspect the repo to see what actually happened.
 */
async function inspectResult(repoPath, beforeHash) {
  const git = simpleGit(repoPath);

  try {
    const logResult = await git.log({ maxCount: 5 });
    const latestCommit = logResult.all[0];
    const status = await git.status();

    // Did Claude make any new commits?
    const hasNewCommit = latestCommit && latestCommit.hash !== beforeHash;

    if (hasNewCommit) {
      // Get the list of files changed in the latest commit
      const diff = await git.diff(['--name-only', `${latestCommit.hash}~1`, latestCommit.hash]).catch(() => '');
      const filesChanged = diff.split('\n').filter(Boolean);

      return {
        status: 'completed',
        summary: latestCommit.message,
        filesChanged,
        commitHash: latestCommit.hash,
        nextSteps: [],
        issues: [],
        questionsForGreg: [],
      };
    }

    // No commit — check if there are uncommitted changes
    if (!status.isClean()) {
      const changedFiles = [...status.modified, ...status.created, ...status.not_added];
      return {
        status: 'needs_input',
        summary: 'Made changes but did not commit them',
        filesChanged: changedFiles,
        commitHash: null,
        nextSteps: ['Review and commit the changes'],
        issues: ['Claude made changes but did not commit — may need permissions or guidance'],
        questionsForGreg: [`Claude made changes to ${changedFiles.length} file(s) but didn't commit. Files: ${changedFiles.join(', ')}. Should I review and commit these, or retry the task?`],
      };
    }

    // Nothing happened
    return {
      status: 'failed',
      summary: 'No changes were made to the repository',
      filesChanged: [],
      commitHash: null,
      nextSteps: [],
      issues: ['Claude ran but produced no changes'],
      questionsForGreg: [],
    };
  } catch (err) {
    return {
      status: 'failed',
      summary: `Failed to inspect repo: ${err.message}`,
      filesChanged: [],
      commitHash: null,
      nextSteps: [],
      issues: [err.message],
      questionsForGreg: [],
    };
  }
}

/**
 * Execute a revision based on Grok's review feedback.
 */
export async function executeRevision(review, originalTask, projectState, repoPath) {
  const revisionDetails = review.revisions
    .map((r, i) => `${i + 1}. [${r.file}] ${r.issue} → ${r.suggestion}`)
    .join('\n');

  const prompt = `You previously worked on: ${originalTask}

A reviewer found issues that need fixing. Here is their feedback:

${review.feedback}

Specific revisions needed:
${revisionDetails}

Project: ${projectState.name}
Tech stack: ${projectState.context.techStack.join(', ') || 'Not specified'}

Please make these revisions. Fix each issue listed above, then commit your changes with a descriptive commit message that starts with "fix:" or "refactor:".`;

  // Capture current HEAD before Claude runs
  const git = simpleGit(repoPath);
  let beforeHash = null;
  try {
    const logBefore = await git.log({ maxCount: 1 });
    beforeHash = logBefore.all[0]?.hash || null;
  } catch { /* empty repo */ }

  try {
    const claudeOutput = await runClaude(prompt, repoPath, `Revisions for: ${originalTask}`);
    log.info('Claude revision output summary', { output: claudeOutput.slice(0, 300) });

    const result = await inspectResult(repoPath, beforeHash);
    log.info('Claude revision result', {
      status: result.status,
      summary: result.summary,
      filesChanged: result.filesChanged?.length || 0,
    });

    return result;
  } catch (err) {
    log.error(`Claude revision failed: ${err.message}`);
    return {
      status: 'failed',
      summary: `Revision failed: ${err.message}`,
      filesChanged: [],
      commitHash: null,
      nextSteps: [],
      issues: [err.message],
      questionsForGreg: [],
    };
  }
}

export async function executeTask(task, projectState, repoPath) {
  const prompt = buildPrompt(task, projectState);
  log.debug('Claude CLI prompt', { prompt: prompt.slice(0, 200) + '...' });

  // Capture current HEAD before Claude runs
  const git = simpleGit(repoPath);
  let beforeHash = null;
  try {
    const logBefore = await git.log({ maxCount: 1 });
    beforeHash = logBefore.all[0]?.hash || null;
  } catch { /* empty repo */ }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const claudeOutput = await runClaude(prompt, repoPath, task.task);
      log.info('Claude output summary', { output: claudeOutput.slice(0, 300) });

      // Inspect the repo to see what Claude actually did
      const result = await inspectResult(repoPath, beforeHash);

      log.info('Claude execution result', {
        status: result.status,
        summary: result.summary,
        filesChanged: result.filesChanged?.length || 0,
      });

      // If Claude ran but did nothing, that's a real failure — don't retry
      if (result.status === 'failed' && result.issues.includes('Claude ran but produced no changes')) {
        result.summary = `Claude was asked to: ${task.task}. Output: ${claudeOutput.slice(0, 200)}`;
        result.status = 'needs_input';
        result.questionsForGreg = [`Claude couldn't complete this task. Its output was: "${claudeOutput.slice(0, 300)}". How should we proceed?`];
      }

      return result;
    } catch (err) {
      lastError = err;
      log.warn(`Claude CLI attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  throw new Error(`Claude failed after 3 attempts: ${lastError.message}`);
}
