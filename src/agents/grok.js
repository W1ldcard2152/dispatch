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
    "details": "Specific implementation details for Claude"
  },
  "confidence": "high|medium|low",
  "needsGreg": true|false,
  "questionForGreg": "If needsGreg=true, what to ask",
  "estimatedComplexity": "simple|moderate|complex",
  "dependencies": ["any prerequisites or blockers"]
}

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

Context:
- Tech stack: ${projectState.context.techStack.join(', ') || 'Not specified'}
- Preferences: ${projectState.context.preferences.join(', ') || 'None'}

What should we work on next?`;
}

export async function proposeNextStep(projectState, repoAnalysis) {
  const userPrompt = buildUserPrompt(projectState, repoAnalysis);

  log.debug('Grok prompt', { userPrompt });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await getClient().chat.completions.create({
        model: 'grok-2-latest',
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
