'use strict';

const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const EventMapper = require('./EventMapper');

/**
 * BiostarClient - Handles BioStar 2 REST API Login, WebSocket stream, Heartbeat & Reconnection.
 * Uses Node.js built-in http/https modules instead of axios to minimise RAM usage.
 *
 * Memory notes:
 *  - The user profile cache is bounded (LRU) and entries expire, so it cannot grow forever.
 *  - Every async step is guarded by a generation counter, so a client that has been stopped
 *    can never resurrect itself with a live socket or heartbeat timer.
 *  - HTTP agents cap their socket pools instead of defaulting to Infinity.
 */
class BiostarClient extends EventEmitter {

  constructor(options = {}) {
    super();

    this.options = {
      biostarHost: options.biostarHost || '',
      wsUri: options.wsUri || '',
      loginUser: options.loginUser || '',
      password: options.password || '',
      ignoreEvents: new Set(options.ignoreEvents || EventMapper.DEFAULT_IGNORE_EVENTS),
      ignoreEventSubstrings: options.ignoreEventSubstrings || [],
      heartbeatMs: options.heartbeatMs || 30000,
      requestTimeoutMs: options.requestTimeoutMs || 10000,
      subscribeDelayMs: options.subscribeDelayMs || 500,
      subscribeAttempts: options.subscribeAttempts || 4,
      subscribeRetryMs: options.subscribeRetryMs || 1500,
      reconnectMinMs: options.reconnectMinMs || 2000,
      reconnectMaxMs: options.reconnectMaxMs || 60000,
      userCacheMax: options.userCacheMax || 200,
      userCacheTtlMs: options.userCacheTtlMs || 3600000,
      eventTypeMax: options.eventTypeMax || 200,
      logUserNames: options.logUserNames !== false,
      rejectUnauthorized: options.rejectUnauthorized === true,
      log: options.log || console.log,
      errorLog: options.errorLog || console.error,
    };

    this.bsSessionId = null;
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectPending = false;
    this.lastPong = 0;
    this.backoff = this.options.reconnectMinMs;
    this.isConnected = false;

    // Bounded LRU cache: Map preserves insertion order, so the first key is the oldest.
    this.userCache = new Map();

    // Distinct event names seen, so the settings page can offer them for filtering.
    // Recorded before the ignore check, otherwise filtered names would never show up.
    this.eventTypes = new Map();
    this.inFlightProfiles = new Map();
    this.profileLookupDisabled = false;

    // Generation guard. Incremented by stop(); every async continuation checks it.
    this.generation = 0;
    this.stopped = false;

    // Serialises event handling so Flows fire in the order BioStar 2 sent them.
    this.eventQueue = Promise.resolve();

    // Diagnostics surfaced in the settings UI.
    this.stats = {
      eventsReceived: 0,
      eventsForwarded: 0,
      eventsIgnored: 0,
      reconnects: 0,
      profileFetchFailures: 0,
      connectedSince: null,
      lastEventAt: null,
    };

    // True while login is failing with a 5xx, so the "this is the server, not
    // the app" guidance is logged once per outage rather than on every retry.
    this.loginFaultHinted = false;

    this.buildAgents();
  }

