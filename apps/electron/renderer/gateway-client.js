// Gateway WebSocket client for making RPC calls
class GatewayClient {
  constructor() {
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.connected = false;
    this.handshakeComplete = false;
    this.eventListeners = new Map();

    window.verso.onGatewayMessage((message) => {
      this.handleMessage(message);
    });

    window.verso.onGatewayConnected(() => {
      this.connected = true;
      console.log('[Gateway Client] WebSocket connected, waiting for connect.challenge...');
    });

    window.verso.onGatewayDisconnected(() => {
      this.connected = false;
      this.handshakeComplete = false;
      console.log('[Gateway Client] Disconnected');
      for (const [id, { reject }] of this.pendingRequests) {
        reject(new Error('Gateway disconnected'));
      }
      this.pendingRequests.clear();

      // Auto-reconnect with backoff
      this.scheduleReconnect();
    });

    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
  }

  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  off(event, callback) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const idx = listeners.indexOf(callback);
      if (idx !== -1) listeners.splice(idx, 1);
    }
  }

  emit(event, data) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(data); } catch (e) { console.error('Event listener error:', e); }
      }
    }
  }

  async performHandshake() {
    try {
      const token = await window.verso.getGatewayToken();
      const id = String(++this.requestId);
      const connectParams = {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'verso-control-ui',
          displayName: 'Verso Desktop',
          version: '1.0.0',
          platform: navigator.platform || 'unknown',
          mode: 'ui'
        },
        scopes: ['operator.admin'],
        role: 'operator',
      };
      if (token) {
        connectParams.auth = { token };
      }

      const request = { type: 'req', id, method: 'connect', params: connectParams };

      this.pendingRequests.set(id, {
        resolve: (result) => {
          this.handshakeComplete = true;
          console.log('[Gateway Client] Handshake complete, protocol:', result?.protocol);
          this.emit('handshake', result);
          this.ensureMainSession();
        },
        reject: (err) => {
          console.error('[Gateway Client] Handshake rejected:', err);
        }
      });

      await window.verso.sendGatewayMessage(request);
      console.log('[Gateway Client] Handshake sent');
    } catch (err) {
      console.error('[Gateway Client] Handshake failed:', err);
    }
  }

  handleMessage(message) {
    // Handle response frames (type: "res")
    if (message.type === 'res' && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || message.error.code || 'Request failed'));
        } else {
          pending.resolve(message.payload ?? message.result);
        }
      }
      return;
    }

    // Handle event frames (type: "event")
    if (message.type === 'event') {
      if (message.event === 'connect.challenge') {
        console.log('[Gateway Client] Received connect.challenge, sending handshake...');
        this.performHandshake();
        return;
      }

      if (message.event === 'tick') {
        window.verso.sendGatewayMessage({ type: 'tick-ack' });
        return;
      }

      // Emit typed event for listeners
      this.emit(message.event, message.payload ?? message.data);

      // Also dispatch DOM event for legacy listeners
      window.dispatchEvent(new CustomEvent('gateway-event', {
        detail: { event: message.event, data: message.payload ?? message.data }
      }));
      return;
    }

    if (message.type === 'tick') {
      window.verso.sendGatewayMessage({ type: 'tick-ack' });
      return;
    }

    // Fallback: handle challenge/events without type:"event" wrapper
    if (message.event === 'connect.challenge' && message.type !== 'event') {
      this.performHandshake();
      return;
    }
    if (message.event && message.type !== 'event') {
      this.emit(message.event, message.payload ?? message.data);
      window.dispatchEvent(new CustomEvent('gateway-event', {
        detail: { event: message.event, data: message.payload ?? message.data }
      }));
    }
  }

  async ensureMainSession() {
    try {
      const result = await this.listSessions({ includeDerivedTitles: false });
      const sessions = result?.sessions || [];
      const hasMain = sessions.some(s => s.key === 'agent:main:main' || s.key === 'main');
      if (!hasMain) {
        console.log('[Gateway Client] No main session found, creating...');
        await this.resetSession({ key: 'main' });
        console.log('[Gateway Client] Main session created');
      }
    } catch (err) {
      console.warn('[Gateway Client] ensureMainSession failed:', err.message);
    }
  }

  scheduleReconnect() {
    if (this._reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempt), 15000);
    this._reconnectAttempt++;
    console.log(`[Gateway Client] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})...`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
        this._reconnectAttempt = 0;
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  async connect() {
    if (this.connected && this.handshakeComplete) return true;
    return await window.verso.connectGateway('ws://localhost:18789');
  }

  async waitForHandshake() {
    if (this.handshakeComplete) return;
    // Try to connect, but don't fail if gateway isn't ready yet — auto-reconnect will handle it
    if (!this.connected) {
      try { await this.connect(); } catch { /* auto-reconnect will retry */ }
    }
    if (this.handshakeComplete) return;
    // Wait for the handshake event (from auto-reconnect or current connection)
    await new Promise((resolve, reject) => {
      const onHandshake = () => { cleanup(); resolve(); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Gateway not available — check Settings > General')); }, 30000);
      const cleanup = () => { this.off('handshake', onHandshake); clearTimeout(timer); };
      this.on('handshake', onHandshake);
    });
  }

  async call(method, params = {}, timeoutMs = 30000) {
    await this.waitForHandshake();

    const id = String(++this.requestId);
    const request = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, timeoutMs);
      window.verso.sendGatewayMessage(request);
    });
  }

  // --- Health & Status ---
  async getHealth(params = {}) { return this.call('health', params); }
  async getStatus(params = {}) { return this.call('status', params); }
  async getPresence() { return this.call('system-presence'); }

  // --- Sessions ---
  async listSessions(params = {}) { return this.call('sessions.list', params); }
  async previewSessions(params) { return this.call('sessions.preview', params); }
  async patchSession(params) { return this.call('sessions.patch', params); }
  async resetSession(params) { return this.call('sessions.reset', params); }
  async deleteSession(params) { return this.call('sessions.delete', params); }
  async compactSession(params) { return this.call('sessions.compact', params); }
  async getSessionsUsage(params = {}) { return this.call('sessions.usage', params); }

  // --- Chat ---
  async chatHistory(params) { return this.call('chat.history', params); }
  async chatSend(params) { return this.call('chat.send', params, 120000); }
  async chatAbort(params) { return this.call('chat.abort', params); }
  async chatInject(params) { return this.call('chat.inject', params); }

  // --- Channels ---
  async getChannelsStatus(params = {}) { return this.call('channels.status', params); }
  async channelsLogout(params) { return this.call('channels.logout', params); }

  // --- Cron ---
  async listCronJobs(params = {}) { return this.call('cron.list', params); }
  async getCronStatus() { return this.call('cron.status'); }
  async addCronJob(params) { return this.call('cron.add', params); }
  async updateCronJob(params) { return this.call('cron.update', params); }
  async removeCronJob(params) { return this.call('cron.remove', params); }
  async runCronJob(params) { return this.call('cron.run', params); }
  async getCronRuns(params) { return this.call('cron.runs', params); }

  // --- Orchestration ---
  async listOrchestrations(params = {}) { return this.call('orchestration.list', params); }
  async getOrchestration(params) { return this.call('orchestration.get', params); }
  async createOrchestration(params) { return this.call('orchestration.create', params); }
  async abortOrchestration(params) { return this.call('orchestration.abort', params); }
  async retryOrchestration(params) { return this.call('orchestration.retry', params); }
  async deleteOrchestration(params) { return this.call('orchestration.delete', params); }

  // --- Agents ---
  async listAgents(params = {}) { return this.call('agents.list', params); }
  async createAgent(params) { return this.call('agents.create', params); }
  async updateAgent(params) { return this.call('agents.update', params); }
  async deleteAgent(params) { return this.call('agents.delete', params); }

  // --- Nodes & Devices ---
  async listNodes() { return this.call('node.list'); }
  async describeNode(params) { return this.call('node.describe', params); }
  async renameNode(params) { return this.call('node.rename', params); }
  async listDevicePairings() { return this.call('device.pair.list'); }
  async approveDevicePairing(params) { return this.call('device.pair.approve', params); }
  async rejectDevicePairing(params) { return this.call('device.pair.reject', params); }

  // --- Config ---
  async getGatewayConfig() { return this.call('config.get'); }
  async setGatewayConfig(params) { return this.call('config.set', params); }
  async patchGatewayConfig(params) { return this.call('config.patch', params); }

  // --- Models ---
  async listModels() { return this.call('models.list'); }

  // --- Usage ---
  async getUsageCost(params = {}) { return this.call('usage.cost', params); }
  async getUsageStatus() { return this.call('usage.status'); }

  // --- Logs ---
  async tailLogs(params = {}) { return this.call('logs.tail', params); }

  // --- Send ---
  async sendMessage(params) { return this.call('send', params); }
}

// Create global instance
window.gatewayClient = new GatewayClient();

// Auto-connect on load
window.addEventListener('DOMContentLoaded', () => {
  window.gatewayClient.connect().catch(err => {
    console.error('[Gateway Client] Failed to connect:', err);
    // Will auto-reconnect via scheduleReconnect
  });
});

// Reconnect after gateway restart
window.verso.onGatewayRestarted(() => {
  console.log('[Gateway Client] Gateway restarted, reconnecting...');
  window.gatewayClient.connected = false;
  window.gatewayClient.handshakeComplete = false;
  window.gatewayClient._reconnectAttempt = 0;
  setTimeout(() => {
    window.gatewayClient.connect().catch(() => {
      window.gatewayClient.scheduleReconnect();
    });
  }, 2000);
});
