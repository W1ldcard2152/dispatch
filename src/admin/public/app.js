// ---- State ----
let projects = [];
let selectedId = null;
let isNewProject = false;

// ---- DOM refs ----
const projectList = document.getElementById('project-list');
const editorEmpty = document.getElementById('editor-empty');
const form = document.getElementById('project-form');
const formTitle = document.getElementById('form-title');
const btnNew = document.getElementById('btn-new');
const btnDelete = document.getElementById('btn-delete');
const btnBrowse = document.getElementById('btn-browse');
const toastEl = document.getElementById('toast');

// Browse modal refs
const browseModal = document.getElementById('browse-modal');
const browseClose = document.getElementById('browse-close');
const browseUp = document.getElementById('browse-up');
const browseSelect = document.getElementById('browse-select');
const browsePath = document.getElementById('browse-path');
const browseList = document.getElementById('browse-list');
const browseGitBadge = document.getElementById('browse-git-badge');

const fields = {
  projectId: document.getElementById('f-projectId'),
  name: document.getElementById('f-name'),
  repoPath: document.getElementById('f-repoPath'),
  currentGoal: document.getElementById('f-currentGoal'),
  status: document.getElementById('f-status'),
  gregAvailability: document.getElementById('f-gregAvailability'),
  timeBudget: document.getElementById('f-timeBudget'),
  maxIterations: document.getElementById('f-maxIterations'),
  techStack: document.getElementById('f-techStack'),
  preferences: document.getElementById('f-preferences'),
  gregDirection: document.getElementById('f-gregDirection'),
};

// ---- Folder browser ----
let browseCurrentPath = '';

