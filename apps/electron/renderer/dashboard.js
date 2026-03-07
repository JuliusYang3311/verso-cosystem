// Dashboard functions for all sections

// ==================== HELPERS ====================

function formatUptime(seconds) {
  if (!seconds || seconds < 0) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatNumber(num) {
  if (num == null) return '0';
  return Number(num).toLocaleString();
}

function formatCost(cost) {
  if (cost == null || cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatDate(ts) {
  if (!ts) return 'N/A';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return d.toLocaleString();
}

function relativeTime(ts) {
  if (!ts) return '';
  const now = Date.now();
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const diff = now - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isChatNearBottom() {
  const el = document.getElementById('chat-messages');
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollChatToBottom(force = false) {
  if (!force && !isChatNearBottom()) return;
  const el = document.getElementById('chat-messages');
  if (!el) return;
  const last = el.lastElementChild;
  if (last) last.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function showNotification(message, type = 'success') {
  const el = document.createElement('div');
  el.className = 'notification';
  el.textContent = message;
  el.style.background = type === 'error' ? '#d32f2f' : type === 'warning' ? '#ff9800' : '#4caf50';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
window.showNotification = showNotification;

// ==================== OVERVIEW ====================

async function loadOverview() {
  try {
    const [healthResult, sessionsResult] = await Promise.all([
      window.gatewayClient.getHealth({ probe: false }).catch(() => null),
      window.gatewayClient.listSessions().catch(() => null),
    ]);

    const sessions = sessionsResult?.sessions || [];
    const channels = healthResult?.channels || {};
    const connectedChannels = Object.values(channels).filter(ch => {
      if (Array.isArray(ch)) return ch.some(a => a.connected);
      return ch?.connected;
    }).length;

    document.getElementById('overview-status').textContent = healthResult ? 'Running' : 'Unknown';
    document.getElementById('overview-status').style.color = healthResult ? '#4caf50' : '#888';
    document.getElementById('overview-sessions').textContent = sessions.length;
    document.getElementById('overview-channels').textContent = connectedChannels;

    // Agents
    try {
      const agentsResult = await window.gatewayClient.listAgents();
      const agents = agentsResult?.agents || [];
      const agentsDiv = document.getElementById('overview-agents');
      if (agents.length === 0) {
        agentsDiv.innerHTML = '<div style="color:#888;font-size:13px;">No agents configured</div>';
      } else {
        agentsDiv.innerHTML = agents.map(a => `
          <div class="list-item">
            <div class="list-item-content">
              <div class="list-item-title">${escapeHtml(a.name || a.id)}</div>
              <div class="list-item-meta">${escapeHtml(a.id)} &middot; ${escapeHtml(a.workspace || 'no workspace')}</div>
            </div>
          </div>
        `).join('');
      }
    } catch { document.getElementById('overview-agents').innerHTML = '<div style="color:#888;font-size:13px;">Could not load agents</div>'; }

    // Presence / devices
    try {
      const presenceResult = await window.gatewayClient.getPresence();
      const presence = presenceResult?.entries || presenceResult?.presence || [];
      document.getElementById('overview-devices').textContent = Array.isArray(presence) ? presence.length : 0;

      const activityDiv = document.getElementById('overview-activity');
      if (Array.isArray(presence) && presence.length > 0) {
        activityDiv.innerHTML = presence.slice(0, 5).map(p => `
          <div class="list-item">
            <div class="list-item-content">
              <div class="list-item-title">${escapeHtml(p.displayName || p.host || p.deviceId || 'Unknown')}</div>
              <div class="list-item-meta">${escapeHtml(p.mode || '')} &middot; ${escapeHtml(p.platform || '')}${p.lastInputSeconds != null ? ` &middot; Last input: ${p.lastInputSeconds}s ago` : ''}</div>
            </div>
            <div class="status-dot ${p.connected !== false ? 'green' : 'gray'}"></div>
          </div>
        `).join('');
      } else {
        activityDiv.innerHTML = '<div style="color:#888;font-size:13px;">No recent activity</div>';
      }
    } catch {
      document.getElementById('overview-devices').textContent = '0';
      document.getElementById('overview-activity').innerHTML = '<div style="color:#888;font-size:13px;">Could not load presence</div>';
    }
  } catch (err) {
    console.error('Failed to load overview:', err);
    document.getElementById('overview-status').textContent = 'Error';
    document.getElementById('overview-status').style.color = '#f44336';
  }
}

// ==================== CHAT ====================

function getChatSession() {
  return document.getElementById('chat-session-select')?.value || 'agent:main:main';
}
let chatRunId = null;
let chatStreamingEl = null;
let chatSafetyTimer = null;

async function loadChatSessions() {
  try {
    const result = await window.gatewayClient.listSessions();
    const sessions = result?.sessions || [];
    const select = document.getElementById('chat-session-select');
    const current = select.value;
    select.innerHTML = '';

    // Always include default
    const keys = new Set(['agent:main:main']);
    sessions.forEach(s => { if (s.key) keys.add(s.key); });

    for (const key of keys) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = key;
      if (key === current) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error('Failed to load chat sessions:', err);
  }
}

async function loadChatHistory() {
  const messagesDiv = document.getElementById('chat-messages');
  messagesDiv.innerHTML = '<div class="chat-empty">Loading...</div>';

  try {
    const result = await window.gatewayClient.chatHistory({ sessionKey: getChatSession(), limit: 100 });
    const messages = result?.messages || [];

    if (messages.length === 0) {
      messagesDiv.innerHTML = '<div class="chat-empty">No messages yet. Start chatting!</div>';
      return;
    }

    messagesDiv.innerHTML = '';
    for (const msg of messages) {
      appendChatMessage(msg.role || 'system', msg.content || '', false);
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  } catch (err) {
    console.error('Failed to load chat history:', err);
    messagesDiv.innerHTML = '<div class="chat-empty">Could not load history</div>';
  }
}

// Extract displayable text from any message content format.
// Mirrors the content handling in chat-sanitize.ts:
//   - string → direct text
//   - Array<{type:"text",text}> → Anthropic / OpenAI multimodal content blocks
//   - {text: string} → Google parts or legacy format
//   - {parts: [{text}]} → Google Gemini format
//   - nested content/message wrappers
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object') return '';
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'thinking') return '';
        if (block.type === 'tool_use') return `[Tool: ${block.name || 'unknown'}]`;
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string') return block.content;
          if (Array.isArray(block.content)) return extractTextContent(block.content);
          return '';
        }
        // Google part: {text: "..."}
        if (typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (content.type === 'text' && typeof content.text === 'string') return content.text;
    if (typeof content.text === 'string') return content.text;
    // Google: {parts: [{text: "..."}]}
    if (Array.isArray(content.parts)) return extractTextContent(content.parts);
    // Nested wrappers
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return extractTextContent(content.content);
    return JSON.stringify(content);
  }
  return String(content || '');
}

function appendChatMessage(role, content, scroll = true) {
  const messagesDiv = document.getElementById('chat-messages');
  // Remove empty placeholder
  const empty = messagesDiv.querySelector('.chat-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  const roleClass = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system';
  el.className = `chat-msg ${roleClass}`;

  // Extract text from structured content (Anthropic content blocks, etc.)
  const textContent = extractTextContent(content);

  // Simple markdown-like rendering
  let html = escapeHtml(textContent);
  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code style="background:#111;padding:2px 4px;border-radius:3px;">$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');

  const avatarHtml = roleClass === 'assistant'
    ? '<img src="../assets/icon.png" class="msg-avatar" alt="V">'
    : '';
  el.innerHTML = `<div class="msg-header">${avatarHtml}<span class="msg-role">${roleClass === 'assistant' ? 'Verso' : roleClass}</span></div>${html}`;
  messagesDiv.appendChild(el);
  if (scroll) scrollChatToBottom(true);
  return el;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  input.style.height = 'auto';
  appendChatMessage('user', message);

  const abortBtn = document.getElementById('chat-abort-btn');
  const sendBtn = document.getElementById('chat-send-btn');
  abortBtn.style.display = 'inline-block';
  sendBtn.disabled = true;

  // Create streaming placeholder
  chatStreamingEl = appendChatMessage('assistant', 'Thinking...');
  chatStreamingEl.classList.add('chat-streaming');
  requestAnimationFrame(() => scrollChatToBottom(true));

  try {
    const result = await window.gatewayClient.chatSend({
      sessionKey: getChatSession(),
      message,
      idempotencyKey: `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
    });
    chatRunId = result?.runId;
    // UI updates are driven by gateway chat events (delta/final).
    // Safety timeout prevents UI from being stuck forever if agent never responds.
    if (chatSafetyTimer) clearTimeout(chatSafetyTimer);
    chatSafetyTimer = setTimeout(async () => {
      chatSafetyTimer = null;
      if (chatStreamingEl) {
        chatStreamingEl.remove();
        chatStreamingEl = null;
      }
      await loadChatHistory();
      abortBtn.style.display = 'none';
      sendBtn.disabled = false;
    }, 120000);
  } catch (err) {
    console.error('Failed to send chat:', err);
    if (chatStreamingEl) {
      chatStreamingEl.innerHTML = `<div class="msg-role">assistant</div>Error: ${escapeHtml(err.message)}`;
      chatStreamingEl.classList.remove('chat-streaming');
      chatStreamingEl = null;
    }
    abortBtn.style.display = 'none';
    sendBtn.disabled = false;
  }
}
window.sendChatMessage = sendChatMessage;

async function abortChat() {
  try {
    await window.gatewayClient.chatAbort({ sessionKey: getChatSession(), runId: chatRunId });
    showNotification('Chat aborted');
  } catch (err) {
    showNotification('Failed to abort: ' + err.message, 'error');
  }
  document.getElementById('chat-abort-btn').style.display = 'none';
  document.getElementById('chat-send-btn').disabled = false;
  if (chatStreamingEl) {
    chatStreamingEl.remove();
    chatStreamingEl = null;
  }
}

// Listen for chat events (streaming)
window.addEventListener('gateway-event', (e) => {
  const { event, data } = e.detail || {};
  if (event === 'chat' && data) {
    if (data.sessionKey && data.sessionKey !== getChatSession()) return;
    if (data.delta && chatStreamingEl) {
      const current = chatStreamingEl.querySelector('.msg-role')?.nextSibling?.textContent || '';
      if (current === 'Thinking...') {
        chatStreamingEl.innerHTML = `<div class="msg-role">assistant</div>${escapeHtml(data.delta)}`;
      } else {
        chatStreamingEl.innerHTML += escapeHtml(data.delta);
      }
      scrollChatToBottom();
    }
    // Handle delta streaming — update the streaming bubble with partial text
    if (data.state === 'delta' && data.message && chatStreamingEl) {
      const deltaText = extractTextContent(data.message.content || data.message);
      if (deltaText) {
        chatStreamingEl.innerHTML = `<div class="msg-header"><img src="../assets/icon.png" class="msg-avatar" alt="V"><span class="msg-role">Verso</span></div>${escapeHtml(deltaText).replace(/\n/g, '<br>')}`;
        scrollChatToBottom();
      }
    }

    if (data.state === 'final' || data.status === 'done') {
      const finalText = data.message ? extractTextContent(data.message.content || data.message) : '';
      // Ignore empty finals from async dispatch — agent hasn't responded yet
      if (!finalText && chatStreamingEl) return;

      if (chatSafetyTimer) { clearTimeout(chatSafetyTimer); chatSafetyTimer = null; }
      if (chatStreamingEl) {
        if (finalText) {
          chatStreamingEl.innerHTML = `<div class="msg-header"><img src="../assets/icon.png" class="msg-avatar" alt="V"><span class="msg-role">Verso</span></div>${escapeHtml(finalText).replace(/\n/g, '<br>')}`;
        }
        chatStreamingEl.classList.remove('chat-streaming');
        chatStreamingEl = null;
      }
      document.getElementById('chat-abort-btn').style.display = 'none';
      document.getElementById('chat-send-btn').disabled = false;
      scrollChatToBottom();
      setTimeout(() => loadChatHistory(), 500);
    }
  }
});

// ==================== SESSIONS ====================

async function loadSessions() {
  try {
    const result = await window.gatewayClient.listSessions();
    const sessions = result?.sessions || [];
    const listDiv = document.getElementById('sessions-list');

    if (sessions.length === 0) {
      listDiv.innerHTML = '<div style="color:#888;padding:16px;">No sessions</div>';
      return;
    }

    listDiv.innerHTML = sessions.map(s => `
      <div class="list-item">
        <div class="list-item-content">
          <div class="list-item-title">${escapeHtml(s.key || s.sessionKey || 'Unknown')}</div>
          <div class="list-item-meta">
            Agent: ${escapeHtml(s.agentId || 'N/A')} &middot;
            Model: ${escapeHtml(s.model || 'N/A')} &middot;
            Messages: ${s.messageCount || 0}
            ${s.label ? ` &middot; ${escapeHtml(s.label)}` : ''}
            ${s.updatedAt ? ` &middot; ${relativeTime(s.updatedAt)}` : ''}
          </div>
        </div>
        <div class="list-item-actions">
          <button class="btn btn-small btn-secondary" onclick="viewSession('${escapeHtml(s.key || s.sessionKey)}')">View</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load sessions:', err);
    document.getElementById('sessions-list').innerHTML = '<div style="color:#f44336;padding:16px;">Failed to load sessions</div>';
  }
}

let currentSessionKey = null;

window.viewSession = async function(sessionKey) {
  currentSessionKey = sessionKey;
  document.getElementById('sessions-list-card').style.display = 'none';
  document.getElementById('session-detail-card').style.display = 'block';
  document.getElementById('session-detail-title').textContent = sessionKey;

  const infoDiv = document.getElementById('session-detail-info');
  const msgsDiv = document.getElementById('session-detail-messages');
  infoDiv.innerHTML = 'Loading...';
  msgsDiv.innerHTML = '';

  try {
    // Load session preview
    const preview = await window.gatewayClient.previewSessions({ keys: [sessionKey], limit: 50 });
    const p = preview?.previews?.[0];

    infoDiv.innerHTML = `
      <div><strong>Key:</strong> ${escapeHtml(sessionKey)}</div>
      <div><strong>Status:</strong> ${escapeHtml(p?.status || 'unknown')}</div>
    `;

    // Load chat history
    try {
      const history = await window.gatewayClient.chatHistory({ sessionKey, limit: 100 });
      const messages = history?.messages || [];

      if (messages.length === 0) {
        msgsDiv.innerHTML = '<div style="color:#888;font-size:13px;">No messages in this session</div>';
      } else {
        msgsDiv.innerHTML = messages.map(msg => {
          const role = msg.role || 'system';
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
          return `
            <div style="padding:8px 12px;margin-bottom:6px;background:${role === 'user' ? '#0a3d6e' : '#2a2a2a'};border-radius:6px;">
              <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:3px;">${escapeHtml(role)}</div>
              <div style="font-size:13px;white-space:pre-wrap;">${escapeHtml(truncate(content, 500))}</div>
            </div>
          `;
        }).join('');
      }
    } catch {
      msgsDiv.innerHTML = '<div style="color:#888;font-size:13px;">Could not load message history</div>';
    }
  } catch (err) {
    infoDiv.innerHTML = `<div style="color:#f44336;">Error: ${escapeHtml(err.message)}</div>`;
  }
}

window.sessionBack = function() {
  document.getElementById('sessions-list-card').style.display = 'block';
  document.getElementById('session-detail-card').style.display = 'none';
  currentSessionKey = null;
  loadSessions();
}

window.resetSession = async function() {
  if (!currentSessionKey || !confirm(`Reset session ${currentSessionKey}? This clears the message history.`)) return;
  try {
    await window.gatewayClient.resetSession({ key: currentSessionKey });
    showNotification('Session reset');
    viewSession(currentSessionKey);
  } catch (err) {
    showNotification('Failed to reset: ' + err.message, 'error');
  }
}

window.compactSession = async function() {
  if (!currentSessionKey) return;
  try {
    const result = await window.gatewayClient.compactSession({ key: currentSessionKey });
    showNotification(result?.compacted ? 'Session compacted' : 'Nothing to compact');
    viewSession(currentSessionKey);
  } catch (err) {
    showNotification('Failed to compact: ' + err.message, 'error');
  }
}

window.deleteSession = async function() {
  if (!currentSessionKey || !confirm(`Delete session ${currentSessionKey}?`)) return;
  try {
    await window.gatewayClient.deleteSession({ key: currentSessionKey, deleteTranscript: true });
    showNotification('Session deleted');
    sessionBack();
  } catch (err) {
    showNotification('Failed to delete: ' + err.message, 'error');
  }
}

// ==================== CHANNELS ====================

async function loadChannels() {
  try {
    const result = await window.gatewayClient.getChannelsStatus({ probe: false });
    const channels = result?.channels || {};
    const supportedChannels = new Set(['telegram', 'whatsapp', 'discord', 'slack', 'web']);
    const channelOrder = (result?.channelOrder || Object.keys(channels)).filter(ch => supportedChannels.has(ch));
    const channelLabels = result?.channelLabels || {};
    const listDiv = document.getElementById('channels-list');

    if (channelOrder.length === 0) {
      listDiv.innerHTML = '<div style="color:#888;padding:16px;">No channels configured</div>';
      return;
    }

    listDiv.innerHTML = channelOrder.map(name => {
      const channel = channels[name];
      if (!channel) return '';
      const label = channelLabels[name] || name;
      const accounts = Array.isArray(channel) ? channel : (channel.accounts || [channel]);
      const hasConnected = accounts.some(a => a.connected || a.status === 'connected');

      return `
        <div class="channel-card">
          <div class="channel-card-header">
            <div class="channel-card-title">
              <span class="status-dot ${hasConnected ? 'green' : 'gray'}"></span>
              ${escapeHtml(label)}
            </div>
            <span style="font-size:12px;color:#888;">${accounts.length} account${accounts.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="channel-accounts">
            ${accounts.map((acc, i) => {
              const accId = acc.accountId || acc.id || `#${i}`;
              const status = acc.connected ? 'Connected' : (acc.status || 'Disconnected');
              const statusColor = acc.connected ? '#4caf50' : (acc.error ? '#f44336' : '#888');
              return `
                <div class="channel-account">
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                      <div style="font-weight:500;">${escapeHtml(acc.displayName || accId)}</div>
                      <div style="color:${statusColor};font-size:12px;margin-top:2px;">${escapeHtml(status)}</div>
                      ${acc.error ? `<div style="color:#f44336;font-size:11px;margin-top:2px;">${escapeHtml(truncate(acc.error, 100))}</div>` : ''}
                      ${acc.mode ? `<div style="color:#888;font-size:11px;">Mode: ${escapeHtml(acc.mode)}</div>` : ''}
                    </div>
                    <div style="display:flex;gap:6px;">
                      ${acc.connected ? `<button class="btn btn-small btn-secondary" onclick="logoutChannel('${escapeHtml(name)}','${escapeHtml(accId)}')">Disconnect</button>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          <div style="margin-top:8px;">
            <button class="btn btn-small btn-secondary" onclick="configureChannel('${escapeHtml(name)}')">Configure & Pair</button>
          </div>
        </div>
      `;
    }).filter(Boolean).join('');
  } catch (err) {
    console.error('Failed to load channels:', err);
    document.getElementById('channels-list').innerHTML = '<div style="color:#f44336;padding:16px;">Failed to load channels</div>';
  }
}

window.logoutChannel = async function(channel, accountId) {
  if (!confirm(`Disconnect ${channel} account ${accountId}?`)) return;
  try {
    await window.gatewayClient.channelsLogout({ channel, accountId });
    showNotification(`Disconnected ${channel}`);
    loadChannels();
  } catch (err) {
    showNotification('Failed to disconnect: ' + err.message, 'error');
  }
}

// ==================== CRON JOBS ====================

async function loadCronJobs() {
  try {
    // Load status
    try {
      const status = await window.gatewayClient.getCronStatus();
      const statusBar = document.getElementById('cron-status-info');
      statusBar.innerHTML = `Service: ${status?.running !== false ? '<span style="color:#4caf50">Active</span>' : '<span style="color:#888">Inactive</span>'}${status?.nextWake ? ` &middot; Next wake: ${formatDate(status.nextWake)}` : ''}`;
    } catch { /* ignore */ }

    const result = await window.gatewayClient.listCronJobs({ includeDisabled: true });
    const jobs = result?.jobs || [];
    const listDiv = document.getElementById('cron-list');

    if (jobs.length === 0) {
      listDiv.innerHTML = '<div style="color:#888;padding:16px;">No cron jobs configured</div>';
      return;
    }

    listDiv.innerHTML = jobs.map(job => {
      const enabled = job.enabled !== false;
      return `
        <div class="list-item" style="opacity:${enabled ? 1 : 0.6};">
          <div class="list-item-content">
            <div class="list-item-title">${escapeHtml(job.label || job.name || job.id || 'Unnamed')}</div>
            <div class="list-item-meta">
              Schedule: ${escapeHtml(job.schedule || 'N/A')}
              ${job.timezone ? ` (${escapeHtml(job.timezone)})` : ''}
              &middot; ${enabled ? 'Enabled' : 'Disabled'}
              ${job.nextRun ? ` &middot; Next: ${formatDate(job.nextRun)}` : ''}
              ${job.lastRun ? ` &middot; Last: ${relativeTime(job.lastRun)}` : ''}
            </div>
            ${job.message ? `<div style="color:#aaa;font-size:12px;margin-top:4px;">${escapeHtml(truncate(job.message, 100))}</div>` : ''}
          </div>
          <div class="list-item-actions">
            <button class="btn btn-small btn-secondary" onclick="toggleCronJob('${escapeHtml(job.id)}', ${enabled})">${enabled ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-small btn-secondary" onclick="runCronJobNow('${escapeHtml(job.id)}')">Run Now</button>
            <button class="btn btn-small btn-secondary" onclick="viewCronRuns('${escapeHtml(job.id)}')">History</button>
            <button class="btn btn-small btn-danger" onclick="removeCronJob('${escapeHtml(job.id)}')">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load cron jobs:', err);
    document.getElementById('cron-list').innerHTML = '<div style="color:#f44336;padding:16px;">Failed to load cron jobs</div>';
  }
}

window.toggleCronJob = async function(jobId, currentlyEnabled) {
  try {
    await window.gatewayClient.updateCronJob({ id: jobId, patch: { enabled: !currentlyEnabled } });
    showNotification(currentlyEnabled ? 'Job disabled' : 'Job enabled');
    loadCronJobs();
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

window.runCronJobNow = async function(jobId) {
  try {
    await window.gatewayClient.runCronJob({ id: jobId, mode: 'force' });
    showNotification('Job triggered');
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

window.removeCronJob = async function(jobId) {
  if (!confirm('Delete this cron job?')) return;
  try {
    await window.gatewayClient.removeCronJob({ id: jobId });
    showNotification('Job deleted');
    loadCronJobs();
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

window.viewCronRuns = async function(jobId) {
  const modal = document.getElementById('cron-runs-modal');
  const content = document.getElementById('cron-runs-content');
  content.innerHTML = 'Loading...';
  modal.classList.add('active');

  try {
    const result = await window.gatewayClient.getCronRuns({ id: jobId, limit: 20 });
    const entries = result?.entries || [];

    if (entries.length === 0) {
      content.innerHTML = '<div style="color:#888;">No run history</div>';
      return;
    }

    content.innerHTML = entries.map(entry => `
      <div class="list-item">
        <div class="list-item-content">
          <div class="list-item-meta">
            ${formatDate(entry.ts || entry.startedAt)} &middot;
            <span style="color:${entry.ok !== false ? '#4caf50' : '#f44336'};">${entry.ok !== false ? 'Success' : 'Failed'}</span>
            ${entry.error ? ` &middot; ${escapeHtml(truncate(entry.error, 80))}` : ''}
            ${entry.durationMs ? ` &middot; ${entry.durationMs}ms` : ''}
          </div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    content.innerHTML = `<div style="color:#f44336;">Error: ${escapeHtml(err.message)}</div>`;
  }
}

window.closeCronRunsModal = function() {
  document.getElementById('cron-runs-modal').classList.remove('active');
}

// Cron add modal
window.showCronAddModal = function() {
  document.getElementById('cron-label').value = '';
  document.getElementById('cron-schedule').value = '';
  document.getElementById('cron-message').value = '';
  document.getElementById('cron-timezone').value = '';
  document.getElementById('cron-modal').classList.add('active');
}

window.closeCronModal = function() {
  document.getElementById('cron-modal').classList.remove('active');
}

window.saveCronJob = async function() {
  const label = document.getElementById('cron-label').value.trim();
  const schedule = document.getElementById('cron-schedule').value.trim();
  const message = document.getElementById('cron-message').value.trim();
  const timezone = document.getElementById('cron-timezone').value.trim();

  if (!schedule || !message) {
    showNotification('Schedule and message are required', 'error');
    return;
  }

  try {
    await window.gatewayClient.addCronJob({
      schedule,
      message,
      label: label || undefined,
      timezone: timezone || undefined,
      enabled: true,
    });
    showNotification('Cron job added');
    closeCronModal();
    loadCronJobs();
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

// ==================== ORCHESTRATION ====================

async function loadOrchestration() {
  try {
    const result = await window.gatewayClient.listOrchestrations({ limit: 50 });
    const orchestrations = result?.orchestrations || [];
    const listDiv = document.getElementById('orchestration-list');

    if (orchestrations.length === 0) {
      listDiv.innerHTML = '<div style="color:#888;padding:16px;">No orchestration tasks</div>';
      return;
    }

    const statusColors = {
      completed: '#4caf50', running: '#2196f3', failed: '#f44336',
      pending: '#ff9800', cancelled: '#888', planning: '#9c27b0',
      dispatching: '#00bcd4', fixing: '#ff5722', acceptance: '#8bc34a',
    };

    listDiv.innerHTML = orchestrations.map(orch => {
      const color = statusColors[orch.status] || '#888';
      const dotClass = orch.status === 'completed' ? 'green' : orch.status === 'running' || orch.status === 'dispatching' ? 'yellow' : orch.status === 'failed' ? 'red' : 'gray';
      return `
        <div class="list-item">
          <span class="status-dot ${dotClass}"></span>
          <div class="list-item-content">
            <div class="list-item-title">${escapeHtml(truncate(orch.userPrompt || 'Orchestration', 120))}</div>
            <div class="list-item-meta">
              <span style="color:${color};font-weight:600;">${escapeHtml(orch.status || 'unknown')}</span> &middot;
              Subtasks: ${orch.subtaskCount || 0} &middot;
              ${formatDate(orch.createdAtMs)}
            </div>
          </div>
          <div class="list-item-actions">
            <button class="btn btn-small btn-secondary" onclick="viewOrchestration('${escapeHtml(orch.id)}')">View</button>
            ${orch.status === 'running' || orch.status === 'pending' ? `<button class="btn btn-small btn-danger" onclick="abortOrchestration('${escapeHtml(orch.id)}')">Abort</button>` : ''}
            ${orch.status === 'failed' ? `<button class="btn btn-small btn-secondary" onclick="retryOrchestration('${escapeHtml(orch.id)}')">Retry</button>` : ''}
            <button class="btn btn-small btn-secondary" onclick="deleteOrchestration('${escapeHtml(orch.id)}')">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load orchestration:', err);
    document.getElementById('orchestration-list').innerHTML = '<div style="color:#f44336;padding:16px;">Failed to load orchestration</div>';
  }
}

window.viewOrchestration = async function(orchId) {
  const modal = document.getElementById('orch-modal');
  const content = document.getElementById('orch-detail-content');
  content.innerHTML = 'Loading...';
  modal.classList.add('active');

  try {
    const result = await window.gatewayClient.getOrchestration({ id: orchId });
    const orch = result?.orchestration;
    if (!orch) {
      content.innerHTML = '<div style="color:#888;">Orchestration not found</div>';
      return;
    }

    const subtasks = orch.plan?.subtasks || orch.subtasks || [];
    const statusColors = {
      completed: '#4caf50', running: '#2196f3', failed: '#f44336',
      pending: '#ff9800', cancelled: '#888', queued: '#9c27b0',
    };

    content.innerHTML = `
      <div style="margin-bottom:16px;">
        <div style="font-weight:600;margin-bottom:8px;">${escapeHtml(orch.userPrompt || 'No prompt')}</div>
        <div style="color:#888;font-size:12px;">
          Status: <span style="color:${statusColors[orch.status] || '#888'};font-weight:600;">${escapeHtml(orch.status)}</span> &middot;
          Created: ${formatDate(orch.createdAtMs)}
          ${orch.completedAtMs ? ` &middot; Completed: ${formatDate(orch.completedAtMs)}` : ''}
        </div>
      </div>
      <h3 style="margin-bottom:8px;">Subtasks (${subtasks.length})</h3>
      ${subtasks.length === 0 ? '<div style="color:#888;font-size:13px;">No subtasks</div>' :
        subtasks.map((task, i) => `
          <div class="orch-subtask">
            <span class="status-dot ${task.status === 'completed' ? 'green' : task.status === 'running' ? 'yellow' : task.status === 'failed' ? 'red' : 'gray'}"></span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;">${i + 1}. ${escapeHtml(task.description || task.title || 'No description')}</div>
              <div style="font-size:11px;color:#888;">${escapeHtml(task.status || 'pending')}${task.specialization ? ` &middot; ${escapeHtml(task.specialization)}` : ''}</div>
              ${task.error ? `<div style="font-size:11px;color:#f44336;margin-top:2px;">${escapeHtml(truncate(task.error, 100))}</div>` : ''}
              ${task.result ? `<div style="font-size:11px;color:#aaa;margin-top:2px;">${escapeHtml(truncate(typeof task.result === 'string' ? task.result : JSON.stringify(task.result), 150))}</div>` : ''}
            </div>
          </div>
        `).join('')}
    `;
  } catch (err) {
    content.innerHTML = `<div style="color:#f44336;">Error: ${escapeHtml(err.message)}</div>`;
  }
}

window.closeOrchModal = function() {
  document.getElementById('orch-modal').classList.remove('active');
}

window.abortOrchestration = async function(orchId) {
  if (!confirm('Abort this orchestration?')) return;
  try {
    await window.gatewayClient.abortOrchestration({ id: orchId });
    showNotification('Orchestration aborted');
    loadOrchestration();
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

window.retryOrchestration = async function(orchId) {
  try {
    await window.gatewayClient.retryOrchestration({ id: orchId });
    showNotification('Retry initiated');
    loadOrchestration();
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

window.deleteOrchestration = async function(orchId) {
  if (!confirm('Delete this orchestration?')) return;
  try {
    await window.gatewayClient.deleteOrchestration({ id: orchId });
    showNotification('Deleted');
    loadOrchestration();
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

// ==================== INSTANCES (Nodes, Devices, Presence) ====================

async function loadInstances() {
  // Nodes
  try {
    const result = await window.gatewayClient.listNodes();
    const nodes = result?.nodes || [];
    const nodesDiv = document.getElementById('nodes-list');

    if (nodes.length === 0) {
      nodesDiv.innerHTML = '<div style="color:#888;font-size:13px;">No nodes</div>';
    } else {
      nodesDiv.innerHTML = nodes.map(node => `
        <div class="list-item">
          <div class="list-item-content">
            <div class="list-item-title">${escapeHtml(node.displayName || node.nodeId)}</div>
            <div class="list-item-meta">
              ${escapeHtml(node.platform || '')} &middot;
              ${node.connected ? '<span style="color:#4caf50;">Connected</span>' : '<span style="color:#888;">Offline</span>'}
              ${node.version ? ` &middot; v${escapeHtml(node.version)}` : ''}
            </div>
          </div>
          <div class="status-dot ${node.connected ? 'green' : 'gray'}"></div>
        </div>
      `).join('');
    }
  } catch { document.getElementById('nodes-list').innerHTML = '<div style="color:#888;font-size:13px;">Could not load nodes</div>'; }

  // Device pairings
  try {
    const result = await window.gatewayClient.listDevicePairings();
    const requests = result?.requests || [];
    const devicesDiv = document.getElementById('devices-list');

    if (requests.length === 0) {
      devicesDiv.innerHTML = '<div style="color:#888;font-size:13px;">No pending device pairings</div>';
    } else {
      devicesDiv.innerHTML = requests.map(req => `
        <div class="list-item">
          <div class="list-item-content">
            <div class="list-item-title">${escapeHtml(req.displayName || req.deviceId || 'Unknown device')}</div>
            <div class="list-item-meta">${escapeHtml(req.platform || '')} &middot; ${escapeHtml(req.status || 'pending')}</div>
          </div>
          <div class="list-item-actions">
            ${req.status === 'pending' ? `
              <button class="btn btn-small" onclick="approveDevice('${escapeHtml(req.requestId)}')">Approve</button>
              <button class="btn btn-small btn-danger" onclick="rejectDevice('${escapeHtml(req.requestId)}')">Reject</button>
            ` : ''}
          </div>
        </div>
      `).join('');
    }
  } catch { document.getElementById('devices-list').innerHTML = '<div style="color:#888;font-size:13px;">Could not load devices</div>'; }

  // Presence
  try {
    const result = await window.gatewayClient.getPresence();
    const presence = result?.entries || result?.presence || [];
    const presenceDiv = document.getElementById('presence-list');

    if (!Array.isArray(presence) || presence.length === 0) {
      presenceDiv.innerHTML = '<div style="color:#888;font-size:13px;">No connected clients</div>';
    } else {
      presenceDiv.innerHTML = presence.map(p => `
        <div class="list-item">
          <div class="list-item-content">
            <div class="list-item-title">${escapeHtml(p.displayName || p.host || p.clientId || 'Unknown')}</div>
            <div class="list-item-meta">
              ${escapeHtml(p.mode || '')} &middot; ${escapeHtml(p.platform || '')}
              ${p.version ? ` &middot; v${escapeHtml(p.version)}` : ''}
              ${p.lastInputSeconds != null ? ` &middot; Last input: ${p.lastInputSeconds}s ago` : ''}
            </div>
          </div>
          <div class="status-dot green"></div>
        </div>
      `).join('');
    }
  } catch { document.getElementById('presence-list').innerHTML = '<div style="color:#888;font-size:13px;">Could not load presence</div>'; }
}

window.approveDevice = async function(requestId) {
  try {
    await window.gatewayClient.approveDevicePairing({ requestId });
    showNotification('Device approved');
    loadInstances();
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

window.rejectDevice = async function(requestId) {
  try {
    await window.gatewayClient.rejectDevicePairing({ requestId });
    showNotification('Device rejected');
    loadInstances();
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

// ==================== USAGE ====================

async function loadUsage() {
  const days = parseInt(document.getElementById('usage-period').value) || 30;
  const totalsDiv = document.getElementById('usage-totals');
  const sessionsDiv = document.getElementById('usage-sessions');

  try {
    const result = await window.gatewayClient.getSessionsUsage({ limit: 50 });
    const totals = result?.totals || result?.aggregates || {};
    const sessions = result?.sessions || [];

    totalsDiv.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Total Cost</div>
        <div class="stat-value">${formatCost(totals.cost || totals.totalCost || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Input Tokens</div>
        <div class="stat-value">${formatNumber(totals.inputTokens || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Output Tokens</div>
        <div class="stat-value">${formatNumber(totals.outputTokens || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Tokens</div>
        <div class="stat-value">${formatNumber((totals.inputTokens || 0) + (totals.outputTokens || 0))}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Requests</div>
        <div class="stat-value">${formatNumber(totals.requests || totals.turns || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${sessions.length}</div>
      </div>
    `;

    if (sessions.length === 0) {
      sessionsDiv.innerHTML = '<div style="color:#888;font-size:13px;">No usage data</div>';
    } else {
      sessionsDiv.innerHTML = sessions.slice(0, 30).map(s => `
        <div class="list-item">
          <div class="list-item-content">
            <div class="list-item-title">${escapeHtml(s.key || s.sessionKey || 'Unknown')}</div>
            <div class="list-item-meta">
              Cost: ${formatCost(s.cost || s.totalCost || 0)} &middot;
              Tokens: ${formatNumber((s.inputTokens || 0) + (s.outputTokens || 0))} &middot;
              Turns: ${s.turns || s.requests || 0}
              ${s.model ? ` &middot; ${escapeHtml(s.model)}` : ''}
            </div>
          </div>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to load usage:', err);
    totalsDiv.innerHTML = '<div style="color:#f44336;">Failed to load usage data</div>';
    sessionsDiv.innerHTML = '';
  }
}

// ==================== SETTINGS - Raw Config ====================

async function loadRawConfig() {
  try {
    const result = await window.gatewayClient.getGatewayConfig();
    const config = result?.config || {};
    document.getElementById('config-editor').value = JSON.stringify(config, null, 2);
    document.getElementById('config-status').textContent = result?.hash ? `Hash: ${result.hash.slice(0, 12)}...` : '';
    window._configHash = result?.hash;
  } catch (err) {
    document.getElementById('config-editor').value = '// Failed to load config: ' + err.message;
  }
}

window.saveRawConfig = async function() {
  const raw = document.getElementById('config-editor').value;
  try {
    JSON.parse(raw); // Validate JSON
  } catch {
    showNotification('Invalid JSON', 'error');
    return;
  }

  try {
    await window.gatewayClient.setGatewayConfig({
      raw,
      baseHash: window._configHash || '',
    });
    showNotification('Config saved. Gateway will restart.');
    setTimeout(() => loadRawConfig(), 2000);
  } catch (err) {
    showNotification('Failed: ' + err.message, 'error');
  }
}

// ==================== EXPORTS FOR APP.JS ====================

window.loadOverview = loadOverview;
window.loadSessions = loadSessions;
window.loadChannels = loadChannels;
window.loadCronJobs = loadCronJobs;
window.loadOrchestration = loadOrchestration;
window.loadInstances = loadInstances;
window.loadUsage = loadUsage;
window.loadChatSessions = loadChatSessions;
window.loadChatHistory = loadChatHistory;
window.loadRawConfig = loadRawConfig;
window.abortChat = abortChat;
