import { execFile } from 'child_process';
import { validateExecution } from '../utils/schemas.js';
import { log } from '../utils/logger.js';

const CLAUDE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

const systemPrompt = `You are Claude, the execution AI in the Dispatch system. Your job is to:
1. Implement the task described by Dispatch (the decision-making AI)
2. Write clean, production-quality code
3. Follow established patterns in the codebase
4. Make atomic, well-documented commits

You have access to the file system and git. Complete the task and report back.

When you are finished, output a JSON block (fenced with \`\`\`json) with this structure:
{
  "status": "completed|failed|needs_input",
  "summary": "What you did",
  "filesChanged": ["list", "of", "files"],
  "commitHash": "abc123 or null if no commit",
  "nextSteps": ["suggestions for what could come after this"],
  "issues": ["any problems encountered"],
  "questionsForGreg": ["if needs_input, what to ask"]
}

Important rules:
- If you cannot fully implement something, set status to "needs_input" and explain what's missing
- Keep changes small and focused
- Never force push or do destructive git operations
- Commit messages should be descriptive`;

function buildPrompt(task, projectState) {
  const recentWork = projectState.completed
    .slice(-2)
    .map(c => c.task)
    .join(', ') || 'None';

  return `${systemPrompt}

Project: ${projectState.name}

Task to execute:
${task.task}

Implementation details:
${task.details}

Context:
- Tech stack: ${projectState.context.techStack.join(', ') || 'Not specified'}
- Preferences: ${projectState.context.preferences.join(', ') || 'None'}
- Recent work: ${recentWork}

Execute this task. Write the code, test it works, and commit your changes.
When done, output the JSON result block described above.`;
}

function runClaude(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', '--output-format', 'text', prompt],
      { cwd, timeout: CLAUDE_TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`claude CLI failed: ${error.message}${stderr ? ` — ${stderr}` : ''}`));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

function parseResult(raw) {
  // Try to extract a JSON block (fenced or bare)
  const fenced = raw.match(/```json\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1]);

  const bare = raw.match(/\{[\s\S]*\}/);
  if (bare) return JSON.parse(bare[0]);

  throw new Error('No JSON result found in Claude output');
}

export async function executeTask(task, projectState, repoPath) {
  const prompt = buildPrompt(task, projectState);

  log.debug('Claude CLI prompt', { prompt: prompt.slice(0, 200) + '...' });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await runClaude(prompt, repoPath);
      log.debug('Claude CLI raw output length', { length: raw.length });

      const result = parseResult(raw);
      const errors = validateExecution(result);
      if (errors.length) {
        log.warn('Claude returned invalid result, retrying', { errors, attempt });
        lastError = new Error(`Invalid execution result: ${errors.join(', ')}`);
        continue;
      }

      log.info('Claude execution result', {
        status: result.status,
        summary: result.summary,
        filesChanged: result.filesChanged?.length || 0,
      });

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
