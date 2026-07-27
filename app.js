'use strict';

const Homey = require('homey');
const BiostarClient = require('./lib/BiostarClient');

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
    this.addLog('Initializing BioStar 2 Community Homey App...', 'INFO');

    // 1. Initialize Flow Card Triggers
    this.triggerAuthSucceeded = this.homey.flow.getTriggerCard('auth_succeeded');
    this.triggerIdentificationFailed = this.homey.flow.getTriggerCard('identification_failed');
    this.triggerAccessDenied = this.homey.flow.getTriggerCard('access_denied');
    this.triggerEventReceived = this.homey.flow.getTriggerCard('event_received');

    // 2. Initialize Flow Card Conditions (AND Cards)
    this.homey.flow.getConditionCard('is_connected')
      .registerRunListener(async () => {
        return Boolean(this.client && this.client.isConnected);
      });

    this.homey.flow.getConditionCard('department_is')
      .registerRunListener(async (args, state) => {
        const targetDept = (args.department || '').toLowerCase().trim();
        const eventDept = (state?.department || '').toLowerCase().trim();
        if (!targetDept || !eventDept) return false;
        return eventDept.includes(targetDept) || targetDept.includes(eventDept);
      });

    this.homey.flow.getConditionCard('user_is')
      .registerRunListener(async (args, state) => {
        const targetUser = (args.user || '').toLowerCase().trim();
        const eventUser = (state?.user || '').toLowerCase().trim();
        if (!targetUser || !eventUser) return false;
        return eventUser.includes(targetUser) || targetUser.includes(eventUser);
      });

    this.homey.flow.getConditionCard('user_group_is')
      .registerRunListener(async (args, state) => {
        const targetGroup = (args.user_group || '').toLowerCase().trim();
        const eventGroup = (state?.user_group || '').toLowerCase().trim();
        if (!targetGroup || !eventGroup) return false;
        return eventGroup.includes(targetGroup) || targetGroup.includes(eventGroup);
      });

    this.homey.flow.getConditionCard('device_is')
      .registerRunListener(async (args, state) => {
        const targetDevice = (args.device || '').toLowerCase().trim();
        const eventDevice = (state?.device || '').toLowerCase().trim();
        if (!targetDevice || !eventDevice) return false;
        return eventDevice.includes(targetDevice) || targetDevice.includes(eventDevice);
      });

    // 3. Initialize Flow Card Actions (THEN Cards)
    this.homey.flow.getActionCard('reconnect')
      .registerRunListener(async () => {
        this.log('[Flow Action] Manual BioStar 2 reconnect triggered by Flow Action Card.');
        this.addLog('Manual BioStar 2 reconnect triggered by Flow Action Card.', 'ACTION');
        await this.restartClient();
        return true;
      });

    // 4. Load settings
    const config = this.getBiostarConfig();

    // 5. Initialize BiostarClient
    this.client = new BiostarClient({
      ...config,
      log: (...args) => {
        const msg = args.join(' ');
        this.log(msg);
        this.addLog(msg, 'INFO');
      },
      errorLog: (...args) => {
        const msg = args.join(' ');
        this.error(msg);
        this.addLog(msg, 'ERROR');
      }
    });

    // 6. Register event handlers from BiostarClient
    this.client.on('event', (evt) => this.handleBioStarEvent(evt));
    this.client.on('status', (status) => {
      this.log(`BioStar 2 Connection status changed to: ${status}`);
      this.addLog(`Connection status changed to: ${status}`, 'STATUS');
      this.homey.settings.set('connection_status', status);
    });

    // 7. Watch for App Settings changes from the Homey Mobile / Web App UI (Debounced)
    this.homey.settings.on('set', (key) => {
      if (key.startsWith('biostar_')) {
        if (this.restartDebounceTimer) clearTimeout(this.restartDebounceTimer);
        this.restartDebounceTimer = setTimeout(() => {
          this.log('BioStar configuration updated in settings. Restarting client...');
          this.addLog('Configuration updated in settings. Restarting client...', 'INFO');
          this.restartClient();
        }, 500);
      }
    });

    // 8. Start the client connection if configured
    if (config.password && config.biostarHost && config.loginUser) {
      this.client.start().catch(err => {
        this.error(`Failed to start BioStar client on startup: ${err.message}`);
        this.addLog(`Failed to start BioStar client: ${err.message}`, 'ERROR');
      });
    } else {
      this.log('BioStar 2 credentials/host not fully configured yet. Please configure in App Settings.');
      this.addLog('Credentials/host not fully configured yet. Please configure in App Settings.', 'WARN');
    }

    this.log('BioStar 2 Community Homey App initialized successfully.');
    this.addLog('App initialized successfully.', 'INFO');
  }

  /**
   * Adds an entry to the in-memory log buffer.
   */
  addLog(msg, type = 'INFO') {
    if (!this.logs) this.logs = [];
    const timestamp = new Date().toLocaleTimeString();
    const cleanMsg = typeof msg === 'string' ? msg.replace(/\[BioStarClient\]\s*/, '') : JSON.stringify(msg);
    this.logs.push(`[${timestamp}] [${type}] ${cleanMsg}`);
    if (this.logs.length > 100) {
      this.logs.shift();
    }
  }

  /**
   * Returns recent log entries for the settings UI.
   */
  getLogs() {
    return this.logs || [];
  }

  /**
   * Clears in-memory log buffer.
   */
  clearLogs() {
    this.logs = [];
    this.addLog('Log buffer cleared by user.', 'INFO');
    return { success: true };
  }

  /**
   * Reads settings from Homey.ManagerSettings.
   */
  getBiostarConfig() {
    return {
      biostarHost: this.homey.settings.get('biostar_host') || '',
      wsUri: this.homey.settings.get('biostar_ws_uri') || '',
      loginUser: this.homey.settings.get('biostar_user') || '',
      password: this.homey.settings.get('biostar_password') || '',
      rejectUnauthorized: this.homey.settings.get('biostar_reject_unauthorized') ?? false,
      ignoreEvents: this.homey.settings.get('biostar_ignore_events') || ['LOCKED', 'UNLOCKED', 'ENROLL_SUCCESS', 'PARTIAL_UPDATE_SUCCESS', 'TIME_SET']
    };
  }

  /**
   * Tests BioStar 2 REST API authentication with provided credentials.
   */
  async testConnection(config) {
    const host = config.biostarHost || this.homey.settings.get('biostar_host');
    const user = config.loginUser || this.homey.settings.get('biostar_user');
    const password = config.password || this.homey.settings.get('biostar_password');
    const rejectUnauthorized = config.rejectUnauthorized ?? this.homey.settings.get('biostar_reject_unauthorized') ?? false;

    if (!host || !user || !password) {
      throw new Error('Host URL, Username, and Password must be provided.');
    }

    this.addLog(`Testing connection to ${host} as user '${user}'...`, 'TEST');

    const testClient = new BiostarClient({
      biostarHost: host,
      loginUser: user,
      password: password,
      rejectUnauthorized: rejectUnauthorized,
      log: (...args) => this.log('[TestClient]', ...args),
      errorLog: (...args) => this.error('[TestClient]', ...args)
    });

    try {
      const sessionId = await testClient.login();
      const successMsg = `Successfully authenticated with BioStar 2! Session ID: ...${String(sessionId).slice(-4)}`;
      this.addLog(successMsg, 'TEST_SUCCESS');
      return {
        success: true,
        message: successMsg
      };
    } catch (err) {
      this.addLog(`Test connection failed: ${err.message}`, 'TEST_ERROR');
      return {
        success: false,
        message: err.message
      };
    }
  }

  /**
   * Handles processed events from BiostarClient and triggers native Homey Flows.
   */
  handleBioStarEvent(evt) {
    const logMsg = `[Flow Dispatch] Event: ${evt.type} | User: '${evt.user}' (ID: ${evt.userId}) | Group: '${evt.group}' | Email: '${evt.email}' | Dept: '${evt.department}' | Title: '${evt.title}' | Phone: '${evt.telephone}' | LoginID: '${evt.loginId}' | Device: '${evt.device}'`;
    this.log(logMsg);
    this.addLog(logMsg, 'EVENT');

    const tokens = {
      user: evt.user,
      device: evt.device,
      user_id: evt.userId,
      user_group: evt.group,
      email: evt.email,
      title: evt.title,
      department: evt.department,
      telephone: evt.telephone,
      login_id: evt.loginId
    };

    const state = {
      user: evt.user,
      device: evt.device,
      department: evt.department,
      user_group: evt.group
    };

    // Trigger generic "BioStar 2 event received" flow card
    this.triggerEventReceived.trigger(tokens, state).catch(this.error);

    // Trigger specific flow cards based on event type
    if (evt.type === 'success') {
      this.triggerAuthSucceeded.trigger({
        ...tokens,
        event_name: evt.rawName,
        timestamp: evt.timestamp
      }, state).catch(this.error);
    } else if (evt.type === 'access_denied') {
      this.triggerAccessDenied.trigger({
        ...tokens,
        event_name: evt.rawName,
        timestamp: evt.timestamp
      }, state).catch(this.error);
    } else if (evt.type === 'identification_fail') {
      this.triggerIdentificationFailed.trigger({
        device: evt.device,
        event_name: evt.rawName,
        timestamp: evt.timestamp
      }, { device: evt.device }).catch(this.error);
    }
  }

  /**
   * Restarts the BioStar client when settings are updated.
   */
  async restartClient() {
    if (this.client) {
      await this.client.stop();
    }
    const newConfig = this.getBiostarConfig();
    this.client = new BiostarClient({
      ...newConfig,
      log: (...args) => {
        const msg = args.join(' ');
        this.log(msg);
        this.addLog(msg, 'INFO');
      },
      errorLog: (...args) => {
        const msg = args.join(' ');
        this.error(msg);
        this.addLog(msg, 'ERROR');
      }
    });
    this.client.on('event', (evt) => this.handleBioStarEvent(evt));
    this.client.on('status', (status) => {
      this.addLog(`Connection status changed to: ${status}`, 'STATUS');
      this.homey.settings.set('connection_status', status);
    });

    if (newConfig.password && newConfig.biostarHost && newConfig.loginUser) {
      this.client.start().catch(err => this.error(`Error restarting client: ${err.message}`));
    }
  }

  /**
   * Clean up on uninitialization.
   */
  async onUninit() {
    if (this.client) {
      await this.client.stop();
    }
  }

}

module.exports = BioStarApp;