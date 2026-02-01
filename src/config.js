import 'dotenv/config';
import { resolve } from 'path';

const config = {
  grokApiKey: process.env.XAI_API_KEY,
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackAppToken: process.env.SLACK_APP_TOKEN,
  slackChannel: process.env.SLACK_CHANNEL || 'general',
  checkInterval: process.env.DISPATCH_CHECK_INTERVAL || '0 9-18 * * 1-5',
  dataDir: resolve(process.env.DISPATCH_DATA_DIR || './data'),
  logLevel: process.env.LOG_LEVEL || 'info',
  defaultRepoPath: process.env.DEFAULT_REPO_PATH || '',
};

export function validateConfig(keys = ['grokApiKey', 'slackBotToken']) {
  const missing = keys.filter(k => !config[k]);
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Set them in .env`);
  }
}

export default config;
