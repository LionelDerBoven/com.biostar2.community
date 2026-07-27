'use strict';

const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const EventMapper = require('./EventMapper');

/**
 * BiostarClient - Handles BioStar 2 REST API Login, WebSocket stream, Heartbeat & Reconnection.
 * Uses Node.js built-in http/https modules instead of axios to minimise RAM usage.
 */
class BiostarClient extends EventEmitter {

  constructor(options = {}) {
    super();

    this.options = {
      biostarHost: options.biostarHost || '',
      wsUri: options.wsUri || '',
      loginUser: options.loginUser || '',
      password: options.password || '',
      ignoreEvents: new Set(options.ignoreEvents || ['LOCKED', 'UNLOCKED', 'ENROLL_SUCCESS', 'PARTIAL_UPDATE_SUCCESS', 'TIME_SET']),
      ignoreEventSubstrings: options.ignoreEventSubstrings || [],
      heartbeatMs: options.heartbeatMs || 30000,
      requestTimeoutMs: options.requestTimeoutMs || 10000,
      subscribeDelayMs: options.subscribeDelayMs || 500,
      subscribeAttempts: options.subscribeAttempts || 4,
      subscribeRetryMs: options.subscribeRetryMs || 1500,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      log: options.log || console.log,
      errorLog: options.errorLog || console.error
    };

    this.bsSessionId = null;
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.lastPong = 0;
    this.backoff = 2000;
    this.isConnected = false;
    this.userCache = new Map();

    // Reusable HTTPS agent (keep-alive socket pooling)
    this._httpsAgent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: this.options.rejectUnauthorized
    });
    this._httpAgent = new http.Agent({ keepAlive: true });
  }

  log(...args)      { this.options.log('[BioStarClient]', ...args); }
  errorLog(...args) { this.options.errorLog('[BioStarClient]', ...args); }
  sleep(ms)         { return new Promise(r => setTimeout(r, ms)); }

  // ---------------------------------------------------------------------------
  // Native HTTP/HTTPS request helper (replaces axios)
  // ---------------------------------------------------------------------------

  /**
   * Performs an HTTP/HTTPS request using only Node.js built-in modules.
   * @param {'GET'|'POST'} method
   * @param {string} url          Full URL including protocol and path.
   * @param {Object|null} body    JSON body (for POST), or null.
   * @param {Object} extraHeaders Additional request headers.
   * @returns {Promise<{statusCode, headers, data}>}
   */
  _request(method, url, body = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;
      const agent = isHttps ? this._httpsAgent : this._httpAgent;

      const bodyStr = body ? JSON.stringify(body) : null;

      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        agent,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
          ...extraHeaders
        }
      };

      const req = transport.request(reqOptions, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch (_) { data = raw; }
          resolve({ statusCode: res.statusCode, headers: res.headers, data });
        });
      });

      req.setTimeout(this.options.requestTimeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${this.options.requestTimeoutMs}ms`));
      });

      req.on('error', reject);

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    this.log('Starting BioStar 2 connection client...');
    await this.connect();
  }

  async stop() {
    this.log('Stopping BioStar 2 connection client...');
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.bsSessionId = null;
    this.isConnected = false;
    this.emit('status', 'DISCONNECTED');
  }

  clearTimers() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  // ---------------------------------------------------------------------------
  // Auth & Subscription
  // ---------------------------------------------------------------------------

  async login() {
    const url = `${this.options.biostarHost}/api/login`;
    this.log(`Logging into BioStar 2 at ${url} as '${this.options.loginUser}'...`);

    const { statusCode, headers } = await this._request('POST', url, {
      User: { login_id: this.options.loginUser, password: this.options.password }
    }).catch(err => { throw new Error(`Login request failed: ${err.message}`); });

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Login failed with HTTP ${statusCode}`);
    }

    const bsSessionId = headers['bs-session-id'];
    if (!bsSessionId) throw new Error('BioStar 2 did not return a bs-session-id header.');

    this.bsSessionId = bsSessionId;
    this.log(`Logged in. Session: ...${String(bsSessionId).slice(-4)}`);
    return bsSessionId;
  }

  async fetchUserProfile(userId) {
    if (!userId || userId === 'N/A' || userId === '0') return null;
    if (this.userCache.has(userId)) return this.userCache.get(userId);
    if (!this.bsSessionId) return null;

    try {
      const url = `${this.options.biostarHost}/api/users/${encodeURIComponent(userId)}`;
      const { statusCode, data } = await this._request('GET', url, null, {
        'bs-session-id': this.bsSessionId
      });

      if (statusCode < 200 || statusCode >= 300) return null;

      const u = data?.User || data;
      if (!u) return null;

      const details = {
        id: String(u.user_id || u.id || userId),
        name: u.name || 'N/A',
        group: u.user_group_id?.name || u.user_group?.name || 'N/A',
        email: u.email || 'N/A',
        title: u.title || 'N/A',
        department: u.department || 'N/A',
        telephone: u.phone_number || u.phone || u.telephone || 'N/A',
        loginId: u.login_id || 'N/A'
      };

      this.userCache.set(userId, details);
      this.log(`Cached profile for '${details.name}' (ID: ${userId})`);
      return details;
    } catch (_) {
      return null; // Non-critical — fall back to event payload
    }
  }

  async subscribeEvents() {
    const url = `${this.options.biostarHost}/api/events/start`;
    this.log('Subscribing to BioStar 2 event stream...');
    await this.sleep(this.options.subscribeDelayMs);

    let lastErr = null;
    for (let attempt = 1; attempt <= this.options.subscribeAttempts; attempt++) {
      try {
        const { statusCode } = await this._request('POST', url, {}, {
          'bs-session-id': this.bsSessionId
        });
        if (statusCode >= 200 && statusCode < 300) {
          this.log(`Subscribed to event stream (attempt ${attempt}).`);
          return true;
        }
        throw new Error(`HTTP ${statusCode}`);
      } catch (err) {
        lastErr = err;
        this.errorLog(`Subscribe attempt ${attempt}/${this.options.subscribeAttempts} failed: ${err.message}`);
        if (attempt < this.options.subscribeAttempts) await this.sleep(this.options.subscribeRetryMs);
      }
    }
    throw lastErr || new Error('All subscription attempts failed.');
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  async connect() {
    this.clearTimers();

    try {
      if (!this.bsSessionId) await this.login();

      const wsUri = this.options.wsUri || `${this.options.biostarHost.replace(/^https/, 'wss')}/wsapi`;
      this.log(`Connecting WebSocket to ${wsUri}...`);

      this.ws = new WebSocket(wsUri, {
        rejectUnauthorized: this.options.rejectUnauthorized
      });

      this.ws.on('open', async () => {
        this.log('WebSocket open. Sending session frame...');
        this.lastPong = Date.now();

        try {
          this.ws.send(`bs-session-id=${this.bsSessionId}`);
          await this.subscribeEvents();
          this.isConnected = true;
          this.backoff = 2000;
          this.startHeartbeat();
          this.emit('status', 'CONNECTED');
        } catch (err) {
          this.errorLog(`Post-open setup failed: ${err.message}`);
          this.bsSessionId = null;
          if (this.ws) { this.ws.removeAllListeners(); this.ws.terminate(); this.ws = null; }
          this.scheduleReconnect();
        }
      });

      this.ws.on('message', async (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.Response?.code === '0' || !parsed.Event) return;
          await this.handleIncomingEvent(parsed.Event);
        } catch (_) { /* non-JSON frames / pings */ }
      });

      this.ws.on('pong', () => { this.lastPong = Date.now(); });

      this.ws.on('close', (code) => {
        this.log(`WebSocket closed (code: ${code}).`);
        this.isConnected = false;
        this.emit('status', 'DISCONNECTED');
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        this.errorLog(`WebSocket error: ${err.message}`);
      });

    } catch (err) {
      this.errorLog(`Connection failed: ${err.message}`);
      this.bsSessionId = null;
      this.scheduleReconnect();
    }
  }

  async handleIncomingEvent(eventData) {
    const rawUserId = eventData.user_id?.user_id || eventData.user_id?.id || eventData.user_id_code;
    let userCacheDetails = null;

    if (rawUserId && String(rawUserId) !== 'N/A' && String(rawUserId) !== '0') {
      userCacheDetails = await this.fetchUserProfile(String(rawUserId));
    }

    const mapped = EventMapper.processEvent(
      eventData,
      this.options.ignoreEvents,
      this.options.ignoreEventSubstrings,
      userCacheDetails
    );

    if (!mapped) return;

    this.log(`Event: [${mapped.type.toUpperCase()}] User: '${mapped.user}' | Device: '${mapped.device}'`);
    this.emit('event', mapped);
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > this.options.heartbeatMs * 2) {
        this.errorLog('Heartbeat timeout. Terminating socket...');
        this.ws.terminate();
        return;
      }
      this.ws.ping();
    }, this.options.heartbeatMs);
  }

  scheduleReconnect() {
    this.clearTimers();
    this.bsSessionId = null;
    this.log(`Reconnecting in ${this.backoff / 1000}s...`);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.5, 60000);
  }
}

module.exports = BiostarClient;