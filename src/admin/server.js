import express from 'express';
import { readFile, writeFile, readdir, mkdir, unlink, stat } from 'fs/promises';
import { join, dirname, resolve, sep } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import config from '../config.js';
import { createProjectTemplate, validateProjectState } from '../utils/schemas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.ADMIN_PORT || 3001;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const projectsDir = join(config.dataDir, 'projects');

// ---- API Routes ----

// List all projects
app.get('/api/projects', async (req, res) => {
  try {
    await mkdir(projectsDir, { recursive: true });
    const files = await readdir(projectsDir);
    const projects = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.backup.json')) continue;
      try {
        const raw = await readFile(join(projectsDir, f), 'utf-8');
        projects.push(JSON.parse(raw));
      } catch { /* skip corrupt files */ }
    }
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single project
app.get('/api/projects/:id', async (req, res) => {
  try {
    const raw = await readFile(join(projectsDir, `${req.params.id}.json`), 'utf-8');
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(404).json({ error: `Project not found: ${req.params.id}` });
  }
});

// Create new project
app.post('/api/projects', async (req, res) => {
  try {
    const data = req.body;
    if (!data.projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const state = createProjectTemplate({
      projectId: data.projectId,
      name: data.name || data.projectId,
      repoPath: data.repoPath || '',
      currentGoal: data.currentGoal || '',
      status: data.status || 'active',
      timeBudget: parseInt(data.timeBudget) || 0,
      maxIterations: parseInt(data.maxIterations) || 1,
      context: {
        techStack: data.techStack || [],
        preferences: data.preferences || [],
        gregAvailability: data.gregAvailability || 'Business hours weekdays, limited weekends',
      },
    });

    const errors = validateProjectState(state);
    if (errors.length) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    await mkdir(projectsDir, { recursive: true });
    await writeFile(join(projectsDir, `${state.projectId}.json`), JSON.stringify(state, null, 2));
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update project
app.put('/api/projects/:id', async (req, res) => {
  try {
    const filePath = join(projectsDir, `${req.params.id}.json`);
    const raw = await readFile(filePath, 'utf-8');
    const existing = JSON.parse(raw);
    const data = req.body;

    // Merge updates
    const updated = {
      ...existing,
      name: data.name ?? existing.name,
      repoPath: data.repoPath ?? existing.repoPath,
      currentGoal: data.currentGoal ?? existing.currentGoal,
      status: data.status ?? existing.status,
      gregDirection: data.gregDirection ?? existing.gregDirection,
      timeBudget: data.timeBudget ?? existing.timeBudget ?? 0,
      maxIterations: data.maxIterations ?? existing.maxIterations ?? 1,
      context: {
        ...existing.context,
        techStack: data.techStack ?? existing.context?.techStack ?? [],
        preferences: data.preferences ?? existing.context?.preferences ?? [],
        gregAvailability: data.gregAvailability ?? existing.context?.gregAvailability ?? '',
      },
      lastChecked: new Date().toISOString(),
    };

    const errors = validateProjectState(updated);
    if (errors.length) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    await writeFile(filePath, JSON.stringify(updated, null, 2));
    res.json(updated);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: `Project not found: ${req.params.id}` });
    }
    res.status(500).json({ error: err.message });
  }
});

// Delete project
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const filePath = join(projectsDir, `${req.params.id}.json`);
    await unlink(filePath);
    // Also try to remove backup
    try { await unlink(join(projectsDir, `${req.params.id}.backup.json`)); } catch { /* ok */ }
    res.json({ deleted: req.params.id });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: `Project not found: ${req.params.id}` });
    }
    res.status(500).json({ error: err.message });
  }
});

// Get dispatch config (non-sensitive)
app.get('/api/config', (req, res) => {
  res.json({
    checkInterval: config.checkInterval,
    dataDir: config.dataDir,
    slackChannel: config.slackChannel,
    defaultRepoPath: config.defaultRepoPath,
    logLevel: config.logLevel,
    hasGrokKey: !!config.grokApiKey,
    hasSlackBot: !!config.slackBotToken,
    hasSlackApp: !!config.slackAppToken,
  });
});

// Browse directories (for folder picker)
app.get('/api/browse', async (req, res) => {
  try {
    const requestedPath = req.query.path || homedir();
    const absPath = resolve(requestedPath);

    const entries = await readdir(absPath, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (entry.isSymbolicLink()) {
        // On Windows, junctions/symlinks to directories report isDirectory()=false
        try {
          const target = await stat(join(absPath, entry.name));
          if (target.isDirectory()) dirs.push(entry.name);
        } catch { /* broken symlink, skip */ }
      }
    }
    dirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    // Check if this dir is a git repo
    let isGitRepo = false;
    try {
      await stat(join(absPath, '.git'));
      isGitRepo = true;
    } catch { /* not a repo */ }

    const parent = dirname(absPath);
    res.json({
      current: absPath,
      parent: parent !== absPath ? parent : null, // null if at root
      dirs,
      isGitRepo,
      sep,
    });
  } catch (err) {
    res.status(400).json({ error: `Cannot read directory: ${err.message}` });
  }
});

// Get recent logs
app.get('/api/logs', async (req, res) => {
  try {
    const logsDir = join(config.dataDir, 'logs');
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(logsDir, `dispatch-${today}.log`);
    const raw = await readFile(logFile, 'utf-8');
    const lines = raw.trim().split('\n').slice(-100); // last 100 lines
    res.json({ lines });
  } catch {
    res.json({ lines: ['No logs found for today.'] });
  }
});

// SPA fallback (Express 5 syntax)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  🎛️  Dispatch Admin UI: http://localhost:${PORT}\n`);
});
