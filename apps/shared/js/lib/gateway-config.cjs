// CJS wrapper for Electron/Windows main process
// Tests and browser use the ESM version (gateway-config.js) directly

function resolveGatewayToken(opts) {
  if (opts.configToken && opts.configToken.length >= 16) {
    return { token: opts.configToken, source: 'config' };
  }
  if (opts.envToken && opts.envToken !== 'undefined' && opts.envToken.length >= 16) {
    return { token: opts.envToken, source: 'env' };
  }
  if (opts.checkLaunchd && opts.fs && opts.os && opts.path) {
    try {
      var plistPath = opts.path.join(opts.os.homedir(), 'Library', 'LaunchAgents', 'bot.molt.gateway.plist');
      if (opts.fs.existsSync(plistPath)) {
        var content = opts.fs.readFileSync(plistPath, 'utf8');
        var match = content.match(/<key>VERSO_GATEWAY_TOKEN<\/key>\s*<string>([^<]+)<\/string>/);
        if (match && match[1]) {
          return { token: match[1], source: 'launchd' };
        }
      }
    } catch { /* ignore */ }
  }
  var token = opts.crypto.randomBytes(32).toString('hex');
  return { token: token, source: 'generated' };
}

function ensureGatewayFields(config, token) {
  if (!config.gateway) config.gateway = {};
  if (!config.gateway.controlUi) config.gateway.controlUi = {};
  if (!config.gateway.auth) config.gateway.auth = {};
  if (!config.gateway.mode) config.gateway.mode = 'local';
  config.gateway.controlUi.allowInsecureAuth = true;
  config.gateway.auth.token = token;
  return config;
}

function loadLicenseText(fs, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) {
        return fs.readFileSync(candidates[i], 'utf8');
      }
    } catch { /* ignore */ }
  }
  return null;
}

module.exports = { resolveGatewayToken, ensureGatewayFields, loadLicenseText };
