import OpenAI from 'openai';
import config from '../config.js';
import { validateDecision } from '../utils/schemas.js';
import { log } from '../utils/logger.js';

let client;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: config.grokApiKey,
      baseURL: 'https://api.x.ai/v1',
    });
  }
  return client;
}

const systemPrompt = `You are Dispatch, an autonomous project management AI. Your job is to:
1. Analyze the current state of a software project
2. Propose the next logical step
3. Assess whether you're confident enough to proceed autonomously
4. Identify when human (Greg) input is required

You work with Claude (execution AI) who will implement your decisions.

Response format (JSON only):
{
  "nextStep": {
    "task": "Brief description of what should be done next",
    "reasoning": "Why this is the logical next step",
    "details": "Specific implementation details for Claude",
    "isPrerequisite": true|false
  },
  "confidence": "high|medium|low",
  "needsGreg": true|false,
  "questionForGreg": "If needsGreg=true, what to ask",
  "estimatedComplexity": "simple|moderate|complex",
  "dependencies": ["any prerequisites or blockers"]
}

isPrerequisite guidelines:
- TRUE: The task is a housekeeping or setup step (e.g. committing files, fixing configs, installing deps) before the real work begins. Prerequisite tasks should NOT count as iterations.
- FALSE: The task is the main goal work or a substantial feature implementation.

Confidence guidelines:
- HIGH: Obvious continuation (add tests, implement similar feature, fix clear bug)
- MEDIUM: Reasonable next step but could go multiple ways
- LOW: Architectural decision, major feature choice, unclear requirements

needsGreg = true when:
- Confidence is LOW
- Architectural decisions required
- Multiple valid approaches exist
- Business logic/requirements unclear
- Security or compliance implications`;

function buildUserPrompt(projectState, repoAnalysis) {
  const recentCompleted = projectState.completed
    .slice(-3)
    .map(c => `- ${c.task}`)
    .join('\n') || '- None yet';

  const blockers = projectState.blockers.length
    ? projectState.blockers.map(b => `- ${b.description}`).join('\n')
    : 'None';

  return `Project: ${projectState.name}
Current Goal: ${projectState.currentGoal}

Recently Completed:
${recentCompleted}

${projectState.inProgress ? `Currently In Progress: ${projectState.inProgress.task}` : 'Nothing currently in progress.'}

Blockers:
${blockers}

Current Repository State:
${repoAnalysis.summary}
Recent commits: ${repoAnalysis.recentCommits.slice(0, 5).join(', ') || 'None'}
Changed files: ${repoAnalysis.changedFiles.slice(0, 10).join(', ') || 'None'}

${repoAnalysis.projectSnapshot ? `Existing Project Structure & Key Files:\n${repoAnalysis.projectSnapshot}` : ''}

Context:
- Tech stack: ${projectState.context.techStack.join(', ') || 'Not specified'}
- Preferences: ${projectState.context.preferences.join(', ') || 'None'}

${projectState.gregDirection ? `Greg's latest direction: "${projectState.gregDirection}"` : ''}

What should we work on next?`;
}

export async function proposeNextStep(projectState, repoAnalysis) {
  const userPrompt = buildUserPrompt(projectState, repoAnalysis);

  log.debug('Grok prompt', { userPrompt });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await getClient().chat.completions.create({
        model: 'grok-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const raw = response.choices[0].message.content;
      log.debug('Grok raw response', { raw });

      const decision = JSON.parse(raw);
      const errors = validateDecision(decision);
      if (errors.length) {
        log.warn('Grok returned invalid decision, retrying', { errors, attempt });
        lastError = new Error(`Invalid decision: ${errors.join(', ')}`);
        continue;
      }

      log.info('Grok decision', {
        task: decision.nextStep.task,
        confidence: decision.confidence,
        needsGreg: decision.needsGreg,
      });

      return decision;
    } catch (err) {
      lastError = err;
      log.warn(`Grok API attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  throw new Error(`Grok failed after 3 attempts: ${lastError.message}`);
}

/**
 * Review Claude's work. Grok looks at the actual code diff and file contents
 * and decides: approve, revise, or escalate to Greg.
 * Returns { decision, summary, feedback, revisions[], questionForGreg }
 */
