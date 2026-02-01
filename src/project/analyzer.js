import simpleGit from 'simple-git';
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative } from 'path';
import { log } from '../utils/logger.js';

export async function analyzeRepo(repoPath) {
  const git = simpleGit(repoPath);

  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return {
        recentCommits: [],
        changedFiles: [],
        uncommittedChanges: false,
        branch: 'unknown',
        lastCommitTime: null,
        summary: 'Directory is not a git repository',
      };
    }

    const [statusResult, logResult, branchResult] = await Promise.all([
      git.status(),
      git.log({ maxCount: 10 }).catch(() => ({ all: [] })),
      git.branch(),
    ]);

    const recentCommits = logResult.all.map(c => c.message);
    const changedFiles = [
      ...statusResult.modified,
      ...statusResult.created,
      ...statusResult.not_added,
    ];
    const uncommittedChanges = !statusResult.isClean();
    const branch = branchResult.current;
    const lastCommitTime = logResult.all[0]?.date || null;

    const summary = buildSummary({
      recentCommits,
      changedFiles,
      uncommittedChanges,
      branch,
      lastCommitTime,
    });

    // Get project structure snapshot for Grok context
    let projectSnapshot = '';
    try {
      projectSnapshot = await getProjectSnapshot(repoPath);
    } catch (err) {
      log.warn(`Failed to get project snapshot: ${err.message}`);
    }

    return {
      recentCommits,
      changedFiles,
      uncommittedChanges,
      branch,
      lastCommitTime,
      summary,
      projectSnapshot,
    };
  } catch (err) {
    log.error(`Failed to analyze repo at ${repoPath}`, { error: err.message });
    return {
      recentCommits: [],
      changedFiles: [],
      uncommittedChanges: false,
      branch: 'unknown',
      lastCommitTime: null,
      summary: `Error analyzing repo: ${err.message}`,
    };
  }
}

function buildSummary({ recentCommits, changedFiles, uncommittedChanges, branch, lastCommitTime }) {
  const parts = [];

  if (branch !== 'unknown') parts.push(`On branch "${branch}".`);

  if (recentCommits.length) {
    parts.push(`Last commit: "${recentCommits[0]}".`);
    if (recentCommits.length > 1) {
      parts.push(`Recent work includes: ${recentCommits.slice(1, 4).join('; ')}.`);
    }
  } else {
    parts.push('No commits yet.');
  }

  if (uncommittedChanges) {
    parts.push(`${changedFiles.length} uncommitted file(s): ${changedFiles.slice(0, 5).join(', ')}.`);
  } else {
    parts.push('Working tree is clean.');
  }

  if (lastCommitTime) {
    const ago = timeSince(new Date(lastCommitTime));
    parts.push(`Last commit was ${ago} ago.`);
  }

  return parts.join(' ');
}

/**
 * Get the actual diff and file contents from a specific commit (or latest).
 * This gives Grok the ability to review what Claude actually wrote.
 */
export async function getCommitDiff(repoPath, commitHash) {
  const git = simpleGit(repoPath);

  try {
    // Get the diff for this commit (what changed)
    const diff = await git.diff([`${commitHash}~1`, commitHash]);

    // Get the list of files changed
    const filesChanged = await git.diff(['--name-only', `${commitHash}~1`, commitHash]);
    const fileList = filesChanged.split('\n').filter(Boolean);

    // For each changed file, get the current content (up to a size limit)
    const fileContents = {};
    for (const file of fileList.slice(0, 15)) {
      try {
        const content = await git.show([`${commitHash}:${file}`]);
        // Cap at 3000 chars per file to stay within token limits
        fileContents[file] = content.length > 3000
          ? content.slice(0, 3000) + '\n... (truncated)'
          : content;
      } catch {
        // File might have been deleted
        fileContents[file] = '(file deleted or binary)';
      }
    }

    return {
      diff: diff.length > 8000 ? diff.slice(0, 8000) + '\n... (truncated)' : diff,
      filesChanged: fileList,
      fileContents,
    };
  } catch (err) {
    log.error(`Failed to get commit diff for ${commitHash}`, { error: err.message });
    return {
      diff: `Error: ${err.message}`,
      filesChanged: [],
      fileContents: {},
    };
  }
}

/**
 * Build a concise snapshot of the project's file structure and key files.
 * This helps Grok understand what already exists before proposing work.
 */
async function getProjectSnapshot(repoPath) {
  const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.prisma', 'coverage']);
  const KEY_FILES = ['schema.prisma', 'package.json', 'tsconfig.json', '.env.example'];
  const KEY_CONTENT_FILES = ['schema.prisma']; // Files whose content Grok should see
  const MAX_DEPTH = 3;

  const tree = [];
  const keyContents = {};

  async function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }

    // Sort: directories first, then files
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(repoPath, fullPath);

      if (entry.isDirectory()) {
        tree.push(`${relPath}/`);
        await walk(fullPath, depth + 1);
      } else {
        tree.push(relPath);

        // Capture content of key files
        if (KEY_CONTENT_FILES.includes(entry.name)) {
          try {
            const content = await readFile(fullPath, 'utf-8');
            // Cap at 4000 chars to keep tokens manageable
            keyContents[relPath] = content.length > 4000
              ? content.slice(0, 4000) + '\n... (truncated)'
              : content;
          } catch { /* skip */ }
        }
      }
    }
  }

  await walk(repoPath, 0);

  let snapshot = `Project structure (${tree.length} items):\n${tree.join('\n')}`;

  if (Object.keys(keyContents).length) {
    snapshot += '\n\nKey file contents:';
    for (const [file, content] of Object.entries(keyContents)) {
      snapshot += `\n\n=== ${file} ===\n${content}`;
    }
  }

  return snapshot;
}

function timeSince(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
