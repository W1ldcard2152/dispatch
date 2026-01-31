import cron from 'node-cron';
import config, { validateConfig } from './config.js';
import { loadProject, saveProject, loadActiveProjects } from './project/state.js';
import { analyzeRepo } from './project/analyzer.js';
import { proposeNextStep } from './agents/grok.js';
import { executeTask } from './agents/claude.js';
import { askGreg, reportProgress, reportError } from './messaging/slack.js';
import { log } from './utils/logger.js';

async function dispatchCycle() {
  log.info('=== Starting Dispatch cycle ===');

  let projects;
  try {
    projects = await loadActiveProjects();
  } catch (err) {
    log.error('Failed to load projects', { error: err.message });
    await reportError(err, { phase: 'load_projects' });
    return;
  }

  if (!projects.length) {
    log.info('No active projects found. Cycle complete.');
    return;
  }

  log.info(`Found ${projects.length} active project(s): ${projects.join(', ')}`);

  for (const projectId of projects) {
    try {
      await processProject(projectId);
    } catch (err) {
      log.error(`Error processing project ${projectId}`, { error: err.message });
      await reportError(err, { projectId, phase: 'process_project' });
    }
  }

  log.info('=== Dispatch cycle complete ===');
}

async function processProject(projectId) {
  log.info(`Processing project: ${projectId}`);

  const state = await loadProject(projectId);

  // Skip if waiting for input
  if (state.status === 'waiting_input') {
    log.info(`Project ${projectId} is waiting for Greg's input, skipping`);
    return;
  }

  // 1. Analyze current repository state
  log.info(`Analyzing repo for ${projectId}`);
  const analysis = await analyzeRepo(state.repoPath);
  log.info(`Repo analysis: ${analysis.summary}`);

  // 2. Ask Grok what to do next
  log.info(`Consulting Grok for ${projectId}`);
  const decision = await proposeNextStep(state, analysis);

  // 3. Decide: autonomous or escalate?
  if (decision.needsGreg || decision.confidence === 'low') {
    log.info(`Escalating to Greg: ${decision.questionForGreg || decision.nextStep.task}`);
    await askGreg(
      decision.questionForGreg || `Should I proceed with: ${decision.nextStep.task}?`,
      { state, decision }
    );
    state.status = 'waiting_input';
    await saveProject(state);
    return;
  }

  // 4. Execute autonomously
  log.info(`Executing autonomously: ${decision.nextStep.task}`);
  state.inProgress = {
    task: decision.nextStep.task,
    startedAt: new Date().toISOString(),
    assignedTo: 'claude',
  };
  await saveProject(state);

  const execution = await executeTask(decision.nextStep, state, state.repoPath);

  // 5. Update state based on result
  if (execution.status === 'completed') {
    state.completed.push({
      task: decision.nextStep.task,
      completedAt: new Date().toISOString(),
      commitHash: execution.commitHash || null,
    });
    state.inProgress = null;
    state.lastActivity = new Date().toISOString();

    await reportProgress({
      summary: execution.summary,
      filesChanged: execution.filesChanged,
      commitHash: execution.commitHash,
      projectName: state.name,
    });

    log.info(`Task completed: ${execution.summary}`);
  } else if (execution.status === 'needs_input') {
    const questions = execution.questionsForGreg?.join('\n') || execution.summary;
    await askGreg(questions, { state, execution });
    state.status = 'waiting_input';
    state.inProgress = null;
    log.info(`Execution needs input, escalated to Greg`);
  } else {
    // failed
    log.error(`Task failed: ${execution.summary}`, { issues: execution.issues });
    await reportError(new Error(execution.summary), { projectId, phase: 'execution' });
    state.inProgress = null;
  }

  await saveProject(state);
}

// --- Entry point ---

const isManualRun = process.argv.includes('--now');

if (isManualRun) {
  // Single cycle, then exit
  try {
    validateConfig();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
  dispatchCycle().then(() => {
    log.info('Manual cycle finished');
    process.exit(0);
  }).catch(err => {
    log.error('Manual cycle failed', { error: err.message });
    process.exit(1);
  });
} else {
  // Daemon mode
  try {
    validateConfig();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  const schedule = config.checkInterval;
  if (!cron.validate(schedule)) {
    log.error(`Invalid cron schedule: ${schedule}`);
    process.exit(1);
  }

  cron.schedule(schedule, dispatchCycle);
  log.info(`Dispatch daemon started. Schedule: ${schedule}`);

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log.info(`Received ${signal}, shutting down`);
      process.exit(0);
    });
  }
}
