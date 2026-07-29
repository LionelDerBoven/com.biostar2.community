'use strict';

const Homey = require('homey');
const BiostarClient = require('./lib/BiostarClient');
const EventMapper = require('./lib/EventMapper');
const LogStore = require('./lib/LogStore');

const LOG_LIMIT = 100;
const RESTART_DEBOUNCE_MS = 500;
const DISCONNECT_ALERT_MS = 120000;
const LIST_CACHE_TTL_MS = 60000;

// Languages that write the time on a 12-hour clock. Everything else — Dutch and
// French included — gets 24 hours, which is what those locales actually use.
const HOUR12_LANGUAGES = new Set(['en']);

// Settings that only change what is displayed or where it is stored, never how
// we talk to BioStar 2. Reconnecting for these would drop the event stream for
// a change that affects nothing on the wire.
const COSMETIC_SETTINGS = new Set([
  'biostar_log_usernames',
  'biostar_clock_24h',
  'biostar_persist_logs',
]);

/**
 * BioStar 2 Community Homey App
 */
class BioStarApp extends Homey.App {

  /**
   * onInit is called when the app is initialized by Homey Pro.
   */
  async onInit() {
    this.logs = [];
    this.restartDebounceTimer = null;
    this.disconnectAlertTimer = null;
    this.connectionStatus = 'UNKNOWN';
    this.listCache = {};
    this.logUserNames = this.homey.settings.get('biostar_log_usernames') !== false;
    this.hour12 = this.resolveHour12();
    this.startedAt = Date.now();

    this.logStore = new LogStore({ errorLog: (msg) => this.error(msg) });
    await this.initPersistentLog();

    this.addLog('Initializing BioStar 2 Community Homey App...', 'INFO');

    this.registerFlowCards();

    this.client = this.createClient();

    // Watch for App Settings changes from the Homey Mobile / Web App UI (debounced).
    this.homey.settings.on('set', (key) => {
      if (!key.startsWith('biostar_')) return;

      // Display-only settings are applied in place. Reconnecting for them would
      // drop the event stream for a change that affects nothing on the wire.
      if (COSMETIC_SETTINGS.has(key)) {
        this.applyCosmeticSettings();
        return;
      }

      if (this.restartDebounceTimer) clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = setTimeout(() => {
        this.restartDebounceTimer = null;
        this.log('BioStar configuration updated in settings. Restarting client...');
        this.addLog('Configuration updated in settings. Restarting client...', 'INFO');
        this.restartClient().catch((err) => this.error(`Restart failed: ${err.message}`));
      }, RESTART_DEBOUNCE_MS);
    });

    await this.startClient();

    this.log('BioStar 2 Community Homey App initialized successfully.');
    this.addLog('App initialized successfully.', 'INFO');
  }

  // ---------------------------------------------------------------------------
  // Flow cards
  // ---------------------------------------------------------------------------

  registerFlowCards() {
    // Triggers. Each carries an optional reader filter, so a Flow can target one
    // reader without needing a separate condition card.
    this.triggerAuthSucceeded = this.homey.flow.getTriggerCard('auth_succeeded');
    this.triggerIdentificationFailed = this.homey.flow.getTriggerCard('identification_failed');
    this.triggerAccessDenied = this.homey.flow.getTriggerCard('access_denied');
    this.triggerEventReceived = this.homey.flow.getTriggerCard('event_received');

    for (const card of [this.triggerAuthSucceeded, this.triggerIdentificationFailed,
      this.triggerAccessDenied, this.triggerEventReceived]) {
      card.registerRunListener(async (args, state) => this.matchesDeviceArg(args, state));
      card.registerArgumentAutocompleteListener('device', async (query) => this.autocompleteDevices(query));
    }

    // Conditions (AND cards).
    this.homey.flow.getConditionCard('is_connected')
      .registerRunListener(async () => Boolean(this.client && this.client.isConnected));

    const textConditions = {
      department_is: ['department', 'department'],
      user_is: ['user', 'user'],
      user_group_is: ['user_group', 'user_group'],
      device_is: ['device', 'device'],
    };

    for (const [cardId, [argName, stateKey]] of Object.entries(textConditions)) {
      this.homey.flow.getConditionCard(cardId)
        .registerRunListener(async (args, state) => BioStarApp.looseMatch(args[argName], state?.[stateKey]));
    }

    // Actions (THEN cards).
    this.homey.flow.getActionCard('reconnect')
      .registerRunListener(async () => {
        this.log('[Flow Action] Manual BioStar 2 reconnect triggered by Flow Action Card.');
        this.addLog('Manual BioStar 2 reconnect triggered by Flow Action Card.', 'ACTION');
        await this.restartClient();
        return true;
      });

    const openDoorCard = this.homey.flow.getActionCard('open_door');
    openDoorCard.registerRunListener(async (args) => {
      const doorId = args.door?.id;
      const doorName = args.door?.name || doorId;
      if (!doorId) throw new Error(this.homey.__('errors.noDoorSelected'));
      this.addLog(`Opening door '${doorName}' via Flow action...`, 'ACTION');
      await this.client.openDoor(doorId);
      this.addLog(`Door '${doorName}' opened.`, 'ACTION');
      return true;
    });
    openDoorCard.registerArgumentAutocompleteListener('door', async (query) => this.autocompleteDoors(query));
  }

