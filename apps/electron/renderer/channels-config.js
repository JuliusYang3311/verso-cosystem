// Channels configuration, pairing, and status management

// Channel metadata - config fields per channel type
const CHANNEL_CONFIG_FIELDS = {
  telegram: {
    label: 'Telegram',
    description: 'Telegram Bot API - register a bot with @BotFather',
    fields: [
      { key: 'botToken', label: 'Bot Token', type: 'password', placeholder: '123456:ABC-DEF...', required: true, help: 'Get from @BotFather on Telegram' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox' },
      { key: 'dmPolicy', label: 'DM Policy', type: 'select', options: [
        { value: 'pairing', label: 'Pairing (default - users must pair first)' },
        { value: 'allowlist', label: 'Allowlist (only allowFrom users)' },
        { value: 'open', label: 'Open (anyone can DM)' },
        { value: 'disabled', label: 'Disabled (no DMs)' },
      ], help: 'Controls who can send DMs to the bot' },
      { key: 'groupPolicy', label: 'Group Policy', type: 'select', options: [
        { value: 'allowlist', label: 'Allowlist (default - only allowed groups)' },
        { value: 'open', label: 'Open (respond in all groups)' },
        { value: 'disabled', label: 'Disabled (ignore groups)' },
      ], help: 'Controls which groups the bot responds in' },
      { key: 'allowFrom', label: 'Allow From (user IDs/usernames)', type: 'text', placeholder: '123456789, @username, *', help: 'Comma-separated list of Telegram user IDs or @usernames. Use * to allow all.' },
      { key: 'webhookUrl', label: 'Webhook URL (optional)', type: 'text', placeholder: 'https://yourdomain.com/telegram/webhook', help: 'Leave empty for polling mode' },
      { key: 'webhookSecret', label: 'Webhook Secret (required if URL set)', type: 'password', placeholder: 'Random secret string', help: 'Required when using webhook mode. Use a random string.' },
    ],
    pairing: 'token',
    pairingHelp: 'To set up Telegram:\n1. Open Telegram and find @BotFather\n2. Send /newbot and follow the steps\n3. Copy the bot token and paste it above\n4. Set DM Policy and Allow From as needed\n5. Save and the gateway will connect automatically',
  },
  whatsapp: {
    label: 'WhatsApp',
    description: 'WhatsApp Web QR link - scan to pair',
    fields: [
      { key: 'dmPolicy', label: 'DM Policy', type: 'select', options: [
        { value: 'pairing', label: 'Pairing (default - users must pair first)' },
        { value: 'allowlist', label: 'Allowlist (only allowFrom users)' },
        { value: 'open', label: 'Open (anyone can DM)' },
        { value: 'disabled', label: 'Disabled (no DMs)' },
      ], help: 'Controls who can send DMs' },
      { key: 'allowFrom', label: 'Allow From', type: 'text', placeholder: '8613800138000, *', help: 'Comma-separated phone numbers (with country code). Use * to allow all.' },
      { key: 'selfChatMode', label: 'Self-Chat Mode', type: 'checkbox', help: 'Enable if bot uses your personal WhatsApp number' },
      { key: 'debounceMs', label: 'Debounce (ms)', type: 'number', placeholder: '1500' },
    ],
    pairing: 'qr',
    pairingHelp: 'To pair WhatsApp:\n1. Click "Start QR Pairing" below\n2. Open WhatsApp on your phone\n3. Go to Settings → Linked Devices → Link a Device\n4. Scan the QR code shown here',
  },
  discord: {
    label: 'Discord',
    description: 'Discord Bot API - create an application at discord.com/developers',
    fields: [
      { key: 'token', label: 'Bot Token', type: 'password', placeholder: 'MTIzNDU2Nzg5...', required: true, help: 'From Discord Developer Portal → Bot → Token' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox' },
    ],
    // Discord allowFrom lives in dm.allowFrom, handled specially in saveChannelConfig
    dmFields: [
      { key: 'allowFrom', label: 'Allow From (DM user IDs)', type: 'text', placeholder: '123456789012345678, *', help: 'Comma-separated Discord user IDs. Use * to allow all.' },
    ],
    pairing: 'token',
    pairingHelp: 'To set up Discord:\n1. Go to discord.com/developers/applications\n2. Create a New Application\n3. Go to Bot section, click Reset Token\n4. Copy the token and paste it above\n5. Enable the bot: Go to OAuth2 → URL Generator\n6. Select bot scope, then add permissions\n7. Use the generated URL to invite the bot to your server',
  },
  slack: {
    label: 'Slack',
    description: 'Slack Bot - requires Socket Mode app',
    fields: [
      { key: 'botToken', label: 'Bot Token (xoxb-...)', type: 'password', placeholder: 'xoxb-...', required: true, help: 'OAuth Bot Token from api.slack.com' },
      { key: 'appToken', label: 'App Token (xapp-...)', type: 'password', placeholder: 'xapp-...', required: true, help: 'Socket Mode App-Level Token' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox' },
    ],
    // Slack allowFrom lives in dm.allowFrom, handled specially in saveChannelConfig
    dmFields: [
      { key: 'allowFrom', label: 'Allow From (Slack user IDs)', type: 'text', placeholder: 'U01ABC123, *', help: 'Comma-separated Slack user IDs. Use * to allow all.' },
    ],
    pairing: 'token',
    pairingHelp: 'To set up Slack:\n1. Go to api.slack.com/apps and create a new app\n2. Enable Socket Mode and generate an app-level token (xapp-...)\n3. Go to OAuth & Permissions, install the app, copy the Bot Token (xoxb-...)\n4. Paste both tokens above\n5. Add required bot scopes: chat:write, channels:read, channels:history, etc.',
  },
};

// Open channel config/pairing modal from the Channels status page
window.configureChannel = async function(channelName) {
  // Remove any existing modal
  closeChannelConfigModal();

  const meta = CHANNEL_CONFIG_FIELDS[channelName];
  const modal = document.createElement('div');
  modal.id = 'channel-config-modal';
  modal.className = 'modal active';

  try {
    const config = await window.verso.getConfig();
    const channelConfig = config?.channels?.[channelName] || {};

    // Get channel status (with timeout to avoid blocking UI)
    let channelStatus = [];
    try {
      const statusResult = await Promise.race([
        window.gatewayClient.getChannelsStatus({ probe: false }),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000))
      ]);
      const ch = statusResult?.channels?.[channelName];
      channelStatus = Array.isArray(ch) ? ch : (ch ? [ch] : []);
    } catch { channelStatus = []; }

    const title = meta?.label || channelName;
    const description = meta?.description || '';

    modal.innerHTML = `
      <div class="modal-content" style="max-width:600px;">
        <div class="modal-header">
          <div>
            <div class="modal-title">Configure ${escapeHtml(title)}</div>
            <div style="font-size:12px;color:#888;margin-top:2px;">${escapeHtml(description)}</div>
          </div>
          <button class="modal-close" onclick="closeChannelConfigModal()">&times;</button>
        </div>

        <!-- Status -->
        <div style="margin-bottom:20px;">
          <h4 style="margin-bottom:8px;">Connection Status</h4>
          <div id="channel-status-display">
            ${renderChannelStatusSection(channelName, channelStatus)}
          </div>
        </div>

        <!-- Config Fields -->
        ${meta ? `
          <div style="margin-bottom:20px;">
            <h4 style="margin-bottom:12px;">Configuration</h4>
            ${renderChannelConfigFields(channelName, meta, channelConfig)}
          </div>
        ` : `
          <div style="margin-bottom:20px;">
            <h4 style="margin-bottom:12px;">Configuration (JSON)</h4>
            <textarea id="channel-raw-config" class="config-editor" rows="8">${escapeHtml(JSON.stringify(channelConfig, null, 2))}</textarea>
          </div>
        `}

        <!-- Pairing Section -->
        ${meta?.pairing === 'qr' ? `
          <div style="margin-bottom:20px;">
            <h4 style="margin-bottom:8px;">WhatsApp Pairing</h4>
            <p style="color:#888;font-size:12px;margin-bottom:12px;white-space:pre-line;">${escapeHtml(meta.pairingHelp)}</p>
            <button class="btn" id="wa-pair-btn" onclick="startWhatsAppPairing()">Start QR Pairing</button>
            <div id="whatsapp-qr-container" style="margin-top:12px;"></div>
          </div>
        ` : ''}

        ${meta?.pairing === 'token' && meta.pairingHelp ? `
          <div style="margin-bottom:16px;background:#1a1a1a;padding:12px;border-radius:6px;">
            <h4 style="margin-bottom:6px;font-size:13px;">Setup Guide</h4>
            <pre style="color:#aaa;font-size:11px;white-space:pre-wrap;margin:0;">${escapeHtml(meta.pairingHelp)}</pre>
          </div>
        ` : ''}

        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="closeChannelConfigModal()">Cancel</button>
          <button class="btn" onclick="saveChannelConfig('${escapeHtml(channelName)}')">Save & Apply</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  } catch (err) {
    console.error('Failed to load channel config:', err);
    showNotification('Failed to load channel config: ' + err.message, 'error');
  }
}

function renderChannelStatusSection(channelName, accounts) {
  if (!accounts || accounts.length === 0) {
    return '<div style="color:#888;font-size:13px;padding:8px;background:#1a1a1a;border-radius:6px;">Not connected</div>';
  }

  return accounts.map((acc, i) => {
    const connected = acc.connected || acc.status === 'connected';
    const statusColor = connected ? '#4caf50' : (acc.error ? '#f44336' : '#888');
    const statusText = connected ? 'Connected' : (acc.status || 'Disconnected');
    const accId = acc.accountId || acc.id || `Account ${i + 1}`;

    return `
      <div style="background:#1a1a1a;padding:10px 12px;border-radius:6px;margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="status-dot ${connected ? 'green' : 'gray'}"></span>
              <span style="font-weight:500;">${escapeHtml(acc.displayName || accId)}</span>
            </div>
            <div style="color:${statusColor};font-size:12px;margin-top:2px;">${escapeHtml(statusText)}</div>
            ${acc.error ? `<div style="color:#f44336;font-size:11px;margin-top:2px;">${escapeHtml(acc.error)}</div>` : ''}
            ${acc.mode ? `<div style="color:#666;font-size:11px;">Mode: ${escapeHtml(acc.mode)}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;">
            ${connected ? `<button class="btn btn-small btn-secondary" onclick="logoutChannelAccount('${escapeHtml(channelName)}','${escapeHtml(accId)}')">Disconnect</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderChannelConfigFields(channelName, meta, channelConfig) {
  let html = meta.fields.map(field => renderChannelField(channelName, field, channelConfig[field.key])).join('');

  // Render dm sub-fields (e.g. Discord/Slack dm.allowFrom)
  if (meta.dmFields) {
    html += '<h5 style="margin:12px 0 8px;color:#aaa;">DM Settings</h5>';
    const dmConfig = channelConfig.dm || {};
    html += meta.dmFields.map(field => renderChannelField(channelName, { ...field, key: `dm.${field.key}` }, dmConfig[field.key])).join('');
  }

  return html;
}

function renderChannelField(channelName, field, value) {
    const id = `channel-${channelName}-${field.key.replace('.', '-')}`;

    if (field.type === 'checkbox') {
      return `
        <div class="form-group">
          <label class="checkbox-label">
            <span>${escapeHtml(field.label)}</span>
            <input type="checkbox" id="${id}" data-channel="${channelName}" data-key="${field.key}"
              ${value !== false && value !== undefined ? 'checked' : ''}>
          </label>
          ${field.help ? `<div class="hint">${escapeHtml(field.help)}</div>` : ''}
        </div>
      `;
    }

    if (field.type === 'select') {
      return `
        <div class="form-group">
          <label>${escapeHtml(field.label)}</label>
          <select id="${id}" data-channel="${channelName}" data-key="${field.key}">
            ${(field.options || []).map(opt =>
              `<option value="${escapeHtml(opt.value)}" ${value === opt.value ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`
            ).join('')}
          </select>
          ${field.help ? `<div class="hint">${escapeHtml(field.help)}</div>` : ''}
        </div>
      `;
    }

    // For allowFrom, convert array to comma-separated string for display
    if (field.key.endsWith('allowFrom') && Array.isArray(value)) {
      value = value.join(', ');
    }

    return `
      <div class="form-group">
        <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}</label>
        <input type="${field.type || 'text'}" id="${id}" data-channel="${channelName}" data-key="${field.key}"
          value="${escapeHtml(value != null ? String(value) : '')}"
          placeholder="${escapeHtml(field.placeholder || '')}">
        ${field.help ? `<div class="hint">${escapeHtml(field.help)}</div>` : ''}
      </div>
    `;
}

window.closeChannelConfigModal = function() {
  const modal = document.getElementById('channel-config-modal');
  if (modal) modal.remove();
}

function saveChannelField(target, channelName, field, targetKey) {
  const elId = `channel-${channelName}-${field.key.replace('.', '-')}`;
  const el = document.getElementById(elId);
  if (!el) return;
  const key = targetKey || field.key;

  if (field.type === 'checkbox') {
    target[key] = el.checked;
  } else if (field.type === 'number') {
    const val = el.value.trim();
    if (val) target[key] = parseInt(val);
  } else if (key === 'allowFrom') {
    const val = el.value.trim();
    if (val) {
      // Keep as strings — works for all channel schemas
      // (Telegram/Discord accept string|number, WhatsApp requires string only)
      target[key] = val.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      delete target[key];
    }
  } else {
    const val = el.value.trim();
    if (val) {
      target[key] = val;
    }
  }
}

window.saveChannelConfig = async function(channelName) {
  try {
    const config = await window.verso.getConfig();
    if (!config.channels) config.channels = {};
    if (!config.channels[channelName]) config.channels[channelName] = {};

    const meta = CHANNEL_CONFIG_FIELDS[channelName];

    if (meta) {
      // Collect values from top-level form fields
      for (const field of meta.fields) {
        saveChannelField(config.channels[channelName], channelName, field);
      }

      // Collect dm sub-fields (Discord/Slack use dm.allowFrom instead of top-level allowFrom)
      if (meta.dmFields) {
        if (!config.channels[channelName].dm) config.channels[channelName].dm = {};
        for (const field of meta.dmFields) {
          saveChannelField(config.channels[channelName].dm, channelName, { ...field, key: `dm.${field.key}` }, field.key);
        }
      }
    } else {
      // Raw JSON config
      const rawEl = document.getElementById('channel-raw-config');
      if (rawEl) {
        try {
          config.channels[channelName] = JSON.parse(rawEl.value);
        } catch {
          showNotification('Invalid JSON config', 'error');
          return;
        }
      }
    }

    await window.verso.saveConfig(config);
    showNotification('Channel config saved');
    closeChannelConfigModal();

    // Apply config via gateway RPC (triggers reload without full restart)
    try {
      const raw = JSON.stringify(config, null, 2);
      await window.gatewayClient.setGatewayConfig({ raw });
    } catch {
      // Fallback: restart gateway
      try { await window.verso.restartGateway(); } catch { /* ignore */ }
    }

    // Refresh channels display
    setTimeout(() => {
      if (window.loadChannels) loadChannels();
    }, 3000);
  } catch (err) {
    console.error('Failed to save channel config:', err);
    showNotification('Failed to save: ' + err.message, 'error');
  }
}

// ==================== WhatsApp QR Pairing ====================

window.startWhatsAppPairing = async function(accountId) {
  const container = document.getElementById('whatsapp-qr-container');
  const btn = document.getElementById('wa-pair-btn');
  if (!container) return;

  container.innerHTML = '<div style="color:#888;padding:12px;">Generating QR code...</div>';
  if (btn) btn.disabled = true;

  try {
    // Call web.login.start to get QR code
    const result = await window.gatewayClient.call('web.login.start', {
      accountId: accountId || undefined,
      timeoutMs: 45000,
    });

    const qrDataUrl = result?.qrDataUrl || result?.qr;
    const message = result?.message || '';

    if (qrDataUrl) {
      container.innerHTML = `
        <div style="text-align:center;">
          <div style="background:white;padding:16px;border-radius:8px;display:inline-block;">
            <img src="${qrDataUrl}" style="width:256px;height:256px;image-rendering:pixelated;" alt="WhatsApp QR Code">
          </div>
          <div style="color:#888;font-size:12px;margin-top:8px;">Scan this QR code with WhatsApp on your phone</div>
          <div style="color:#666;font-size:11px;margin-top:4px;">Settings → Linked Devices → Link a Device</div>
          <div id="wa-pair-status" style="margin-top:12px;color:#888;font-size:13px;">Waiting for scan...</div>
        </div>
      `;

      // Now wait for the scan
      waitForWhatsAppPairing(accountId);
    } else {
      container.innerHTML = `
        <div style="color:#ff9800;padding:12px;">
          ${escapeHtml(message || 'Could not generate QR code. The WhatsApp service may not be ready.')}
        </div>
        <button class="btn btn-small" onclick="startWhatsAppPairing()" style="margin-top:8px;">Retry</button>
      `;
    }
  } catch (err) {
    console.error('WhatsApp pairing error:', err);
    container.innerHTML = `
      <div style="color:#f44336;padding:12px;">Error: ${escapeHtml(err.message)}</div>
      <button class="btn btn-small" onclick="startWhatsAppPairing()" style="margin-top:8px;">Retry</button>
    `;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function waitForWhatsAppPairing(accountId) {
  const statusEl = document.getElementById('wa-pair-status');

  try {
    const result = await window.gatewayClient.call('web.login.wait', {
      accountId: accountId || undefined,
      timeoutMs: 120000,
    });

    if (result?.connected) {
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:#4caf50;font-weight:600;">Paired successfully!</span>';
      }
      showNotification('WhatsApp paired successfully!');
      setTimeout(() => {
        closeChannelConfigModal();
        if (window.loadChannels) loadChannels();
      }, 2000);
    } else {
      if (statusEl) {
        statusEl.innerHTML = `
          <span style="color:#ff9800;">${escapeHtml(result?.message || 'Pairing timed out')}</span>
          <br><button class="btn btn-small" onclick="startWhatsAppPairing()" style="margin-top:8px;">Try Again</button>
        `;
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.innerHTML = `
        <span style="color:#f44336;">Error: ${escapeHtml(err.message)}</span>
        <br><button class="btn btn-small" onclick="startWhatsAppPairing()" style="margin-top:8px;">Try Again</button>
      `;
    }
  }
}

// ==================== Channel Account Management ====================

window.logoutChannelAccount = async function(channelName, accountId) {
  if (!confirm(`Disconnect ${channelName} account ${accountId}?`)) return;

  try {
    await window.gatewayClient.channelsLogout({ channel: channelName, accountId });
    showNotification(`Disconnected from ${channelName}`);

    // Refresh the status display in the modal
    try {
      const statusResult = await window.gatewayClient.getChannelsStatus({ probe: false });
      const ch = statusResult?.channels?.[channelName];
      const accounts = Array.isArray(ch) ? ch : (ch ? [ch] : []);
      const statusDisplay = document.getElementById('channel-status-display');
      if (statusDisplay) {
        statusDisplay.innerHTML = renderChannelStatusSection(channelName, accounts);
      }
    } catch { /* ignore */ }

    if (window.loadChannels) loadChannels();
  } catch (err) {
    showNotification('Failed to disconnect: ' + err.message, 'error');
  }
}

// ==================== Channels Status Section - "Configure" button handler ====================
// This is called from dashboard.js loadChannels() when clicking "Configure" on a channel card
// It's already wired via `onclick="configureChannel('channelName')"` in the channel cards
