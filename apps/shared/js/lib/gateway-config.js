/**
 * Gateway configuration helpers.
 * Resolves gateway token, ensures config structure.
 *
 * Browser: Not usable directly (requires Node APIs).
 * Node/vitest: import { resolveGatewayToken, ... } from './gateway-config.js'
 */

/**
 * Resolve gateway token from multiple sources.
 * @param {object} opts
 * @param {object} opts.crypto - Node crypto module
 * @param {string} [opts.configToken] - Token from config file
 * @param {string} [opts.envToken] - VERSO_GATEWAY_TOKEN env var
 * @param {boolean} [opts.checkLaunchd=false] - Check macOS launchd plist
 * @param {object} [opts.fs] - Node fs module (for launchd)
 * @param {object} [opts.os] - Node os module (for launchd)
 * @param {object} [opts.path] - Node path module (for launchd)
 */
export function resolveGatewayToken(opts) {
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

/**
 * Ensure gateway config structure exists.
 * Mutates config in place and returns it.
 */
export function ensureGatewayFields(config, token) {
  if (!config.gateway) config.gateway = {};
  if (!config.gateway.controlUi) config.gateway.controlUi = {};
  if (!config.gateway.auth) config.gateway.auth = {};
  if (!config.gateway.mode) config.gateway.mode = 'local';
  config.gateway.controlUi.allowInsecureAuth = true;
  config.gateway.auth.token = token;
  return config;
}

/**
 * Load LICENSE.txt from candidate paths.
 * @param {object} fs - Node fs module
 * @param {string[]} candidates - Paths to check
 * @returns {string|null}
 */
export function loadLicenseText(fs, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) {
        return fs.readFileSync(candidates[i], 'utf8');
      }
    } catch { /* ignore */ }
  }
  return null;
}
