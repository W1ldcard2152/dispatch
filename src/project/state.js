import { readFile, writeFile, readdir, copyFile, mkdir } from 'fs/promises';
import { join } from 'path';
import config from '../config.js';
import { validateProjectState } from '../utils/schemas.js';
import { log } from '../utils/logger.js';

const projectsDir = join(config.dataDir, 'projects');

function projectPath(projectId) {
  return join(projectsDir, `${projectId}.json`);
}

function backupPath(projectId) {
  return join(projectsDir, `${projectId}.backup.json`);
}

export async function loadProject(projectId) {
  const file = projectPath(projectId);
  const raw = await readFile(file, 'utf-8');
  const state = JSON.parse(raw);
  const errors = validateProjectState(state);
  if (errors.length) {
    log.warn(`Project ${projectId} has schema issues: ${errors.join(', ')}`);
  }
  return state;
}

export async function saveProject(state) {
  const errors = validateProjectState(state);
  if (errors.length) {
    throw new Error(`Cannot save invalid project state: ${errors.join(', ')}`);
  }

  await mkdir(projectsDir, { recursive: true });
  const file = projectPath(state.projectId);

  // Keep a backup before overwriting
  try {
    await copyFile(file, backupPath(state.projectId));
  } catch { /* first save, no backup needed */ }

  state.lastChecked = new Date().toISOString();
  await writeFile(file, JSON.stringify(state, null, 2));
  log.debug(`Saved project ${state.projectId}`);
}

export async function updateProgress(state, completedTask, commitHash) {
  state.completed.push({
    task: completedTask,
    completedAt: new Date().toISOString(),
    commitHash: commitHash || null,
  });
  state.inProgress = null;
  state.lastActivity = new Date().toISOString();
  await saveProject(state);
}

export async function addBlocker(state, blocker) {
  state.blockers.push({
    description: blocker,
    addedAt: new Date().toISOString(),
  });
  await saveProject(state);
}

export async function markComplete(state) {
  state.status = 'completed';
  state.inProgress = null;
  await saveProject(state);
  log.info(`Project ${state.projectId} marked complete`);
}

export async function loadActiveProjects() {
  await mkdir(projectsDir, { recursive: true });
  const files = await readdir(projectsDir);
  const ids = files
    .filter(f => f.endsWith('.json') && !f.endsWith('.backup.json'))
    .map(f => f.replace('.json', ''));

  const active = [];
  for (const id of ids) {
    try {
      const state = await loadProject(id);
      if (state.status === 'active') active.push(id);
    } catch (err) {
      log.warn(`Skipping project ${id}: ${err.message}`);
    }
  }
  return active;
}

export async function loadWaitingProjects() {
  await mkdir(projectsDir, { recursive: true });
  const files = await readdir(projectsDir);
  const ids = files
    .filter(f => f.endsWith('.json') && !f.endsWith('.backup.json'))
    .map(f => f.replace('.json', ''));

  const waiting = [];
  for (const id of ids) {
    try {
      const state = await loadProject(id);
      if (state.status === 'waiting_input') waiting.push(id);
    } catch (err) {
      log.warn(`Skipping project ${id}: ${err.message}`);
    }
  }
  return waiting;
}

export async function resumeProject(projectId, gregDirection) {
  const state = await loadProject(projectId);
  state.status = 'active';
  state.gregDirection = gregDirection;  // Grok will use this as context
  state.lastActivity = new Date().toISOString();
  await saveProject(state);
  log.info(`Project ${projectId} resumed with Greg's direction`);
  return state;
}
