import config from '../config.js';
import { log } from '../utils/logger.js';

async function post(payload) {
  if (!config.slackWebhookUrl) {
    log.warn('Slack webhook URL not configured, skipping message');
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`Slack returned ${res.status}: ${await res.text()}`);
      }
      return;
    } catch (err) {
      lastError = err;
      log.warn(`Slack attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  log.error(`Slack message failed after 3 attempts: ${lastError.message}`);
}

export async function sendMessage(text) {
  await post({ text });
}

export async function askGreg(question, { state, decision, execution } = {}) {
  const projectName = state?.name || 'Unknown project';
  const lastCompleted = state?.completed?.slice(-1)[0]?.task || 'Nothing yet';
  const proposedStep = decision?.nextStep?.task || execution?.summary || 'N/A';
  const reasoning = decision?.nextStep?.reasoning || '';

  const text = [
    ':vertical_traffic_light: *Dispatch needs your input*',
    '',
    `*Project:* ${projectName}`,
    `*Question:* ${question}`,
    '',
    '*Context:*',
    `Recently completed: ${lastCompleted}`,
    `Proposed next step: ${proposedStep}`,
    reasoning ? `*Reasoning:* ${reasoning}` : '',
    '',
    'Reply with your direction and I\'ll continue.',
  ].filter(Boolean).join('\n');

  log.info('Asking Greg via Slack', { question });
  await post({ text });
}

export async function reportProgress({ summary, filesChanged, commitHash, projectName }) {
  const text = [
    ':white_check_mark: *Task completed autonomously*',
    '',
    `*Project:* ${projectName || 'N/A'}`,
    `*Completed:* ${summary}`,
    `*Files changed:* ${filesChanged?.length || 0}`,
    commitHash ? `*Commit:* ${commitHash.slice(0, 7)}` : '',
    '',
    'Continuing with next task...',
  ].filter(Boolean).join('\n');

  log.info('Reporting progress to Slack');
  await post({ text });
}

export async function reportError(error, context = {}) {
  const text = [
    ':x: *Dispatch encountered an error*',
    '',
    `*Error:* ${error.message || error}`,
    context.projectId ? `*Project:* ${context.projectId}` : '',
    context.phase ? `*Phase:* ${context.phase}` : '',
    '',
    'Manual intervention may be required.',
  ].filter(Boolean).join('\n');

  log.error('Reporting error to Slack', { error: error.message });
  await post({ text });
}