export async function reviewWork(projectState, taskDescription, commitInfo, revisionHistory = []) {
  const reviewSystemPrompt = `You are Dispatch, an autonomous project lead reviewing code written by Claude (an execution AI). You have full authority to decide when work is done. Greg (the human) trusts your judgment.

Your job: look at the actual code Claude wrote and make a call.

You have THREE options:

1. "approve" — The work is solid. It does what was asked, the code is reasonable, no major issues. Ship it.

2. "revise" — There are specific, fixable problems. Bugs, missing functionality, broken logic, incomplete implementation. Give Claude clear, actionable feedback and send it back.

3. "ask_greg" — You need Greg's input. Use this when:
   - The task involves subjective choices (design, UX, naming conventions Greg cares about)
   - You're unsure what Greg actually wants
   - The work is technically fine but you're not sure it matches Greg's vision
   - You've sent Claude back for revisions and it's not converging — Greg should weigh in
   - Something feels off but you can't pinpoint a concrete fix

Guidelines for good judgment:
- Be practical. Don't nitpick style, formatting, or minor preferences. Focus on: does it work? Is it correct? Is anything broken or missing?
- If Claude did 90% of a good job and the remaining 10% is polish, approve it. Perfect is the enemy of done.
- If you've already sent Claude back once or twice on the same issue and it's still not right, escalate to Greg rather than looping forever.
- For anything visual, design-related, or taste-dependent, lean toward ask_greg. You're good at code review, not design review.

Response format (JSON only):
{
  "decision": "approve" | "revise" | "ask_greg",
  "summary": "Brief assessment of the work (1-2 sentences)",
  "revisions": [
    {
      "file": "filename or 'general'",
      "issue": "What's wrong",
      "suggestion": "What to do instead"
    }
  ],
  "feedback": "Overall feedback for Claude if decision=revise",
  "questionForGreg": "Question for Greg if decision=ask_greg"
}

If decision=approve, revisions should be empty.
If decision=revise, provide specific, actionable revisions.
If decision=ask_greg, include a clear question summarizing what you need from Greg.`;

  const fileContentsList = Object.entries(commitInfo.fileContents)
    .map(([file, content]) => `=== ${file} ===\n${content}`)
    .join('\n\n');

  const revisionContext = revisionHistory.length
    ? `\n\nPrevious revision rounds (${revisionHistory.length} so far):\n${revisionHistory.map((r, i) => `  Round ${i + 1}: ${r.feedback}`).join('\n')}\n\nKeep this history in mind. If the same issues keep recurring, consider escalating to Greg instead of another revision.`
    : '';

  const userPrompt = `Project: ${projectState.name}
Goal: ${projectState.currentGoal}
Task that was completed: ${taskDescription}

Files changed: ${commitInfo.filesChanged.join(', ')}
${revisionContext}

--- DIFF ---
${commitInfo.diff}

--- FILE CONTENTS ---
${fileContentsList}

Review this work and make your call: approve, revise, or ask Greg.`;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await getClient().chat.completions.create({
        model: 'grok-4',
        messages: [
          { role: 'system', content: reviewSystemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const raw = response.choices[0].message.content;
      log.debug('Grok review raw', { raw });

      const review = JSON.parse(raw);
      // Normalize: support both old "approved" bool and new "decision" string
      if (!review.decision) {
        review.decision = review.approved ? 'approve' : 'revise';
      }
      log.info('Grok review result', {
        decision: review.decision,
        summary: review.summary,
        revisionCount: review.revisions?.length || 0,
      });

      return review;
    } catch (err) {
      lastError = err;
      log.warn(`Grok review attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  // If review fails, approve by default so we don't block progress
  log.error(`Grok review failed after 3 attempts: ${lastError.message}. Auto-approving.`);
  return { decision: 'approve', summary: 'Review failed, auto-approved', revisions: [], feedback: '', questionForGreg: '' };
}

/**
 * Parse Greg's freeform goal description into a structured project definition.
 * Returns { projectId, name, currentGoal, techStack, preferences, repoName }
 */
export async function parseGoal(gregMessage) {
  const parsePrompt = `You are Dispatch, an autonomous project management AI. Greg (the human) just told you what he wants to work on. Parse his message into a structured project definition.

Response format (JSON only):
{
  "projectId": "kebab-case-id (e.g. payroll-app, dashboard-fix)",
  "name": "Human-readable project name",
  "currentGoal": "Clear description of what needs to be built/done",
  "techStack": ["inferred or stated technologies"],
  "preferences": ["any stated preferences or constraints"],
  "repoName": "suggested repository folder name"
}

If Greg is vague about tech stack, make reasonable suggestions but note them as inferred.
If it's a small task (bug fix, feature addition), keep it simple.
If it's a new project, suggest a sensible repo name.`;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await getClient().chat.completions.create({
        model: 'grok-4',
        messages: [
          { role: 'system', content: parsePrompt },
          { role: 'user', content: `Greg says: "${gregMessage}"` },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const raw = response.choices[0].message.content;
      log.debug('Grok parseGoal raw', { raw });

      const parsed = JSON.parse(raw);
      if (!parsed.projectId || !parsed.currentGoal) {
        throw new Error('Missing projectId or currentGoal in parsed result');
      }

      log.info('Grok parsed goal', { projectId: parsed.projectId, goal: parsed.currentGoal });
      return parsed;
    } catch (err) {
      lastError = err;
      log.warn(`Grok parseGoal attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  throw new Error(`Grok parseGoal failed after 3 attempts: ${lastError.message}`);
}