  buildAgents() {
    this._httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: 4,
      maxFreeSockets: 1,
      timeout: 15000,
      rejectUnauthorized: this.options.rejectUnauthorized,
    });
    this._httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: 4,
      maxFreeSockets: 1,
      timeout: 15000,
    });
  }

  /**
   * Rebuilds the agents, dropping every pooled keep-alive socket.
   *
   * A router restart clears the NAT/connection-tracking table, so the sockets
   * parked in these pools are dead while still looking idle and reusable. Node
   * hands one to the next request, which writes into a black hole and only
   * fails once the request timeout expires — one wasted attempt, and with the
   * backoff at its 60s ceiling that is a minute of downtime per stale socket.
   * Every reconnect therefore starts on fresh connections.
   */
  recycleAgents() {
    if (this._httpsAgent) this._httpsAgent.destroy();
    if (this._httpAgent) this._httpAgent.destroy();
    this.buildAgents();
  }

  log(...args) {
    this.options.log('[BioStarClient]', ...args);
  }

  errorLog(...args) {
    this.options.errorLog('[BioStarClient]', ...args);
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------------------
  // Native HTTP/HTTPS request helper (replaces axios)
  // ---------------------------------------------------------------------------

  /**
   * Performs an HTTP/HTTPS request using only Node.js built-in modules.
   * @param {'GET'|'POST'|'PUT'} method
   * @param {string} url          Full URL including protocol and path.
   * @param {Object|null} body    JSON body, or null.
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
          ...extraHeaders,
        },
      };

      const req = transport.request(reqOptions, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            data = raw;
          }
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

  /**
   * Authenticated request that transparently re-logs in once on 401.
   */
  async _apiRequest(method, path, body = null) {
    if (!this.bsSessionId) await this.login();
    const url = `${this.options.biostarHost}${path}`;
    let res = await this._request(method, url, body, { 'bs-session-id': this.bsSessionId });

    if (res.statusCode === 401) {
      this.log('Session expired, re-authenticating...');
      this.bsSessionId = null;
      await this.login();
      res = await this._request(method, url, body, { 'bs-session-id': this.bsSessionId });
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    this.stopped = false;
    this.log('Starting BioStar 2 connection client...');
    await this.connect();
  }

  /**
   * Stops the client permanently. Any connect() already in flight is neutralised
   * by the generation bump, so it cannot open a socket after this returns.
   */
  async stop() {
    this.stopped = true;
    this.generation += 1;
    this.log('Stopping BioStar 2 connection client...');
    this.clearTimers();
    this.teardownSocket();
    this.bsSessionId = null;
    this.isConnected = false;
    this.stats.connectedSince = null;
    this.emit('status', 'DISCONNECTED');
  }

  /**
   * Releases every retained resource. Call when the client is discarded for good.
   */
  destroy() {
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    this.teardownSocket();
    this.userCache.clear();
    this.inFlightProfiles.clear();
    this.eventTypes.clear();
    this.removeAllListeners();
    if (this._httpsAgent) this._httpsAgent.destroy();
    if (this._httpAgent) this._httpAgent.destroy();
  }

  teardownSocket() {
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch (_) { /* already gone */ }
      this.ws = null;
    }
  }

  clearTimers() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer); this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    }
    this.reconnectPending = false;
  }

  // ---------------------------------------------------------------------------
  // Auth & Subscription
  // ---------------------------------------------------------------------------

  /**
   * BioStar 2 explains a rejected call in a {"Response":{code,message}} body.
   * Without it a log line reads only "HTTP 500", which cannot distinguish wrong
   * credentials from a BioStar server whose own login service is down.
   */
  static describeApiError(data) {
    const r = data?.Response;
    if (r?.message) return `: ${r.message}${r.code ? ` (BioStar code ${r.code})` : ''}`;
    if (typeof data === 'string' && data.trim()) return `: ${data.trim().slice(0, 200)}`;
    return '';
  }

  async login() {
    const url = `${this.options.biostarHost}/api/login`;
    this.log(`Logging into BioStar 2 at ${url} as '${this.options.loginUser}'...`);

    const { statusCode, headers, data } = await this._request('POST', url, {
      User: { login_id: this.options.loginUser, password: this.options.password },
    }).catch((err) => {
      throw new Error(`Login request failed: ${err.message}`);
    });

    if (statusCode < 200 || statusCode >= 300) {
      // A 5xx means BioStar 2 answered, so the network and this app are fine and
      // retrying cannot help until the server is repaired. Say so once, or the
      // log shows nothing but an identical failure every minute forever.
      if (statusCode >= 500 && !this.loginFaultHinted) {
        this.loginFaultHinted = true;
        this.errorLog(
          `BioStar 2 is reachable but rejects every login with HTTP ${statusCode}. This is a fault on the `
          + 'BioStar 2 server itself, not in Homey or the network: its web tier is answering while the core '
          + 'service behind it is not. Restart the BioStar 2 services on the server. The app keeps retrying '
          + 'and reconnects on its own once login works again.',
        );
      }
      throw new Error(`Login failed with HTTP ${statusCode}${BiostarClient.describeApiError(data)}`);
    }

    const bsSessionId = headers['bs-session-id'];
    if (!bsSessionId) throw new Error('BioStar 2 did not return a bs-session-id header.');

    this.loginFaultHinted = false;
    this.bsSessionId = bsSessionId;
    this.log(`Logged in. Session: ...${String(bsSessionId).slice(-4)}`);
    return bsSessionId;
  }

  // ---------------------------------------------------------------------------
  // Bounded user profile cache
  // ---------------------------------------------------------------------------

  cacheGet(userId) {
    const hit = this.userCache.get(userId);
    if (!hit) return undefined;

    if (Date.now() - hit.cachedAt > this.options.userCacheTtlMs) {
      this.userCache.delete(userId);
      return undefined;
    }
    // Refresh LRU position.
    this.userCache.delete(userId);
    this.userCache.set(userId, hit);
    return hit.details;
  }

  cacheSet(userId, details) {
    if (this.userCache.has(userId)) this.userCache.delete(userId);
    this.userCache.set(userId, { details, cachedAt: Date.now() });
    while (this.userCache.size > this.options.userCacheMax) {
      this.userCache.delete(this.userCache.keys().next().value);
    }
  }

  /**
   * Fetches a user profile, de-duplicating concurrent lookups for the same id.
   * Disables itself after a permission error so it stops burning a request per event.
   */
  async fetchUserProfile(userId) {
    if (!userId || this.profileLookupDisabled || !this.bsSessionId) return null;

    const cached = this.cacheGet(userId);
    if (cached !== undefined) return cached;

    const pending = this.inFlightProfiles.get(userId);
    if (pending) return pending;

    const lookup = this._doFetchUserProfile(userId)
      .finally(() => this.inFlightProfiles.delete(userId));

    this.inFlightProfiles.set(userId, lookup);
    return lookup;
  }

  async _doFetchUserProfile(userId) {
    try {
      const { statusCode, data } = await this._apiRequest('GET', `/api/users/${encodeURIComponent(userId)}`);

      if (statusCode === 401 || statusCode === 403) {
        this.profileLookupDisabled = true;
        this.stats.profileFetchFailures += 1;
        this.errorLog(
          `User profile lookup denied (HTTP ${statusCode}) for account '${this.options.loginUser}'. `
          + 'Extra user tags (group, email, department, telephone, login ID) will fall back to the raw event data. '
          + 'Grant this account the Users read permission in BioStar 2 to enable them.',
        );
        return null;
      }

      if (statusCode < 200 || statusCode >= 300) {
        this.stats.profileFetchFailures += 1;
        return null;
      }

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
        loginId: u.login_id || 'N/A',
      };

      this.cacheSet(userId, details);
      return details;
    } catch (err) {
      this.stats.profileFetchFailures += 1;
      return null; // Non-critical — fall back to event payload.
    }
  }

  // ---------------------------------------------------------------------------
  // Devices & doors (used by Flow autocomplete and the door action)
  // ---------------------------------------------------------------------------

  /**
   * Verifies this account can read user profiles. Used by "Test Connection"
   * so a missing permission is reported up front rather than degrading silently.
   */
  async probeUsers() {
    const { statusCode } = await this._apiRequest('GET', '/api/users?limit=1');
    if (statusCode === 401 || statusCode === 403) throw new Error('Permission denied reading users.');
    if (statusCode < 200 || statusCode >= 300) throw new Error(`Could not read users (HTTP ${statusCode}).`);
    return true;
  }

  /**
   * True when a device can actually authenticate someone.
   *
   * BioStar 2 returns readers and their slave I/O boards from the same endpoint.
   * An expansion module such as a SecureIO2 has no `authentication` block and
   * carries a `parent_device_id` pointing at the reader it is wired to, so it can
   * never be the source of an authentication event and must not be offered as a
   * reader to pick in a Flow.
   */
  static isReader(row) {
    if (row.authentication) return true;
    if (row.parent_device_id) return false;
    // Unknown shape: keep it rather than hide a reader we failed to recognise.
    return true;
  }

  /**
   * Devices that can authenticate a person. Falls back to the unfiltered list if
   * the filter matches nothing, so an unfamiliar BioStar version cannot leave the
   * Flow editor with an empty reader picker.
   */
  async listDevices() {
    const { statusCode, data } = await this._apiRequest('GET', '/api/devices');
    if (statusCode === 403) throw new Error('Permission denied reading devices. Grant this account the Device read permission in BioStar 2.');
    if (statusCode < 200 || statusCode >= 300) throw new Error(`Could not read devices (HTTP ${statusCode}).`);

    const rows = data?.DeviceCollection?.rows || [];
    const readers = rows.filter((r) => BiostarClient.isReader(r));
    const chosen = readers.length ? readers : rows;

    const skipped = rows.length - chosen.length;
    if (skipped > 0) this.log(`Reader list: ${chosen.length} reader(s), ${skipped} non-authenticating device(s) hidden.`);

    return chosen.map((r) => ({ id: String(r.id), name: r.name || `Device ${r.id}` }));
  }

  async listDoors() {
    const { statusCode, data } = await this._apiRequest('GET', '/api/doors');
    if (statusCode === 403) throw new Error('Permission denied reading doors. Grant this account the Door read permission in BioStar 2.');
    if (statusCode < 200 || statusCode >= 300) throw new Error(`Could not read doors (HTTP ${statusCode}).`);
    const rows = data?.DoorCollection?.rows || [];
    return rows.map((r) => ({ id: String(r.id), name: r.name || `Door ${r.id}` }));
  }

  /**
   * Momentarily releases a door (the BioStar 2 "open door" command).
   *
   * Door control is a separate right from door read: reading /api/doors can
   * succeed while this still returns 403. In BioStar 2 the control action is
   * granted through the Monitoring permission at Edit/Read level.
   */
  async openDoor(doorId) {
    // Verified against BioStar 2 v2.9.8: the collection form is the supported
    // shape. The per-door path /api/doors/{id}/open answers 400 'Request is
    // not supported' even with full permissions.
    const { statusCode, data } = await this._apiRequest('POST', '/api/doors/open', {
      DoorCollection: { rows: [{ id: String(doorId) }] },
    });
    if (statusCode === 401 || statusCode === 403) {
      throw new Error(
        'Permission denied opening the door. This account can read doors but not control them. '
        + 'In BioStar 2, open the operator permission set assigned to this account and enable Monitoring at Edit/Read level.',
      );
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Open door failed (HTTP ${statusCode}): ${data?.Response?.message || 'unknown error'}`);
    }
    this.log(`Door ${doorId} opened via Flow action.`);
    return true;
  }

  async subscribeEvents(generation) {
    const url = `${this.options.biostarHost}/api/events/start`;
    this.log('Subscribing to BioStar 2 event stream...');
    await this.sleep(this.options.subscribeDelayMs);
    if (this.isStale(generation)) throw new Error('Client stopped during subscribe delay.');

    let lastErr = null;
    for (let attempt = 1; attempt <= this.options.subscribeAttempts; attempt++) {
      try {
        const { statusCode, data } = await this._request('POST', url, {}, { 'bs-session-id': this.bsSessionId });
        if (this.isStale(generation)) throw new Error('Client stopped during subscribe.');
        if (statusCode >= 200 && statusCode < 300) {
          this.log(`Subscribed to event stream (attempt ${attempt}).`);
          return true;
        }
        throw new Error(`HTTP ${statusCode}${BiostarClient.describeApiError(data)}`);
      } catch (err) {
        if (this.isStale(generation)) throw err;
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

  /**
   * True when this client was stopped (or restarted) since the async step began.
   */
  isStale(generation) {
    return this.stopped || generation !== this.generation;
  }

  async connect() {
    this.clearTimers();
    if (this.stopped) return;

    const { generation } = this;

    try {
      if (!this.bsSessionId) await this.login();
      if (this.isStale(generation)) return;

      const wsUri = this.options.wsUri || `${this.options.biostarHost.replace(/^https/, 'wss')}/wsapi`;
      this.log(`Connecting WebSocket to ${wsUri}...`);

      // Never leave a previous socket behind.
      this.teardownSocket();

      // Without handshakeTimeout a connect into a black hole — the router is up
      // but the route to BioStar 2 is not yet — hangs on the OS TCP timeout,
      // which can be minutes. No event fires in the meantime and no reconnect
      // timer is pending, so the app would simply sit there.
      const ws = new WebSocket(wsUri, {
        rejectUnauthorized: this.options.rejectUnauthorized,
        handshakeTimeout: this.options.requestTimeoutMs,
      });
      this.ws = ws;

      ws.on('open', async () => {
        if (this.isStale(generation)) {
          try {
            ws.terminate();
          } catch (_) {} return;
        }
        this.log('WebSocket open. Sending session frame...');
        this.lastPong = Date.now();

        try {
          ws.send(`bs-session-id=${this.bsSessionId}`);
          await this.subscribeEvents(generation);
          if (this.isStale(generation)) {
            try {
              ws.terminate();
            } catch (_) {} return;
          }

          this.isConnected = true;
          this.backoff = this.options.reconnectMinMs;
          this.stats.connectedSince = Date.now();
          this.startHeartbeat(generation);
          this.emit('status', 'CONNECTED');
        } catch (err) {
          if (this.isStale(generation)) return;
          this.errorLog(`Post-open setup failed: ${err.message}`);
          this.bsSessionId = null;
          this.teardownSocket();
          this.scheduleReconnect();
        }
      });

      ws.on('message', (data) => {
        if (this.isStale(generation)) return;
        let parsed = null;
        try {
          parsed = JSON.parse(data.toString());
        } catch (_) {
          return; // non-JSON frames / pings
        }
        if (parsed.Response?.code === '0' || !parsed.Event) return;

        // Serialise: keeps Flow firing order identical to BioStar 2's send order.
        this.eventQueue = this.eventQueue
          .then(() => (this.isStale(generation) ? undefined : this.handleIncomingEvent(parsed.Event)))
          .catch((err) => this.errorLog(`Event handling failed: ${err.message}`));
      });

      ws.on('pong', () => {
        this.lastPong = Date.now();
      });

      ws.on('close', (code) => {
        if (this.isStale(generation)) return;
        this.log(`WebSocket closed (code: ${code}).`);
        this.isConnected = false;
        this.stats.connectedSince = null;
        this.emit('status', 'DISCONNECTED');
        this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        if (this.isStale(generation)) return;
        this.errorLog(`WebSocket error: ${err.message}`);
        // A socket that never opened may report only 'error' — a failed or timed
        // out handshake being the common case. Recovery hangs off 'close' alone,
        // so schedule here too; scheduleReconnect() ignores the duplicate when
        // 'close' does follow. While open, leave it to 'close' and the heartbeat.
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.scheduleReconnect();
      });

    } catch (err) {
      if (this.isStale(generation)) return;
      this.errorLog(`Connection failed: ${err.message}`);
      this.bsSessionId = null;
      this.scheduleReconnect();
    }
  }

  /**
   * Filters first, then enriches. A background event never costs an HTTP request.
   */
  async handleIncomingEvent(eventData) {
    this.stats.eventsReceived += 1;

    const ev = EventMapper.unwrap(eventData);
    if (!ev) return;

    const rawName = EventMapper.rawNameOf(ev);
    this.recordEventType(rawName);

    if (EventMapper.isIgnored(rawName, this.options.ignoreEvents, this.options.ignoreEventSubstrings)
      || !EventMapper.classify(rawName)) {
      this.stats.eventsIgnored += 1;
      return;
    }

    // Only now is a profile lookup worth doing.
    let userCacheDetails = null;
    const userId = EventMapper.userIdOf(ev);
    if (userId) userCacheDetails = await this.fetchUserProfile(userId);

    const mapped = EventMapper.processEvent(
      eventData,
      this.options.ignoreEvents,
      this.options.ignoreEventSubstrings,
      userCacheDetails,
    );

    if (!mapped) {
      this.stats.eventsIgnored += 1; return;
    }

    this.stats.eventsForwarded += 1;
    this.stats.lastEventAt = Date.now();
    const who = this.options.logUserNames ? `User: '${mapped.user || 'N/A'}'` : 'User: <hidden>';
    this.log(`Event: [${mapped.type.toUpperCase()}] ${who} | Device: '${mapped.device}'`);
    this.emit('event', mapped);
  }

  /**
   * Notes that an event name was seen. Bounded like the user cache: the least
   * recently seen name is dropped once the cap is reached.
   */
  recordEventType(name) {
    if (!name || name === 'UNKNOWN') return;
    const entry = this.eventTypes.get(name);
    if (entry) {
      entry.count += 1;
      entry.lastAt = Date.now();
      this.eventTypes.delete(name);
      this.eventTypes.set(name, entry);
      return;
    }
    this.eventTypes.set(name, { count: 1, lastAt: Date.now() });
    while (this.eventTypes.size > this.options.eventTypeMax) {
      this.eventTypes.delete(this.eventTypes.keys().next().value);
    }
  }

  /**
   * Event names seen so far, most frequent first.
   */
  getEventTypes() {
    return [...this.eventTypes.entries()]
      .map(([name, e]) => ({ name, count: e.count, lastAt: e.lastAt }))
      .sort((a, b) => b.count - a.count);
  }

  startHeartbeat(generation) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.isStale(generation)) {
        clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; return;
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > this.options.heartbeatMs * 2) {
        this.errorLog('Heartbeat timeout. Terminating socket...');
        this.ws.terminate();
        return;
      }
      this.ws.ping();
    }, this.options.heartbeatMs);
  }

  /**
   * Idempotent: a failing socket can report both 'error' and 'close', and the
   * second call must not re-arm the timer, double-count a reconnect or advance
   * the backoff twice.
   */
  scheduleReconnect() {
    if (this.reconnectPending) return;
    this.clearTimers();
    if (this.stopped) return;

    const { generation } = this;
    this.reconnectPending = true;
    this.bsSessionId = null;
    this.stats.reconnects += 1;
    // The link just failed; assume anything still pooled died with it.
    this.recycleAgents();
    this.log(`Reconnecting in ${Math.round(this.backoff / 1000)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectPending = false;
      this.reconnectTimer = null;
      if (this.isStale(generation)) return;
      this.connect().catch((err) => this.errorLog(`Reconnect attempt failed: ${err.message}`));
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 1.5, this.options.reconnectMaxMs);
  }
}

module.exports = BiostarClient;