async function loadBrowseDir(path) {
  try {
    const params = path ? `?path=${encodeURIComponent(path)}` : '';
    const data = await api(`/browse${params}`);
    browseCurrentPath = data.current;
    browsePath.textContent = data.current;
    browseUp.disabled = !data.parent;
    browseUp.dataset.parent = data.parent || '';

    // Git repo indicator
    if (data.isGitRepo) {
      browseGitBadge.classList.remove('hidden');
    } else {
      browseGitBadge.classList.add('hidden');
    }

    browseList.innerHTML = '';
    for (const dir of data.dirs) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="folder-icon">📁</span> ${dir}`;
      li.addEventListener('click', () => loadBrowseDir(data.current + data.sep + dir));
      browseList.appendChild(li);
    }

    if (data.dirs.length === 0) {
      browseList.innerHTML = '<li style="color:var(--text-dim);cursor:default">No subdirectories</li>';
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

btnBrowse.addEventListener('click', () => {
  browseModal.classList.remove('hidden');
  // Start from current value or home
  const startPath = fields.repoPath.value.trim() || '';
  loadBrowseDir(startPath);
});

browseClose.addEventListener('click', () => browseModal.classList.add('hidden'));

browseUp.addEventListener('click', () => {
  if (browseUp.dataset.parent) loadBrowseDir(browseUp.dataset.parent);
});

browseSelect.addEventListener('click', () => {
  fields.repoPath.value = browseCurrentPath;
  browseModal.classList.add('hidden');
  toast(`Selected: ${browseCurrentPath}`);
});

// Close modal on backdrop click
browseModal.addEventListener('click', (e) => {
  if (e.target === browseModal) browseModal.classList.add('hidden');
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !browseModal.classList.contains('hidden')) {
    browseModal.classList.add('hidden');
  }
});

// ---- API helpers ----
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- Toast ----
let toastTimer;
function toast(msg, type = 'success') {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

// ---- Render sidebar ----
function renderList() {
  projectList.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.dataset.id = p.projectId;
    if (p.projectId === selectedId) li.classList.add('active');
    li.innerHTML = `
      <span class="project-name">${p.name || p.projectId}</span>
      <span class="project-status ${p.status}">${p.status.replace('_', ' ')}</span>
    `;
    li.addEventListener('click', () => selectProject(p.projectId));
    projectList.appendChild(li);
  }
}

// ---- Select / populate form ----
function selectProject(id) {
  selectedId = id;
  isNewProject = false;
  const project = projects.find(p => p.projectId === id);
  if (!project) return;

  editorEmpty.classList.add('hidden');
  form.classList.remove('hidden');
  formTitle.textContent = project.name || project.projectId;

  fields.projectId.value = project.projectId;
  fields.projectId.readOnly = true;
  fields.name.value = project.name || '';
  fields.repoPath.value = project.repoPath || '';
  fields.currentGoal.value = project.currentGoal || '';
  fields.status.value = project.status || 'active';
  fields.gregAvailability.value = project.context?.gregAvailability || '';
  fields.timeBudget.value = project.timeBudget ?? 0;
  fields.maxIterations.value = project.maxIterations ?? 1;
  fields.techStack.value = (project.context?.techStack || []).join(', ');
  fields.preferences.value = (project.context?.preferences || []).join(', ');
  fields.gregDirection.value = project.gregDirection || '';

  // Completed tasks
  const historySection = document.getElementById('history-section');
  const completedList = document.getElementById('completed-list');
  const completedCount = document.getElementById('completed-count');

  if (project.completed?.length) {
    historySection.classList.remove('hidden');
    completedCount.textContent = project.completed.length;
    completedList.innerHTML = project.completed.map(c => `
      <div class="history-item">
        <div class="task-name">${c.task}</div>
        <div class="task-meta">
          ${c.completedAt ? new Date(c.completedAt).toLocaleString() : ''}
          ${c.commitHash ? ` · <code>${c.commitHash.slice(0, 7)}</code>` : ''}
          ${c.revisions ? ` · ${c.revisions} revision(s)` : ''}
          ${c.iteration ? ` · iteration ${c.iteration}` : ''}
        </div>
      </div>
    `).reverse().join('');
  } else {
    historySection.classList.add('hidden');
  }

  // Blockers
  const blockerSection = document.getElementById('blockers-section');
  const blockerList = document.getElementById('blocker-list');
  const blockerCount = document.getElementById('blocker-count');

  if (project.blockers?.length) {
    blockerSection.classList.remove('hidden');
    blockerCount.textContent = project.blockers.length;
    blockerList.innerHTML = project.blockers.map(b => `
      <div class="history-item">
        <div class="task-name">${b.description}</div>
        <div class="task-meta">${b.addedAt ? new Date(b.addedAt).toLocaleString() : ''}</div>
      </div>
    `).join('');
  } else {
    blockerSection.classList.add('hidden');
  }

  btnDelete.classList.remove('hidden');
  renderList();
}

// ---- New project ----
function newProject() {
  selectedId = null;
  isNewProject = true;

  editorEmpty.classList.add('hidden');
  form.classList.remove('hidden');
  formTitle.textContent = 'New Project';

  fields.projectId.value = '';
  fields.projectId.readOnly = false;
  fields.name.value = '';
  fields.repoPath.value = '';
  fields.currentGoal.value = '';
  fields.status.value = 'active';
  fields.gregAvailability.value = 'Business hours weekdays, limited weekends';
  fields.timeBudget.value = 0;
  fields.maxIterations.value = 1;
  fields.techStack.value = '';
  fields.preferences.value = '';
  fields.gregDirection.value = '';

  document.getElementById('history-section').classList.add('hidden');
  document.getElementById('blockers-section').classList.add('hidden');
  btnDelete.classList.add('hidden');

  renderList();
  fields.projectId.focus();
}

// ---- Save ----
async function save(e) {
  e.preventDefault();

  const parseList = (str) => str.split(',').map(s => s.trim()).filter(Boolean);

  const body = {
    projectId: fields.projectId.value.trim(),
    name: fields.name.value.trim(),
    repoPath: fields.repoPath.value.trim(),
    currentGoal: fields.currentGoal.value.trim(),
    status: fields.status.value,
    gregAvailability: fields.gregAvailability.value.trim(),
    timeBudget: parseInt(fields.timeBudget.value) || 0,
    maxIterations: parseInt(fields.maxIterations.value) || 1,
    techStack: parseList(fields.techStack.value),
    preferences: parseList(fields.preferences.value),
    gregDirection: fields.gregDirection.value.trim() || null,
  };

  try {
    if (isNewProject) {
      const created = await api('/projects', { method: 'POST', body });
      projects.push(created);
      selectedId = created.projectId;
      isNewProject = false;
      toast('Project created');
    } else {
      const updated = await api(`/projects/${selectedId}`, { method: 'PUT', body });
      const idx = projects.findIndex(p => p.projectId === selectedId);
      if (idx >= 0) projects[idx] = updated;
      toast('Project saved');
    }

    fields.projectId.readOnly = true;
    renderList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- Delete ----
async function deleteProject() {
  if (!selectedId) return;
  if (!confirm(`Delete project "${selectedId}"? This cannot be undone.`)) return;

  try {
    await api(`/projects/${selectedId}`, { method: 'DELETE' });
    projects = projects.filter(p => p.projectId !== selectedId);
    selectedId = null;
    isNewProject = false;
    form.classList.add('hidden');
    editorEmpty.classList.remove('hidden');
    renderList();
    toast('Project deleted');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- Load config status badges ----
async function loadConfig() {
  try {
    const cfg = await api('/config');
    if (cfg.hasGrokKey) document.getElementById('status-grok').classList.add('connected');
    if (cfg.hasSlackBot) document.getElementById('status-slack').classList.add('connected');
  } catch { /* ok */ }
}

// ---- Init ----
async function init() {
  try {
    projects = await api('/projects');
    projects.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
    renderList();
    loadConfig();
  } catch (err) {
    toast('Failed to load projects: ' + err.message, 'error');
  }
}

// ---- Event listeners ----
btnNew.addEventListener('click', newProject);
btnDelete.addEventListener('click', deleteProject);
form.addEventListener('submit', save);

// Keyboard shortcut: Ctrl+S to save
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (!form.classList.contains('hidden')) {
      form.requestSubmit();
    }
  }
});

init();
