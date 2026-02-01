import pkg from '@slack/bolt';
const { App } = pkg;
import config from '../config.js';
import { log } from '../utils/logger.js';

let app;
let onGregReply = null;   // callback for inline waits (onboarding, etc.)
let onGregMessage = null;  // callback for unsolicited replies (resumes waiting projects)

export function getApp() {
  if (!app) {
    app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
    });

    // Listen for Greg's replies
    app.message(async ({ message, say }) => {
      // Ignore bot messages
      if (message.subtype === 'bot_message' || message.bot_id) return;

      log.info('Received message from Greg', { text: message.text });

      // If something is actively waiting (onboarding, inline question)
      if (onGregReply) {
        const cb = onGregReply;
        onGregReply = null;
        await say('Got it, on it.');
        cb(message.text);
        return;
      }

      // Otherwise, this is a reply to a waiting_input project — route it
      if (onGregMessage) {
        await say('Got it, resuming work.');
        onGregMessage(message.text);
      } else {
        await say('Dispatch is running. No pending questions right now. I\'ll reach out when I need you.');
      }
    });
  }
  return app;
}

/**
 * Register a handler that fires when Greg sends a message outside of an
 * active wait. Used by the daemon to resume waiting projects.
 */
export function onGreg(handler) {
  onGregMessage = handler;
}

export async function startSlack() {
  if (!config.slackBotToken || !config.slackAppToken) {
    log.warn('Slack tokens not configured, skipping Slack startup');
    return;
  }
  const boltApp = getApp();
  await boltApp.start();
  log.info('Slack Bolt app connected (Socket Mode)');
}

export async function stopSlack() {
  if (app) {
    await app.stop();
    log.info('Slack Bolt app stopped');
  }
}

/**
 * Wait for Greg to reply in Slack. Returns his message text.
 * Used during onboarding and inline questions within a cycle.
 * Times out after the given ms (default 24h).
 */
export function waitForGreg(timeoutMs = 24 * 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onGregReply = null;
      reject(new Error('Timed out waiting for Greg'));
    }, timeoutMs);

    onGregReply = (text) => {
      clearTimeout(timer);
      resolve(text);
    };
  });
}

// --- Message helpers ---

async function postMessage(text) {
  if (!config.slackBotToken) {
    log.warn('Slack not configured, skipping message');
    return;
  }

  try {
    const boltApp = getApp();
    await boltApp.client.chat.postMessage({
      token: config.slackBotToken,
      channel: config.slackChannel,
      text,
    });
  } catch (err) {
    log.error(`Slack postMessage failed: ${err.message}`);
  }
}

export async function sendMessage(text) {
  await postMessage(text);
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
    'Reply here with your direction.',
  ].filter(Boolean).join('\n');

  log.info('Asking Greg via Slack', { question });
  await postMessage(text);
}

export async function askGregForGoal() {
  const text = [
    ':wave: *Hey Greg — what should we work on?*',
    '',
    'Tell me what you\'d like to build or work on next. Be as brief or detailed as you like — for example:',
    '',
    '> _Build a payroll system for Phoenix Automotive using Next.js and PostgreSQL_',
    '> _Add dark mode to the dashboard app_',
    '> _Fix the bug in the employee import CSV parser_',
    '',
    'I\'ll have Grok break it down and Claude will start building. I\'ll check in when we need decisions.',
  ].join('\n');

  log.info('Asking Greg for next goal via Slack');
  await postMessage(text);
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
  await postMessage(text);
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
  await postMessage(text);
}
