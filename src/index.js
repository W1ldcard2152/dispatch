import { mkdir } from 'fs/promises';
import { resolve } from 'path';
import cron from 'node-cron';
import config, { validateConfig } from './config.js';
import { loadProject, saveProject, loadActiveProjects, loadWaitingProjects, resumeProject } from './project/state.js';
import { analyzeRepo, getCommitDiff } from './project/analyzer.js';
import { proposeNextStep, parseGoal, reviewWork } from './agents/grok.js';
import { executeTask, executeRevision } from './agents/claude.js';
import {
  askGreg, askGregForGoal, reportProgress, reportError,
  sendMessage, startSlack, stopSlack, waitForGreg, onGreg,
} from './messaging/slack.js';
import { createProjectTemplate } from './utils/schemas.js';
import { log } from './utils/logger.js';
import simpleGit from 'simple-git';

// Guard against overlapping cycles
let cycleRunning = false;

// ---------------------------------------------------------------------------
// Onboarding: no active projects → ask Greg what to build
// ---------------------------------------------------------------------------

async function onboard() {
  log.info('No active projects. Asking Greg what to work on.');
  await askGregForGoal();

  const gregReply = await waitForGreg();
  log.info('Greg replied with goal', { reply: gregReply });

  // Have Grok parse the freeform reply into structured project data
  await sendMessage(':brain: Parsing your goal...');
  const parsed = await parseGoal(gregReply);

  // Create the repo directory
  const repoBase = config.defaultRepoPath || resolve('.');
  const repoPath = resolve(repoBase, parsed.repoName || parsed.projectId);
  await mkdir(repoPath, { recursive: true });

  // Build and save project state
  const state = createProjectTemplate({
    projectId: parsed.projectId,
    name: parsed.name,
    repoPath,
    currentGoal: parsed.currentGoal,
    context: {
      techStack: parsed.techStack || [],
      preferences: parsed.preferences || [],
      gregAvailability: 'Business hours weekdays, limited weekends',
    },
  });

  await saveProject(state);

  await sendMessage([
    `:rocket: *Project created: ${state.name}*`,
    '',
    `*Goal:* ${state.currentGoal}`,
    `*Tech stack:* ${state.context.techStack.join(', ') || 'TBD'}`,
    `*Repo:* \`${repoPath}\``,
    '',
    'Starting first work cycle now...',
  ].join('\n'));

  log.info('Project created via onboarding', { projectId: state.projectId });
  return state.projectId;
}

// ---------------------------------------------------------------------------
// Main dispatch cycle
// ---------------------------------------------------------------------------

