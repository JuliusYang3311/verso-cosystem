// Anthropic authentication handlers
// Copied from src/commands/auth-choice.apply.anthropic.js

const fs = require('fs');
const path = require('path');
const os = require('os');

function getAuthProfilePath(agentDir) {
  return path.join(agentDir || path.join(os.homedir(), '.verso'), 'auth-profiles.json');
}

function upsertAuthProfile({ profileId, agentDir, credential }) {
  const profilePath = getAuthProfilePath(agentDir);
  let profiles = {};

  if (fs.existsSync(profilePath)) {
    try {
      profiles = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } catch (err) {
      console.error('Error reading auth profiles:', err);
    }
  }

  profiles[profileId] = credential;

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(profiles, null, 2));
}

function validateAnthropicSetupToken(token) {
  if (!token || token.trim().length === 0) {
    return 'Token is required';
  }
  // Basic validation - setup tokens are typically long base64 strings
  if (token.length < 20) {
    return 'Token appears to be too short';
  }
  return undefined;
}

function buildTokenProfileId({ provider, name }) {
  const profileName = name.trim() || 'default';
  return `${provider}:${profileName}`;
}

async function handleAnthropicSetupToken({ agentDir, token, profileName }) {
  const provider = 'anthropic';
  const namedProfileId = buildTokenProfileId({
    provider,
    name: profileName || 'default',
  });

  upsertAuthProfile({
    profileId: namedProfileId,
    agentDir,
    credential: {
      type: 'token',
      provider,
      token,
    },
  });

  return {
    success: true,
    profileId: namedProfileId,
    provider,
    mode: 'token',
  };
}

async function handleAnthropicApiKey({ agentDir, apiKey }) {
  const profilePath = path.join(agentDir || path.join(os.homedir(), '.verso'), 'anthropic-api-key.txt');

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, apiKey.trim());

  return {
    success: true,
    profileId: 'anthropic:default',
    provider: 'anthropic',
    mode: 'api_key',
  };
}

module.exports = {
  handleAnthropicSetupToken,
  handleAnthropicApiKey,
  validateAnthropicSetupToken,
};
