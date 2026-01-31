import simpleGit from 'simple-git';
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

    return {
      recentCommits,
      changedFiles,
      uncommittedChanges,
      branch,
      lastCommitTime,
      summary,
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

function timeSince(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
