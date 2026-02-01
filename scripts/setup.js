import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { createProjectTemplate } from '../src/utils/schemas.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

const dataDir = resolve(process.env.DISPATCH_DATA_DIR || './data');
const projectsDir = join(dataDir, 'projects');
const logsDir = join(dataDir, 'logs');

async function ensureDirs() {
  await mkdir(projectsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
}

// --- Add Project ---
async function addProject() {
  console.log('\n--- Add New Project ---\n');

  const projectId = await ask('Project ID (e.g. payroll-app): ');
  if (!projectId.trim()) {
    console.log('Project ID is required');
    return;
  }

  const file = join(projectsDir, `${projectId.trim()}.json`);
  if (existsSync(file)) {
    console.log(`Project "${projectId}" already exists at ${file}`);
    return;
  }

  const name = await ask('Project name: ');
  const repoPath = await ask('Repository path: ');
  const currentGoal = await ask('Current goal: ');
  const techStack = await ask('Tech stack (comma-separated): ');
  const preferences = await ask('Preferences (comma-separated): ');

  const state = createProjectTemplate({
    projectId: projectId.trim(),
    name: name.trim(),
    repoPath: resolve(repoPath.trim()),
    currentGoal: currentGoal.trim(),
    context: {
      techStack: techStack.split(',').map(s => s.trim()).filter(Boolean),
      preferences: preferences.split(',').map(s => s.trim()).filter(Boolean),
      gregAvailability: 'Business hours weekdays, limited weekends',
    },
  });

  await ensureDirs();
  await writeFile(file, JSON.stringify(state, null, 2));
  console.log(`\nProject saved to ${file}`);
}

// --- Show Status ---
async function showStatus() {
  await ensureDirs();
  const { readdir } = await import('fs/promises');
  const files = (await readdir(projectsDir)).filter(f => f.endsWith('.json') && !f.includes('.backup'));

  if (!files.length) {
    console.log('No projects found.');
    return;
  }

  for (const file of files) {
    const raw = await readFile(join(projectsDir, file), 'utf-8');
    const state = JSON.parse(raw);
    console.log(`\n--- ${state.name} (${state.projectId}) ---`);
    console.log(`  Status: ${state.status}`);
    console.log(`  Goal: ${state.currentGoal}`);
    console.log(`  Completed tasks: ${state.completed.length}`);
    console.log(`  In progress: ${state.inProgress?.task || 'None'}`);
    console.log(`  Blockers: ${state.blockers.length}`);
    console.log(`  Last activity: ${state.lastActivity}`);
  }
}

// --- Pause / Resume ---
async function toggleProject(targetStatus) {
  const projectId = process.argv[3];
  if (!projectId) {
    console.log('Usage: npm run project:pause <projectId>');
    return;
  }
  const file = join(projectsDir, `${projectId}.json`);
  if (!existsSync(file)) {
    console.log(`Project "${projectId}" not found`);
    return;
  }
  const state = JSON.parse(await readFile(file, 'utf-8'));
  state.status = targetStatus;
  await writeFile(file, JSON.stringify(state, null, 2));
  console.log(`Project "${projectId}" is now ${targetStatus}`);
}

// --- Verify Config ---
async function verifyConfig() {
  console.log('\n--- Verify Configuration ---\n');

  const envPath = resolve('.env');
  if (!existsSync(envPath)) {
    console.log('.env file not found. Copy .env.example to .env and fill in your keys.');
    return false;
  }

  // Dynamically load dotenv to read the .env
  const { config: dotenvConfig } = await import('dotenv');
  dotenvConfig();

  const checks = [
    ['XAI_API_KEY', process.env.XAI_API_KEY],
    ['SLACK_BOT_TOKEN', process.env.SLACK_BOT_TOKEN],
    ['SLACK_APP_TOKEN', process.env.SLACK_APP_TOKEN],
  ];

  let allGood = true;
  for (const [name, val] of checks) {
    const ok = val && val !== `your_${name.toLowerCase()}_here`;
    console.log(`  ${ok ? 'OK' : 'MISSING'}: ${name}`);
    if (!ok) allGood = false;
  }

  return allGood;
}

// --- Test Slack ---
async function testSlack() {
  const { config: dotenvConfig } = await import('dotenv');
  dotenvConfig();

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || token.includes('your-')) {
    console.log('Slack bot token not configured, skipping test');
    return;
  }

  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`  Slack bot: OK (connected as "${data.user}" in "${data.team}")`);
    } else {
      console.log(`  Slack bot: FAILED (${data.error})`);
    }
  } catch (err) {
    console.log(`  Slack bot: ERROR (${err.message})`);
  }
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--add-project')) {
    await addProject();
  } else if (args.includes('--status')) {
    await showStatus();
  } else if (args.includes('--pause')) {
    await toggleProject('paused');
  } else if (args.includes('--resume')) {
    await toggleProject('active');
  } else {
    // Full setup
    console.log('============================');
    console.log('  Dispatch Setup');
    console.log('============================');

    await ensureDirs();
    console.log('Data directories created.');

    const configOk = await verifyConfig();

    if (configOk) {
      await testSlack();
    }

    const addNow = await ask('\nAdd a project now? (y/n): ');
    if (addNow.toLowerCase() === 'y') {
      await addProject();
    }

    console.log('\nSetup complete. Run `npm start` to launch the daemon or `npm run check` for a single cycle.');
  }

  rl.close();
}

main().catch(err => {
  console.error('Setup error:', err.message);
  rl.close();
  process.exit(1);
});
