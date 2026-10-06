'use strict';

const Homey = require('homey');
const BiostarClient = require('./lib/BiostarClient');
const EventMapper = require('./lib/EventMapper');
const LogStore = require('./lib/LogStore');

const LOG_LIMIT = 100;
// A runaway error message must not be able to grow the buffer without limit.
const MAX_MESSAGE_LENGTH = 300;
const RESTART_DEBOUNCE_MS = 500;
const DISCONNECT_ALERT_MS = 120000;
const LIST_CACHE_TTL_MS = 60000;

const { BiostarError } = BiostarClient;

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
 * BioStar 2 Homey app
 */
class BioStarApp extends Homey.App {

  /**
   * onInit is called when the app is initialized by Homey Pro.
   */
  async onInit() {
    this.logs = [];
    // The settings page asks for "everything after sequence n of epoch e". A
    // position in this.logs cannot serve, because the buffer stops growing once
    // it is full; the epoch changes whenever the buffer is cleared or rebuilt.
    this.logSeq = 0;
    this.logEpoch = Date.now();
    this.restartDebounceTimer = null;
    this.disconnectAlertTimer = null;
    // Set while the app itself stops a client (restart or unload), so the
    // DISCONNECTED that stop() always emits is not taken for an outage.
    this.stoppingOnPurpose = false;
    this.unloading = false;
    this.configError = null;
    this.connectionStatus = 'UNKNOWN';
    this.listCache = {};
    this.logUserNames = this.homey.settings.get('biostar_log_usernames') !== false;
    this.hour12 = this.resolveHour12();
    this.startedAt = Date.now();

    this.logStore = new LogStore({ errorLog: (msg) => this.logError(msg) });
    await this.initPersistentLog();

    this.addLog('Initializing BioStar 2 Homey app...', 'INFO');

    this.registerFlowCards();

    this.client = this.createClient();

    // Watch for App Settings changes from the Homey Mobile / Web App UI (debounced).
    this.onSettingsSet = (key) => {
      if (!key.startsWith('biostar_')) return;

      // Display-only settings are applied in place. Reconnecting for them would
      // drop the event stream for a change that affects nothing on the wire.
      if (COSMETIC_SETTINGS.has(key)) {
        this.applyCosmeticSettings();
        return;
      }

      if (this.restartDebounceTimer) this.homey.clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = this.homey.setTimeout(() => {
        this.restartDebounceTimer = null;
        this.log('BioStar configuration updated in settings. Restarting client...');
        this.addLog('Configuration updated in settings. Restarting client...', 'INFO');
        this.restartClient().catch((err) => this.logError(`Restart failed: ${err.message}`));
      }, RESTART_DEBOUNCE_MS);
    };
    this.homey.settings.on('set', this.onSettingsSet);

    await this.startClient();

    this.log('BioStar 2 Homey app initialized successfully.');
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
        .registerRunListener(async (args, state) => BioStarApp.exactMatch(args[argName], state?.[stateKey]));
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
      try {
        await this.client.openDoor(doorId);
      } catch (err) {
        this.addLog(`Opening door '${doorName}' failed: ${err.message}`, 'ERROR');
        throw new Error(this.describeError(err)); // shown in the Flow editor
      }
      this.addLog(`Door '${doorName}' opened.`, 'ACTION');
      return true;
    });
    openDoorCard.registerArgumentAutocompleteListener('door', async (query) => this.autocompleteDoors(query));
  }

  /**
   * Case-insensitive, trimmed, exact match used by the text condition cards.
   * Not a substring match: "John" must not pass for "Johnny" on an access card.
   */
  static exactMatch(argValue, stateValue) {
    const target = String(argValue || '').toLowerCase().trim();
    const actual = String(stateValue || '').toLowerCase().trim();
    if (!target || !actual) return false;
    return actual === target;
  }

  /**
   * Trigger run listener: passes when no specific reader was chosen, or when the
   * event came from the chosen reader. Matches on id; the name is only used when
   * the event carries no reader id at all.
   */
  matchesDeviceArg(args, state) {
    const selected = args?.device;
    if (!selected || !selected.id || selected.id === '*') return true;
    if (state?.deviceId) return String(state.deviceId) === String(selected.id);
    return BioStarApp.exactMatch(selected.name, state?.device);
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

  /**
   * The client leaves unnamed rows blank; the fallback name is translated here.
   */
  withFallbackNames(rows, key) {
    return rows.map((r) => (r.name ? r : { ...r, name: this.homey.__(key, { id: r.id }) }));
  }

  async autocompleteDevices(query) {
    let devices = [];
    try {
      devices = await this.cachedList('devices',
        async () => this.withFallbackNames(await this.client.listDevices(), 'flow.deviceFallback'));
    } catch (err) {
      this.addLog(`Could not load reader list: ${err.message}`, 'WARN');
    }
    return BioStarApp.filterByName([{ id: '*', name: this.homey.__('flow.anyReader') }, ...devices], query);
  }

  async autocompleteDoors(query) {
    try {
      const doors = await this.cachedList('doors',
        async () => this.withFallbackNames(await this.client.listDoors(), 'flow.doorFallback'));
      return BioStarApp.filterByName(doors, query);
    } catch (err) {
      this.addLog(`Could not load door list: ${err.message}`, 'WARN');
      // Surfaced in the Flow editor so the cause is visible.
      throw new Error(this.describeError(err));
    }
  }

  /**
   * User-facing text for an error. Client errors carry a code that maps to a
   * locale key; anything else (a network error from Node itself) has no
   * translation and keeps its own message. A wrapped cause is translated too.
   */
  describeError(err) {
    if (!(err instanceof BiostarError)) return (err && err.message) || String(err);
    const params = { ...err.params };
    if (err.cause) params.reason = this.describeError(err.cause);
    const key = `errors.client.${err.code}`;
    const text = this.homey.__(key, params);
    return text && text !== key ? text : err.message;
  }

  // ---------------------------------------------------------------------------
  // Client lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Applies display-only settings to the running client without reconnecting.
   */
  applyCosmeticSettings() {
    const wasHour12 = this.hour12;
    const wasLogUserNames = this.logUserNames;
    this.logUserNames = this.homey.settings.get('biostar_log_usernames') !== false;
    this.hour12 = this.resolveHour12();

    if (this.logUserNames !== wasLogUserNames) {
      this.addLog(`Activity log user names ${this.logUserNames ? 'shown' : 'hidden'}.`, 'INFO');
    }
    if (this.hour12 !== wasHour12) {
      this.addLog(`Activity log clock switched to ${this.hour12 ? '12' : '24'}-hour format.`, 'INFO');
    }
    this.initPersistentLog().catch((err) => this.logError(`Persistent log: ${err.message}`));
  }

  /**
   * Whether to show a 12-hour clock.
   *
   * An explicit choice wins, and wins in both directions: the checkbox has to be
   * able to turn a 24-hour clock back into a 12-hour one, not only force 24 hours
   * on. Treating it as an override of the language default made it a no-op on a
   * Dutch or French Homey, where 24 hours is already what you get.
   *
   * Until a choice is made the clock follows Homey's language. Resolved once per
   * settings change rather than per log line, since it cannot change without one.
   */
  resolveHour12() {
    const chosen = this.homey.settings.get('biostar_clock_24h');
    if (typeof chosen === 'boolean') return !chosen;

    let language = 'en';
    try {
      language = this.homey.i18n.getLanguage() || 'en';
    } catch (_) { /* fall back to English */ }
    return HOUR12_LANGUAGES.has(String(language).slice(0, 2).toLowerCase());
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
      this.renumberLogs();
    }
    this.addLog(`Persistent log turned on; ${stored.length} stored line(s) restored.`, 'INFO');
  }

  /**
   * Single place where a BiostarClient is built and wired up.
   */
  createClient(carried = null) {
    this.listCache = {}; // reader/door lists belong to the previous connection
    const client = new BiostarClient({
      ...this.getBiostarConfig(),
      log: (...args) => {
        const msg = args.join(' ');
        this.log(msg);
        this.addLog(msg, 'INFO');
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
    const problem = this.configProblem();
    this.configError = null;
    if (problem === 'incomplete') {
      this.clearDisconnectAlert();
      this.log('BioStar 2 credentials/host not fully configured yet. Please configure in App Settings.');
      this.addLog('Credentials/host not fully configured yet. Please configure in App Settings.', 'WARN');
      return;
    }
    if (problem === 'invalidHost') {
      // No reconnect loop against a URL that can never work; the settings page
      // shows the reason instead.
      this.configError = this.homey.__('errors.invalidHost');
      this.addLog('Host URL must start with http:// or https://. Not connecting.', 'WARN');
      this.handleStatusChange('CONFIG_ERROR');
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
    // The discovered-event registry outlives the client, otherwise saving a
    // setting (which rebuilds the client) would wipe the list you just used.
    // Taken before destroy(), which clears the map in place.
    let carried = null;
    this.configError = null; // re-evaluated by startClient() below
    if (this.client) {
      carried = new Map(this.client.eventTypes);
      await this.stopClient(this.client);
      this.client.destroy();
    }
    this.client = this.createClient(carried);
    await this.startClient();
  }

  /**
   * Stops a client on purpose. stop() always reports DISCONNECTED; the flag
   * keeps that from arming the "connection lost" alert. A real failure of the
   * client started next still arms it.
   */
  async stopClient(client) {
    this.stoppingOnPurpose = true;
    try {
      await client.stop();
    } catch (_) {
      /* already stopped */
    } finally {
      this.stoppingOnPurpose = false;
    }
  }

  /**
   * 'incomplete' when host, user or password is missing, 'invalidHost' when the
   * host has no http(s) scheme, otherwise null.
   */
  configProblem() {
    const host = BioStarApp.normaliseHost(this.homey.settings.get('biostar_host'));
    if (!host || !this.homey.settings.get('biostar_user') || !this.homey.settings.get('biostar_password')) {
      return 'incomplete';
    }
    if (!/^https?:\/\//i.test(host)) return 'invalidHost';
    return null;
  }

  clearDisconnectAlert() {
    // Connected again (or nothing to warn about): the next outage warns anew.
    this.disconnectAlerted = false;
    if (this.disconnectAlertTimer) {
      this.homey.clearTimeout(this.disconnectAlertTimer);
      this.disconnectAlertTimer = null;
    }
  }

  handleStatusChange(status) {
    if (status !== this.connectionStatus) {
      this.connectionStatus = status;
      this.log(`BioStar 2 Connection status changed to: ${status}`);
      this.addLog(`Connection status changed to: ${status}`, 'STATUS');

      // Pushed to the settings page instead of persisted, so a flapping link
      // does not repeatedly write to Homey's settings store.
      const pushed = this.homey.api.realtime('status', { status, stats: this.getStats() });
      if (pushed && typeof pushed.catch === 'function') {
        pushed.catch((err) => this.error(`Realtime push failed: ${err.message}`));
      }
    }

    // An incomplete or invalid configuration is not an outage to warn about.
    if (status === 'CONNECTED' || this.configProblem()) {
      this.clearDisconnectAlert();
      return;
    }

    // Evaluated on every failure, not only on a status change: after a
    // deliberate stop the status already reads DISCONNECTED, and a failing
    // reconnect must still be able to arm the alert.
    if (this.unloading || this.stoppingOnPurpose) return;

    // Only warn once the outage has lasted long enough to matter, and only once
    // per outage: every failed reconnect lands here again.
    if (!this.disconnectAlertTimer && !this.disconnectAlerted) {
      this.disconnectAlertTimer = this.homey.setTimeout(() => {
        this.disconnectAlertTimer = null;
        if (this.unloading || this.connectionStatus === 'CONNECTED' || this.configProblem()) return;
        this.disconnectAlerted = true;
        this.homey.notifications.createNotification({
          excerpt: this.homey.__('notifications.connectionLost'),
        }).catch((err) => this.logError(`Notification failed: ${err.message}`));
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
      biostarHost: BioStarApp.normaliseHost(this.homey.settings.get('biostar_host')),
      wsUri: this.homey.settings.get('biostar_ws_uri') || '',
      loginUser: this.homey.settings.get('biostar_user') || '',
      password: this.homey.settings.get('biostar_password') || '',
      // Verify unless the user explicitly turned it off; never stored means on.
      rejectUnauthorized: this.homey.settings.get('biostar_reject_unauthorized') !== false,
      ignoreEvents: BioStarApp.toList(ignoreRaw, EventMapper.DEFAULT_IGNORE_EVENTS),
      ignoreEventSubstrings: BioStarApp.toList(substringRaw, []),
      heartbeatMs: BioStarApp.toMs(this.homey.settings.get('biostar_heartbeat_s'), 30, 5, 300),
      reconnectMinMs: BioStarApp.toMs(this.homey.settings.get('biostar_reconnect_min_s'), 2, 1, 60),
      reconnectMaxMs: BioStarApp.toMs(this.homey.settings.get('biostar_reconnect_max_s'), 60, 5, 900),
      userCacheMax: 200,
      userCacheTtlMs: 3600000,
    };
  }

  /**
   * Trimmed, without trailing slashes, so paths can be appended to it.
   */
  static normaliseHost(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  /**
   * Comparable form of a host URL: scheme and host name are case-insensitive.
   */
  static hostKey(value) {
    const host = BioStarApp.normaliseHost(value);
    try {
      const url = new URL(host);
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch (_) {
      return host.toLowerCase();
    }
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
      // The effective clock, so the checkbox can show what is actually in force
      // rather than only whether a preference has been stored.
      clock24h: !this.hour12,
      // Translated reason the client is not connecting at all, or null.
      configError: this.configError,
    };
  }

  /**
   * Adds an entry to the in-memory log buffer.
   */
  addLog(msg, type = 'INFO') {
    if (!this.logs) this.logs = [];
    const text = typeof msg === 'string' ? msg.replace(/\[BioStarClient\]\s*/, '') : JSON.stringify(msg);

    // Stored as data, not as a rendered line: the settings page formats the
    // timestamp itself, so switching the clock format re-renders the whole log
    // instead of only applying to entries written from then on.
    const entry = {
      at: Date.now(),
      type,
      message: text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text,
    };

    this.logSeq += 1;
    entry.seq = this.logSeq;
    this.logs.push(entry);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);

    // The buffer above is capped at LOG_LIMIT; the file keeps the older entries.
    if (this.logStore) this.logStore.append(entry);
  }

  /**
   * Numbers the buffer afresh in a new epoch, after it was cleared or rebuilt
   * from flash, so the settings page reloads it instead of appending.
   */
  renumberLogs() {
    this.logSeq = 0;
    for (const entry of this.logs) {
      this.logSeq += 1;
      entry.seq = this.logSeq;
    }
    // Strictly increasing, also for two rebuilds within one millisecond.
    this.logEpoch = Math.max(Date.now(), this.logEpoch + 1);
  }

  /**
   * Reports a failure to Homey's own log and to the activity log. Several error
   * paths used to call this.error() alone, which meant the log a person actually
   * reads never mentioned them.
   */
  logError(msg) {
    this.error(msg);
    this.addLog(msg, 'ERROR');
  }

  /**
   * Returns log entries for the settings UI. `since` lets the page fetch only
   * what it has not seen yet instead of the whole buffer every poll.
   */
  getLogs(since = 0, epoch = null) {
    const logs = this.logs || [];
    // Another epoch means the page holds lines that no longer exist: send all.
    const reset = String(epoch) !== String(this.logEpoch);
    const start = !reset && Number.isFinite(Number(since)) ? Math.max(0, Number(since)) : 0;
    return {
      epoch: this.logEpoch,
      reset,
      total: this.logSeq,
      entries: logs.filter((e) => e.seq > start),
      status: this.connectionStatus,
      // The page renders the timestamps, so it needs to know which clock to use.
      hour12: this.hour12,
      stats: this.getStats(),
    };
  }

  /**
   * Clears in-memory log buffer.
   */
  async clearLogs() {
    this.logs = [];
    this.renumberLogs();
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
  async testConnection(config) {
    const body = config || {};
    const storedHost = BioStarApp.normaliseHost(this.homey.settings.get('biostar_host'));
    const storedUser = String(this.homey.settings.get('biostar_user') || '').trim();
    const host = BioStarApp.normaliseHost(body.biostarHost) || storedHost;
    const user = String(body.loginUser || '').trim() || storedUser;
    const rejectUnauthorized = body.rejectUnauthorized !== false;

    // The stored password may only go to the stored host as the stored user.
    // Otherwise any caller of this endpoint could have it sent to a host of
    // their choosing.
    let password = typeof body.password === 'string' ? body.password : '';
    if (!password && host && user) {
      const sameTarget = BioStarApp.hostKey(host) === BioStarApp.hostKey(storedHost) && user === storedUser;
      if (!sameTarget) throw new Error(this.homey.__('errors.passwordRequired'));
      password = this.homey.settings.get('biostar_password') || '';
    }

    if (!host || !user || !password) {
      throw new Error(this.homey.__('errors.incompleteCredentials'));
    }
    if (!/^https?:\/\//i.test(host)) {
      throw new Error(this.homey.__('errors.invalidHost'));
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
      // The log stays English; the page gets the translated text.
      const logChecks = [];
      const checks = [];
      for (const [label, key, fn] of [['Users', 'test.users', () => testClient.probeUsers()],
        ['Doors', 'test.doors', () => testClient.listDoors()]]) {
        const name = this.homey.__(key);
        try {
          await fn();
          logChecks.push(`${label}: OK`);
          checks.push(this.homey.__('test.checkOk', { label: name }));
        } catch (err) {
          logChecks.push(`${label}: unavailable`);
          checks.push(this.homey.__('test.checkUnavailable', { label: name }));
        }
      }

      const session = String(sessionId).slice(-4);
      this.addLog(`Connected to BioStar 2 (session ...${session}). ${logChecks.join(' | ')}`, 'TEST_SUCCESS');
      return {
        success: true,
        message: this.homey.__('test.connected', { session, checks: checks.join(' | ') }),
      };
    } catch (err) {
      this.addLog(`Test connection failed: ${err.message}`, 'TEST_ERROR');
      return { success: false, message: this.describeError(err) };
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
    const who = this.logUserNames ? (evt.user || 'N/A') : '<hidden>';
    // AUTH, not INFO: an authentication is the one thing in this log a person
    // actually comes looking for, so it has to be filterable on its own.
    this.addLog(`${evt.type} | User: ${who} | Device: '${evt.device}' | ${evt.rawName}`, 'AUTH');

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
    }, state).catch((err) => this.logError(`Flow trigger 'event_received' failed: ${err.message}`));

    if (evt.type === 'success') {
      this.triggerAuthSucceeded.trigger({
        ...userTokens, event_name: evt.rawName, timestamp: evt.timestamp,
      }, state).catch((err) => this.logError(`Flow trigger 'auth_succeeded' failed: ${err.message}`));
    } else if (evt.type === 'access_denied') {
      this.triggerAccessDenied.trigger({
        ...userTokens, event_name: evt.rawName, timestamp: evt.timestamp,
      }, state).catch((err) => this.logError(`Flow trigger 'access_denied' failed: ${err.message}`));
    } else if (evt.type === 'identification_fail') {
      this.triggerIdentificationFailed.trigger({
        device: evt.device, event_name: evt.rawName, timestamp: evt.timestamp,
      }, { device: evt.device, deviceId: evt.deviceId })
        .catch((err) => this.logError(`Flow trigger 'identification_failed' failed: ${err.message}`));
    }
  }

  /**
   * Clean up on uninitialization.
   */
  async onUninit() {
    // Set first: stopping the client below reports DISCONNECTED, which must
    // not arm a "connection lost" alert for an app that is going away.
    this.unloading = true;
    if (this.onSettingsSet) this.homey.settings.removeListener('set', this.onSettingsSet);
    if (this.restartDebounceTimer) this.homey.clearTimeout(this.restartDebounceTimer);
    this.clearDisconnectAlert();
    if (this.client) {
      await this.stopClient(this.client);
      this.client.destroy();
    }
    // Last, so anything the shutdown itself logged still reaches flash.
    if (this.logStore) await this.logStore.destroy().catch(() => {});
  }

}

module.exports = BioStarApp;