  /**
   * Case-insensitive, partial, bidirectional match used by the text condition cards.
   */
  static looseMatch(argValue, stateValue) {
    const target = (argValue || '').toLowerCase().trim();
    const actual = (stateValue || '').toLowerCase().trim();
    if (!target || !actual) return false;
    return actual.includes(target) || target.includes(actual);
  }

  /**
   * Trigger run listener: passes when no specific reader was chosen, or when the
   * event came from the chosen reader. Matches on id, falling back to name.
   */
  matchesDeviceArg(args, state) {
    const selected = args?.device;
    if (!selected || !selected.id || selected.id === '*') return true;
    if (state?.deviceId && String(state.deviceId) === String(selected.id)) return true;
    return BioStarApp.looseMatch(selected.name, state?.device);
  }

  /**
   * Homey calls autocomplete listeners on every keystroke. Without this cache
   * each character typed in the Flow editor would fire a request at BioStar 2,
   * so the list is fetched once and reused, and concurrent calls share one
   * in-flight request.
   */
  async cachedList(kind, loader) {
    const entry = this.listCache[kind];
    const now = Date.now();

    if (entry && entry.value && now - entry.at < LIST_CACHE_TTL_MS) return entry.value;
    if (entry && entry.pending) return entry.pending;

    const pending = loader()
      .then((value) => {
        this.listCache[kind] = { value, at: Date.now() };
        return value;
      })
      .catch((err) => {
        this.listCache[kind] = null;
        throw err;
      });

    this.listCache[kind] = { pending, at: now };
    return pending;
  }

  static filterByName(items, query) {
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((d) => d.name.toLowerCase().includes(q));
  }

  async autocompleteDevices(query) {
    let devices = [];
    try {
      devices = await this.cachedList('devices', () => this.client.listDevices());
    } catch (err) {
      this.addLog(`Could not load reader list: ${err.message}`, 'WARN');
    }
    return BioStarApp.filterByName([{ id: '*', name: 'Any reader' }, ...devices], query);
  }

  async autocompleteDoors(query) {
    try {
      const doors = await this.cachedList('doors', () => this.client.listDoors());
      return BioStarApp.filterByName(doors, query);
    } catch (err) {
      this.addLog(`Could not load door list: ${err.message}`, 'WARN');
      throw err; // surfaced in the Flow editor so the cause is visible
    }
  }

  // ---------------------------------------------------------------------------
  // Client lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Applies display-only settings to the running client without reconnecting.
   */
  applyCosmeticSettings() {
    const wasHour12 = this.hour12;
    this.logUserNames = this.homey.settings.get('biostar_log_usernames') !== false;
    this.hour12 = this.resolveHour12();
    if (this.client) this.client.options.logUserNames = this.logUserNames;

    this.addLog(`Activity log user names ${this.logUserNames ? 'shown' : 'hidden'}.`, 'INFO');
    if (this.hour12 !== wasHour12) {
      this.addLog(`Activity log clock switched to ${this.hour12 ? '12' : '24'}-hour format.`, 'INFO');
    }
    this.initPersistentLog().catch((err) => this.error(`Persistent log: ${err.message}`));
  }

  /**
   * 12-hour clock for an English Homey, 24-hour for every other language, unless
   * the owner has forced 24-hour. Resolved once per settings change rather than
   * per log line, since it cannot change without one.
   */
  resolveHour12() {
    if (this.homey.settings.get('biostar_clock_24h') === true) return false;
    let language = 'en';
    try {
      language = this.homey.i18n.getLanguage() || 'en';
    } catch (_) { /* fall back to English */ }
    return HOUR12_LANGUAGES.has(String(language).slice(0, 2).toLowerCase());
  }