async function dispatchCycle() {
  if (cycleRunning) {
    log.info('Cycle already running, skipping');
    return;
  }
  cycleRunning = true;

  try {
    log.info('=== Starting Dispatch cycle ===');

    let projects;
    try {
      projects = await loadActiveProjects();
    } catch (err) {
      log.error('Failed to load projects', { error: err.message });
      await reportError(err, { phase: 'load_projects' });
      return;
    }

    // No active projects and no waiting ones — kick off onboarding
    if (!projects.length) {
      const waiting = await loadWaitingProjects();
      if (waiting.length) {
        log.info('Projects are waiting for input, nothing to do this cycle');
        return;
      }
      try {
        const newId = await onboard();
        projects = [newId];
      } catch (err) {
        log.error('Onboarding failed', { error: err.message });
        await reportError(err, { phase: 'onboarding' });
        return;
      }
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
  } finally {
    cycleRunning = false;
  }
}

async function processProject(projectId) {
  log.info(`Processing project: ${projectId}`);

  const state = await loadProject(projectId);

  // Skip if waiting for input
  if (state.status === 'waiting_input') {
    log.info(`Project ${projectId} is waiting for Greg's input, skipping`);
    return;
  }

  // If project is completed, ask Greg what's next
  if (state.status === 'completed') {
    log.info(`Project ${projectId} is completed. Asking Greg for next goal.`);
    await sendMessage(`:tada: *${state.name}* is complete! Nice work.\n\nWhat should we tackle next?`);
    const reply = await waitForGreg();
    const parsed = await parseGoal(reply);

    state.currentGoal = parsed.currentGoal;
    state.status = 'active';
    state.gregDirection = null;
    state.context.techStack = parsed.techStack || state.context.techStack;
    state.context.preferences = parsed.preferences || state.context.preferences;
    await saveProject(state);
    await sendMessage(`:rocket: New goal set: *${parsed.currentGoal}*\n\nStarting work...`);
  }

  // --- Time budget and iteration setup ---
  const timeBudget = (state.timeBudget || 0) * 60 * 1000; // convert minutes to ms
  const maxIterations = state.maxIterations || 1;
  const sessionStart = Date.now();
  const timeRemaining = () => timeBudget > 0 ? timeBudget - (Date.now() - sessionStart) : Infinity;

  if (timeBudget > 0) {
    log.info(`Time budget: ${state.timeBudget}m, max iterations: ${maxIterations}`);
    await sendMessage(`:clock1: Starting timed session for *${state.name}*: ${state.timeBudget} minute budget, up to ${maxIterations} iteration(s).`);
  }

  // Track iteration branches for the summary
  const iterationBranches = [];
  let currentIteration = 0;

  // --- Main iteration loop ---
  while (currentIteration < maxIterations) {
    currentIteration++;

    // Check time budget
    if (timeBudget > 0 && timeRemaining() < 60000) { // less than 1 minute left
      log.info('Time budget nearly exhausted, stopping iterations');
      break;
    }

    if (currentIteration > 1) {
      log.info(`=== Starting iteration ${currentIteration}/${maxIterations} ===`);
      await sendMessage(`:repeat: Starting iteration ${currentIteration}/${maxIterations} — trying a different approach...`);
    }

    // 1. Analyze current repository state
    log.info(`Analyzing repo for ${projectId}`);
    const analysis = await analyzeRepo(state.repoPath);
    log.info(`Repo analysis: ${analysis.summary}`);

    // 2. Ask Grok what to do next (with iteration context)
    log.info(`Consulting Grok for ${projectId}`);

    // If iterating, tell Grok about previous iterations so it varies its approach
    if (currentIteration > 1 && iterationBranches.length > 0) {
      const prevContext = iterationBranches.map((b, i) =>
        `Iteration ${i + 1} (branch: ${b.branch}): ${b.summary}`
      ).join('\n');
      state.gregDirection = (state.gregDirection || '') +
        `\n\n[ITERATION MODE] This is iteration ${currentIteration}. Previous approaches:\n${prevContext}\n\nTry a meaningfully DIFFERENT approach this time. Different architecture, different libraries, different structure.`;
    }

    const decision = await proposeNextStep(state, analysis);

    // If currentGoal is empty but Greg gave direction, adopt it as the goal
    if (!state.currentGoal && state.gregDirection) {
      state.currentGoal = state.gregDirection;
      log.info(`Set currentGoal from Greg's direction: ${state.currentGoal.slice(0, 100)}...`);
    }

    // Clear Greg's direction after Grok has consumed it
    if (state.gregDirection) {
      state.gregDirection = null;
      await saveProject(state);
    }

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

    let execution = await executeTask(decision.nextStep, state, state.repoPath);

    // 5. Handle execution result
    if (execution.status === 'completed' && execution.commitHash) {
      // --- REVIEW LOOP: Grok reviews and decides when it's done ---
      const result = await reviewLoop(state, decision, execution);

      if (result === 'waiting') return; // Escalated to Greg, exit

      // Task approved — record it
      const taskEntry = {
        task: decision.nextStep.task,
        completedAt: new Date().toISOString(),
        commitHash: result.commitHash,
        revisions: result.revisionCount,
        iteration: maxIterations > 1 ? currentIteration : undefined,
      };

      // --- Iteration branching ---
      // Skip branching for prerequisite/housekeeping tasks (commits, config fixes, etc.)
      // These don't count as real iterations — just keep the work on main and continue
      const isPrereq = decision.nextStep.isPrerequisite === true;
      if (isPrereq) {
        log.info(`Task was a prerequisite, not counting as iteration. Continuing to main work.`);
        currentIteration--; // Don't count this against iteration budget
      } else if (maxIterations > 1 && currentIteration < maxIterations && timeRemaining() > 60000) {
        // Branch this iteration's work before resetting for the next one
        const git = simpleGit(state.repoPath);
        const branchName = `iteration-${currentIteration}`;
        try {
          await git.checkoutLocalBranch(branchName);
          await git.checkout('main');
          // Reset main to before this iteration's work
          if (result.beforeHash) {
            await git.reset(['--hard', result.beforeHash]);
          }
          iterationBranches.push({
            branch: branchName,
            summary: result.summary,
            commitHash: result.commitHash,
          });
          log.info(`Branched iteration ${currentIteration} as "${branchName}"`);
          await sendMessage(`:bookmark: Saved iteration ${currentIteration} as branch \`${branchName}\``);
        } catch (err) {
          log.warn(`Failed to branch iteration: ${err.message}. Keeping work on main.`);
        }
      }

      state.completed.push(taskEntry);
      state.inProgress = null;
      state.lastActivity = new Date().toISOString();

      await reportProgress({
        summary: result.summary,
        filesChanged: result.filesChanged,
        commitHash: result.commitHash,
        projectName: state.name,
        revisions: result.revisionCount,
        iteration: maxIterations > 1 ? currentIteration : undefined,
      });

      log.info(`Task completed (iteration ${currentIteration}): ${result.summary}`);
      await saveProject(state);

    } else if (execution.status === 'completed' && !execution.commitHash) {
      const questions = [`Claude worked on "${decision.nextStep.task}" but didn't produce a commit. How should we proceed?`];
      await askGreg(questions.join('\n'), { state, execution });
      state.status = 'waiting_input';
      state.inProgress = null;
      await saveProject(state);
      log.info('Execution completed without commit, escalated to Greg');
      return;
    } else if (execution.status === 'needs_input') {
      const questions = execution.questionsForGreg?.join('\n') || execution.summary;
      await askGreg(questions, { state, execution });
      state.status = 'waiting_input';
      state.inProgress = null;
      await saveProject(state);
      log.info(`Execution needs input, escalated to Greg`);
      return;
    } else {
      log.error(`Task failed: ${execution.summary}`, { issues: execution.issues });
      await reportError(new Error(execution.summary), { projectId, phase: 'execution' });
      state.inProgress = null;
      await saveProject(state);
      return; // Don't continue iterations on failure
    }

    // If single-cycle mode (no time budget), break after first task
    if (timeBudget === 0) break;
  }

  // --- Session summary ---
  if (iterationBranches.length > 1) {
    const branchList = iterationBranches.map((b, i) =>
      `  ${i + 1}. \`${b.branch}\` — ${b.summary}`
    ).join('\n');
    const elapsed = Math.floor((Date.now() - sessionStart) / 60000);
    await sendMessage([
      `:checkered_flag: *Session complete for ${state.name}*`,
      `Elapsed: ${elapsed} minutes | ${iterationBranches.length} iterations`,
      '',
      `*Branches to compare:*`,
      branchList,
      '',
      `Switch between them with \`git checkout iteration-N\` and pick your favorite.`,
    ].join('\n'));

    log.info(`Session complete: ${iterationBranches.length} iterations in ${elapsed}m`);
  }
}

// ---------------------------------------------------------------------------
// Review loop — extracted to keep processProject readable
// ---------------------------------------------------------------------------

async function reviewLoop(state, decision, execution) {
  const SAFETY_CAP = 6;
  let revisionCount = 0;
  let currentExecution = execution;
  const taskDescription = decision.nextStep.task;
  const revisionHistory = [];

  // Capture the HEAD before this task started (for iteration branching reset)
  const git = simpleGit(state.repoPath);
  let beforeHash = null;
  try {
    // Walk back past this execution's commits to find the pre-task HEAD
    const logResult = await git.log({ maxCount: 20 });
    const execCommitIdx = logResult.all.findIndex(c => c.hash === execution.commitHash);
    if (execCommitIdx >= 0 && execCommitIdx + 1 < logResult.all.length) {
      beforeHash = logResult.all[execCommitIdx + 1].hash;
    }
  } catch { /* ok */ }

  while (revisionCount < SAFETY_CAP) {
    log.info(`Grok reviewing Claude's work (round ${revisionCount + 1})`);
    await sendMessage(`:mag: Grok is reviewing Claude's work on: *${taskDescription}*`);

    const commitInfo = await getCommitDiff(state.repoPath, currentExecution.commitHash);
    const review = await reviewWork(state, taskDescription, commitInfo, revisionHistory);

    if (review.decision === 'approve') {
      log.info(`✅ Grok approved the work: ${review.summary}`);
      await sendMessage(`:white_check_mark: Grok approved: ${review.summary}`);
      return {
        commitHash: currentExecution.commitHash,
        summary: currentExecution.summary || review.summary,
        filesChanged: currentExecution.filesChanged,
        revisionCount,
        beforeHash,
      };
    }

    if (review.decision === 'ask_greg') {
      log.info(`Grok wants Greg's input: ${review.questionForGreg}`);
      await askGreg(
        `:thinking_face: Grok reviewed the work and wants your input:\n\n${review.questionForGreg}\n\n_Summary: ${review.summary}_`,
        { state, execution: currentExecution }
      );
      state.status = 'waiting_input';
      state.inProgress = null;
      await saveProject(state);
      return 'waiting';
    }

    // decision === 'revise'
    revisionCount++;
    revisionHistory.push({ feedback: review.feedback, revisions: review.revisions });
    log.info(`Grok requested revisions (round ${revisionCount}): ${review.feedback}`);
    await sendMessage(`:memo: Grok requested revisions (round ${revisionCount}): ${review.feedback}`);

    const revisionResult = await executeRevision(review, taskDescription, state, state.repoPath);

    if (revisionResult.status === 'completed' && revisionResult.commitHash) {
      currentExecution = revisionResult;
    } else {
      log.warn(`Revision attempt failed: ${revisionResult.summary}`);
      await askGreg(
        `:warning: Claude's revision didn't produce a clean result.\n\nOriginal task: ${taskDescription}\nAttempted revisions: ${revisionCount}\n\nHow should we proceed?`,
        { state, execution: currentExecution }
      );
      state.status = 'waiting_input';
      state.inProgress = null;
      await saveProject(state);
      return 'waiting';
    }
  }

  // Hit safety cap
  log.warn(`Hit safety cap (${SAFETY_CAP} revisions). Escalating to Greg.`);
  await askGreg(
    `:rotating_light: Hit ${SAFETY_CAP} revision rounds on: *${taskDescription}*. Want me to accept the current state, or do you have direction?`,
    { state, execution: currentExecution }
  );
  state.status = 'waiting_input';
  state.inProgress = null;
  await saveProject(state);
  return 'waiting';
}

// ---------------------------------------------------------------------------
// Handle Greg's replies to waiting projects
// ---------------------------------------------------------------------------

function registerGregHandler() {
  onGreg(async (text) => {
    log.info('Greg message received, checking for projects to act on');

    try {
      // First check for waiting projects — resume the most recent one
      const waiting = await loadWaitingProjects();
      if (waiting.length) {
        const projectId = waiting[0];
        log.info(`Resuming waiting project ${projectId} with Greg's direction`);
        await resumeProject(projectId, text);
        await dispatchCycle();
        return;
      }

      // No waiting projects — apply direction to the most recent active project
      const active = await loadActiveProjects();
      if (active.length) {
        const projectId = active[0];
        log.info(`Applying Greg's direction to active project ${projectId}`);
        const state = await loadProject(projectId);
        state.gregDirection = text;
        state.lastActivity = new Date().toISOString();
        await saveProject(state);
        await sendMessage(`:thumbsup: Got it — I'll factor that into the next cycle for *${state.name}*.`);
        await dispatchCycle();
        return;
      }

      // No projects at all — treat as a new project request, trigger onboarding cycle
      log.info('No projects found, treating Greg message as new project request');
      await dispatchCycle();
    } catch (err) {
      log.error('Failed to handle Greg reply', { error: err.message });
      await reportError(err, { phase: 'greg_reply_handler' });
    }
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isManualRun = process.argv.includes('--now');

if (isManualRun) {
  try {
    validateConfig();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
  startSlack()
    .then(() => {
      registerGregHandler();
      return dispatchCycle();
    })
    .then(() => {
      log.info('Manual cycle finished');
      return stopSlack();
    })
    .then(() => process.exit(0))
    .catch(err => {
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

  startSlack().then(async () => {
    log.info('Slack connected.');

    // Register handler so Greg's replies resume waiting projects immediately
    registerGregHandler();

    // Run first cycle immediately on startup
    await dispatchCycle();

    // Then continue on schedule
    cron.schedule(schedule, dispatchCycle);
    log.info(`Dispatch daemon running. Schedule: ${schedule}`);
  }).catch(err => {
    log.error(`Failed to start Slack: ${err.message}`);
    cron.schedule(schedule, dispatchCycle);
    log.info(`Dispatch daemon started without Slack. Schedule: ${schedule}`);
  });

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      log.info(`Received ${signal}, shutting down`);
      await stopSlack();
      process.exit(0);
    });
  }
}
