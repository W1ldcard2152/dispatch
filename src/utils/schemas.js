/**
 * Validate a project state object. Returns an array of error strings (empty = valid).
 */
export function validateProjectState(state) {
  const errors = [];
  if (!state.projectId || typeof state.projectId !== 'string') errors.push('projectId is required');
  if (!state.name || typeof state.name !== 'string') errors.push('name is required');
  if (!state.repoPath || typeof state.repoPath !== 'string') errors.push('repoPath is required');
  if (!['active', 'paused', 'completed', 'waiting_input'].includes(state.status)) {
    errors.push(`invalid status: ${state.status}`);
  }
  if (!Array.isArray(state.completed)) errors.push('completed must be an array');
  return errors;
}

/**
 * Validate a Grok decision object.
 */
export function validateDecision(decision) {
  const errors = [];
  if (!decision.nextStep?.task) errors.push('nextStep.task is required');
  if (!['high', 'medium', 'low'].includes(decision.confidence)) {
    errors.push(`invalid confidence: ${decision.confidence}`);
  }
  if (typeof decision.needsGreg !== 'boolean') errors.push('needsGreg must be boolean');
  return errors;
}

/**
 * Validate a Claude execution result.
 */
export function validateExecution(result) {
  const errors = [];
  if (!['completed', 'failed', 'needs_input'].includes(result.status)) {
    errors.push(`invalid status: ${result.status}`);
  }
  if (!result.summary) errors.push('summary is required');
  return errors;
}

/**
 * Create a blank project state template.
 */
export function createProjectTemplate(overrides = {}) {
  return {
    projectId: '',
    name: '',
    repoPath: '',
    currentGoal: '',
    status: 'active',
    completed: [],
    inProgress: null,
    blockers: [],
    context: {
      techStack: [],
      preferences: [],
      gregAvailability: 'Business hours weekdays, limited weekends',
    },
    lastChecked: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}