  /**
   * Formats a wall clock time without Intl. Homey's Node build cannot be relied
   * on to carry locale data for every language, and a log timestamp that
   * silently falls back to a different format would be worse than no choice at
   * all. Matches what toLocaleTimeString produced before: no leading zero on a
   * 12-hour hour, a leading zero on a 24-hour one.
   */
  static formatClock(date, hour12) {
    const pad = (n) => String(n).padStart(2, '0');
    const h = date.getHours();
    const rest = `${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    if (!hour12) return `${pad(h)}:${rest}`;
    return `${h % 12 === 0 ? 12 : h % 12}:${rest} ${h < 12 ? 'AM' : 'PM'}`;
  }

  /**
   * Brings the on-flash log in line with the setting. Enabling it replays what
   * was already stored into the in-memory buffer, so the log view survives an
   * app restart instead of starting blank.
   */
  async initPersistentLog() {
    const wanted = this.homey.settings.get('biostar_persist_logs') === true;
    if (!this.logStore || wanted === this.logStore.enabled) return;

    await this.logStore.setEnabled(wanted);
    if (!wanted) {
      this.addLog('Persistent log turned off; the stored file has been deleted.', 'INFO');
      return;
    }

    const stored = await this.logStore.readRecent(LOG_LIMIT);
    if (stored.length) {
      // Restored lines go in front of anything logged during this startup.
      this.logs = stored.concat(this.logs || []).slice(-LOG_LIMIT);
    }
    this.addLog(`Persistent log turned on; ${stored.length} stored line(s) restored.`, 'INFO');
  }

  /**
   * Single place where a BiostarClient is built and wired up.
   */
  createClient() {
    this.listCache = {}; // reader/door lists belong to the previous connection
    // The discovered-event registry outlives the client, otherwise saving a
    // setting (which rebuilds the client) would wipe the list you just used.
    const carried = this.client ? this.client.eventTypes : null;
    const client = new BiostarClient({
      ...this.getBiostarConfig(),
      log: (...args) => {
        const msg = args.join(' ');
        this.log(msg);
        // The client reports an access event on its normal log channel. Tagging
        // it here rather than as plain INFO is what lets the log filter treat
        // door activity as its own category.
        this.addLog(msg, /\bEvent: \[/.test(msg) ? 'EVENT' : 'INFO');
      },
      errorLog: (...args) => {
        const msg = args.join(' ');
        this.error(msg);
        this.addLog(msg, 'ERROR');
      },
    });

    if (carried && carried.size) client.eventTypes = carried;

    client.on('event', (evt) => this.handleBioStarEvent(evt));
    client.on('status', (status) => this.handleStatusChange(status));
    return client;
  }

  async startClient() {
    const config = this.getBiostarConfig();
    if (!config.password || !config.biostarHost || !config.loginUser) {
      this.log('BioStar 2 credentials/host not fully configured yet. Please configure in App Settings.');
      this.addLog('Credentials/host not fully configured yet. Please configure in App Settings.', 'WARN');
      return;
    }
    try {
      await this.client.start();
    } catch (err) {
      this.error(`Failed to start BioStar client on startup: ${err.message}`);
      this.addLog(`Failed to start BioStar client: ${err.message}`, 'ERROR');
    }
  }

  /**
   * Rebuilds the client against current settings, fully releasing the previous one.
   */
  async restartClient() {
    if (this.client) {
      await this.client.stop().catch(() => {});
      this.client.destroy();
    }
    this.client = this.createClient();
    await this.startClient();
  }

  handleStatusChange(status) {
    if (status === this.connectionStatus) return;
    this.connectionStatus = status;
    this.log(`BioStar 2 Connection status changed to: ${status}`);
    this.addLog(`Connection status changed to: ${status}`, 'STATUS');

    // Pushed to the settings page instead of persisted, so a flapping link
    // does not repeatedly write to Homey's settings store.
    this.homey.api.realtime('status', { status, stats: this.getStats() });

    if (status === 'CONNECTED') {
      if (this.disconnectAlertTimer) {
        clearTimeout(this.disconnectAlertTimer);
        this.disconnectAlertTimer = null;
      }
      return;
    }

    // Only warn once the outage has lasted long enough to matter.
    if (!this.disconnectAlertTimer) {
      this.disconnectAlertTimer = setTimeout(() => {
        this.disconnectAlertTimer = null;
        if (this.connectionStatus === 'CONNECTED') return;
        this.homey.notifications.createNotification({
          excerpt: this.homey.__('notifications.connectionLost'),
        }).catch((err) => this.error(`Notification failed: ${err.message}`));
      }, DISCONNECT_ALERT_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings & diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Reads settings from Homey.ManagerSettings.
   */
  getBiostarConfig() {
    const ignoreRaw = this.homey.settings.get('biostar_ignore_events');
    const substringRaw = this.homey.settings.get('biostar_ignore_substrings');

    return {
      biostarHost: this.homey.settings.get('biostar_host') || '',
      wsUri: this.homey.settings.get('biostar_ws_uri') || '',
      loginUser: this.homey.settings.get('biostar_user') || '',
      password: this.homey.settings.get('biostar_password') || '',
      rejectUnauthorized: this.homey.settings.get('biostar_reject_unauthorized') === true,
      ignoreEvents: BioStarApp.toList(ignoreRaw, EventMapper.DEFAULT_IGNORE_EVENTS),
      ignoreEventSubstrings: BioStarApp.toList(substringRaw, []),
      heartbeatMs: BioStarApp.toMs(this.homey.settings.get('biostar_heartbeat_s'), 30, 5, 300),
      reconnectMinMs: BioStarApp.toMs(this.homey.settings.get('biostar_reconnect_min_s'), 2, 1, 60),
      reconnectMaxMs: BioStarApp.toMs(this.homey.settings.get('biostar_reconnect_max_s'), 60, 5, 900),
      logUserNames: this.homey.settings.get('biostar_log_usernames') !== false,
      userCacheMax: 200,
      userCacheTtlMs: 3600000,
    };
  }

  /**
   * Accepts an array or a comma/newline separated string.
   */
  static toList(value, fallback) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string' && value.trim()) {
      return value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    }
    return fallback;
  }

  static toMs(value, defaultSeconds, minSeconds, maxSeconds) {
    const n = Number(value);
    const seconds = Number.isFinite(n) && n > 0 ? n : defaultSeconds;
    return Math.min(Math.max(seconds, minSeconds), maxSeconds) * 1000;
  }

  /**
   * Event names for the settings page: everything seen, plus anything already
   * ignored (so a rule for an event that has not occurred yet is still visible
   * and can be switched off again).
   */
  getEventTypes() {
    const ignored = new Set(BioStarApp.toList(
      this.homey.settings.get('biostar_ignore_events'),
      EventMapper.DEFAULT_IGNORE_EVENTS,
    ));
    const rows = this.client ? this.client.getEventTypes() : [];
    const seen = new Set(rows.map((r) => r.name));

    for (const name of ignored) {
      if (!seen.has(name)) rows.push({ name, count: 0, lastAt: null });
    }

    return rows.map((r) => ({ ...r, ignored: ignored.has(r.name) }));
  }

  getStats() {
    const s = this.client ? this.client.stats : {};
    return {
      status: this.connectionStatus,
      appUptimeMs: Date.now() - this.startedAt,
      connectedForMs: s.connectedSince ? Date.now() - s.connectedSince : 0,
      eventsReceived: s.eventsReceived || 0,
      eventsForwarded: s.eventsForwarded || 0,
      eventsIgnored: s.eventsIgnored || 0,
      reconnects: s.reconnects || 0,
      lastEventAt: s.lastEventAt || null,
      cachedUsers: this.client ? this.client.userCache.size : 0,
      profileLookupDisabled: this.client ? this.client.profileLookupDisabled : false,
      // Whether a password is stored, so the settings page can show its state
      // without the secret itself ever being sent to the page.
      hasPassword: Boolean(this.homey.settings.get('biostar_password')),
      persistLogs: Boolean(this.logStore && this.logStore.enabled),
    };
  }

  /**
   * Adds an entry to the in-memory log buffer.
   */
  addLog(msg, type = 'INFO') {
    if (!this.logs) this.logs = [];
    const timestamp = BioStarApp.formatClock(new Date(), this.hour12);
    const cleanMsg = typeof msg === 'string' ? msg.replace(/\[BioStarClient\]\s*/, '') : JSON.stringify(msg);
    const line = `[${timestamp}] [${type}] ${cleanMsg}`;

    this.logs.push(line);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);

    // The buffer above is capped at LOG_LIMIT; the file keeps the older lines.
    if (this.logStore) this.logStore.append(line);
  }

  /**
   * Returns log entries for the settings UI. `since` lets the page fetch only
   * what it has not seen yet instead of the whole buffer every poll.
   */
  getLogs(since = 0) {
    const logs = this.logs || [];
    const start = Number.isFinite(Number(since)) ? Math.max(0, Number(since)) : 0;
    return {
      total: logs.length,
      lines: start >= logs.length ? [] : logs.slice(start),
      status: this.connectionStatus,
      stats: this.getStats(),
    };
  }

  /**
   * Clears in-memory log buffer.
   */
  async clearLogs() {
    this.logs = [];
    // Clearing has to reach flash too, or the next restart would replay
    // everything the user just asked to be rid of. The store stays enabled and
    // simply starts a new file.
    if (this.logStore) await this.logStore.clear();
    this.addLog('Log buffer cleared by user.', 'INFO');
    return { success: true };
  }

  /**
   * Tests BioStar 2 REST API authentication with provided credentials.
   */
  async testConnection(config = {}) {
    const host = config.biostarHost || this.homey.settings.get('biostar_host');
    const user = config.loginUser || this.homey.settings.get('biostar_user');
    const password = config.password || this.homey.settings.get('biostar_password');
    const rejectUnauthorized = config.rejectUnauthorized === true;

    if (!host || !user || !password) {
      throw new Error(this.homey.__('errors.incompleteCredentials'));
    }

    this.addLog(`Testing connection to ${host} as user '${user}'...`, 'TEST');

    const testClient = new BiostarClient({
      biostarHost: host,
      loginUser: user,
      password,
      rejectUnauthorized,
      log: (...args) => this.log('[TestClient]', ...args),
      errorLog: (...args) => this.error('[TestClient]', ...args),
    });

    try {
      const sessionId = await testClient.login();

      // Report which optional permissions this account actually has, so a
      // missing grant surfaces here instead of silently degrading later.
      const checks = [];
      for (const [label, fn] of [['Users', () => testClient.probeUsers()],
        ['Doors', () => testClient.listDoors()]]) {
        try {
          await fn();
          checks.push(`${label}: OK`);
        } catch (err) {
          checks.push(`${label}: unavailable`);
        }
      }

      const successMsg = `Connected to BioStar 2 (session ...${String(sessionId).slice(-4)}). ${checks.join(' | ')}`;
      this.addLog(successMsg, 'TEST_SUCCESS');
      return { success: true, message: successMsg };
    } catch (err) {
      this.addLog(`Test connection failed: ${err.message}`, 'TEST_ERROR');
      return { success: false, message: err.message };
    } finally {
      // Without this the throwaway client keeps pooled keep-alive sockets open.
      testClient.destroy();
    }
  }

  async forceReconnect() {
    this.addLog('Manual reconnect requested from settings.', 'ACTION');
    await this.restartClient();
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Event dispatch
  // ---------------------------------------------------------------------------

  /**
   * Handles processed events from BiostarClient and triggers native Homey Flows.
   */
  handleBioStarEvent(evt) {
    // Flow tokens always carry the real identity; only the on-screen log is masked.
    const who = this.logUserNames
      ? `User: '${evt.user || 'N/A'}' (ID: ${evt.userId || 'N/A'})`
      : 'User: <hidden>';
    this.addLog(`[Flow Dispatch] ${evt.type} | ${who} | Device: '${evt.device}'`, 'EVENT');

    const state = {
      user: evt.user,
      device: evt.device,
      deviceId: evt.deviceId,
      department: evt.department,
      user_group: evt.group,
    };

    const userTokens = {
      user: evt.user || 'N/A',
      device: evt.device,
      user_id: evt.userId || 'N/A',
      user_group: evt.group || 'N/A',
      email: evt.email || 'N/A',
      title: evt.title || 'N/A',
      department: evt.department || 'N/A',
      telephone: evt.telephone || 'N/A',
      login_id: evt.loginId || 'N/A',
    };

    this.triggerEventReceived.trigger({
      ...userTokens,
      event_type: evt.type,
      event_name: evt.rawName,
      timestamp: evt.timestamp,
    }, state).catch(this.error);

    if (evt.type === 'success') {
      this.triggerAuthSucceeded.trigger({
        ...userTokens, event_name: evt.rawName, timestamp: evt.timestamp,
      }, state).catch(this.error);
    } else if (evt.type === 'access_denied') {
      this.triggerAccessDenied.trigger({
        ...userTokens, event_name: evt.rawName, timestamp: evt.timestamp,
      }, state).catch(this.error);
    } else if (evt.type === 'identification_fail') {
      this.triggerIdentificationFailed.trigger({
        device: evt.device, event_name: evt.rawName, timestamp: evt.timestamp,
      }, { device: evt.device, deviceId: evt.deviceId }).catch(this.error);
    }
  }

  /**
   * Clean up on uninitialization.
   */
  async onUninit() {
    if (this.restartDebounceTimer) clearTimeout(this.restartDebounceTimer);
    if (this.disconnectAlertTimer) clearTimeout(this.disconnectAlertTimer);
    if (this.client) {
      await this.client.stop().catch(() => {});
      this.client.destroy();
    }
    // Last, so anything the shutdown itself logged still reaches flash.
    if (this.logStore) await this.logStore.destroy().catch(() => {});
  }

}

module.exports = BioStarApp;
