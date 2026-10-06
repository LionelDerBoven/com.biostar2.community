'use strict';

// Placeholder shown instead of the stored password, so the real secret is
// never sent to the settings page. Saving only overwrites it when changed.
const PASSWORD_MASK = '••••••••••';
const LOG_POLL_MS = 3000;

// Which log tag belongs to which filter option. Anything not listed here falls
// into 'info', so an unrecognised tag can never silently disappear from the
// view — the worst case is that it shows up in the broadest category.
const LOG_CATEGORIES = {
  AUTH: 'auth',
  ACTION: 'actions',
  ERROR: 'errors',
  WARN: 'errors',
  TEST_ERROR: 'errors',
};

// Categories that get a tinted row, so the eye finds them without reading.
const ROW_TINT = { auth: 'level-auth', actions: 'level-action', errors: 'level-error' };

function onHomeyReady(Homey) {
  Homey.ready();

  const $ = (id) => document.getElementById(id);

  /**
   * Homey returns the key itself when a translation is missing. Falling back to
   * the markup's own text keeps the page readable instead of showing a key.
   */
  function t(key, fallback = '') {
    const translated = Homey.__(key);
    return !translated || translated === key ? fallback : translated;
  }

  /**
   * Renders a log line stored as a locale key plus parameters, in this page's
   * language. Same rules as lib/LogText.js render(): `__name__` placeholders, a
   * nested { key, params, text } parameter rendered in turn with `text` as its
   * fallback. Null when the key has no translation.
   */
  function renderLogText(key, params, depth = 0) {
    const template = typeof key === 'string' ? t(key, null) : null;
    if (typeof template !== 'string') return null;
    return template.replace(/__(\w+)__/g, (_, name) => {
      const value = params ? params[name] : undefined;
      if (value === undefined || value === null) return '';
      if (typeof value !== 'object') return String(value);
      const nested = depth < 3 ? renderLogText(value.key, value.params, depth + 1) : null;
      return nested !== null ? nested : String(value.text || '');
    });
  }

  /** A log entry's text: translated when it has a key, else as stored. */
  function logMessage(entry) {
    const text = entry.key ? renderLogText(entry.key, entry.params) : null;
    return text !== null ? text : entry.message;
  }

  /**
   * Translates the page in place. The English text stays in index.html so the
   * markup is readable on its own and survives a missing locale file.
   */
  function applyTranslations() {
    document.querySelectorAll('[data-t]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-t'), el.textContent.trim());
    });
    document.querySelectorAll('[data-t-placeholder]').forEach((el) => {
      el.placeholder = t(el.getAttribute('data-t-placeholder'), el.placeholder);
    });
  }

  function apiGet(path) {
    return new Promise((resolve) => {
      Homey.api('GET', path, (err, res) => resolve(err ? null : res));
    });
  }

  const els = {
    host: $('biostar_host'),
    ws: $('biostar_ws_uri'),
    user: $('biostar_user'),
    password: $('biostar_password'),
    ssl: $('biostar_reject_unauthorized'),
    ignoreSubstrings: $('biostar_ignore_substrings'),
    heartbeat: $('biostar_heartbeat_s'),
    reconnectMin: $('biostar_reconnect_min_s'),
    reconnectMax: $('biostar_reconnect_max_s'),
    logUserNames: $('biostar_log_usernames'),
    clock24h: $('biostar_clock_24h'),
    persistLogs: $('biostar_persist_logs'),
    status: $('connection-status'),
    permWarning: $('perm-warning'),
    configWarning: $('config-warning'),
    testResult: $('test-result'),
    log: $('log'),
    logCount: $('log-count'),
    logFilter: $('log-filter'),
  };

  let logPollTimer = null;
  let logsSeen = 0;
  let logsEpoch = '';
  let logEntries = [];
  let hour12 = false;
  let clockWriting = false;
  let passwordTouched = false;
  // Host and user as saved, so Test Connection knows when the stored password
  // no longer applies (the app only uses it for the saved host and user).
  let savedHost = '';
  let savedUser = '';
  let ignoreSet = new Set(); // exact-match ignores, driven by the table

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getSetting(key, fallback = '') {
    return new Promise((resolve) => {
      Homey.get(key, (err, val) => resolve(err || val === undefined || val === null ? fallback : val));
    });
  }

  function formatDuration(ms) {
    if (!ms || ms < 1000) return '–';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  }

  function formatAgo(timestamp) {
    if (!timestamp) return '–';
    return t('settings.time.ago', '__duration__ ago')
      .replace('__duration__', formatDuration(Date.now() - timestamp));
  }

  /**
   * Same normalisation as the app: trimmed, scheme lower-cased, no trailing
   * slash, and the scheme and host name compared case-insensitively.
   */
  function normaliseHost(value) {
    return String(value || '').trim()
      .replace(/^[a-z][a-z0-9+.-]*:/i, (scheme) => scheme.toLowerCase())
      .replace(/\/+$/, '');
  }

  /** Shows the unencrypted-connection warning while the host is http://. */
  function updatePlainHttpWarning() {
    $('host-plain-http').style.display = /^http:/.test(normaliseHost(els.host.value)) ? '' : 'none';
  }

  function hostKey(value) {
    const host = normaliseHost(value);
    try {
      const url = new URL(host);
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch (_) {
      return host.toLowerCase();
    }
  }

  const STATUS_CLASS = { CONNECTED: 'ok', DISCONNECTED: 'bad', CONFIG_ERROR: 'bad' };

  function renderStatus(status) {
    const key = status || 'UNKNOWN';
    els.status.textContent = t(`settings.status.${key}`, key);
    els.status.className = `status-value ${STATUS_CLASS[status] || ''}`;
  }

  function renderStats(stats) {
    if (!stats) return;
    renderStatus(stats.status);
    $('stat-forwarded').textContent = stats.eventsForwarded ?? 0;
    $('stat-ignored').textContent = stats.eventsIgnored ?? 0;
    $('stat-reconnects').textContent = stats.reconnects ?? 0;
    $('stat-cached').textContent = stats.cachedUsers ?? 0;
    $('stat-uptime').textContent = formatDuration(stats.connectedForMs);
    $('stat-last').textContent = formatAgo(stats.lastEventAt);
    els.permWarning.style.display = stats.profileLookupDisabled ? 'block' : 'none';
    // Already translated by the app.
    els.configWarning.textContent = stats.configError || '';
    els.configWarning.style.display = stats.configError ? 'block' : 'none';
    $('pin-fingerprint').textContent = stats.trustedCertificate || '';
    $('pin-field').style.display = stats.trustedCertificate ? 'block' : 'none';
  }

  function renderEventTypes(rows) {
    const body = $('event-types-body');
    body.textContent = '';

    if (!rows || !rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4; td.className = 'muted';
      td.textContent = t('settings.eventTypes.empty',
        'No events seen yet. They appear here as BioStar 2 sends them.');
      tr.appendChild(td); body.appendChild(tr);
      return;
    }

    rows.forEach((row) => {
      const tr = document.createElement('tr');
      if (ignoreSet.has(row.name)) tr.className = 'is-ignored';

      const name = document.createElement('td');
      name.textContent = row.name; // textContent, never innerHTML
      tr.appendChild(name);

      const count = document.createElement('td');
      count.className = 'num';
      count.textContent = row.count ? String(row.count) : '–';
      tr.appendChild(count);

      const last = document.createElement('td');
      last.className = 'num';
      last.textContent = row.lastAt ? formatAgo(row.lastAt) : '–';
      tr.appendChild(last);

      const cell = document.createElement('td');
      cell.className = 'num';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ignoreSet.has(row.name);
      cb.addEventListener('change', () => {
        if (cb.checked) ignoreSet.add(row.name);
        else ignoreSet.delete(row.name);
        tr.className = cb.checked ? 'is-ignored' : '';
      });
      cell.appendChild(cb);
      tr.appendChild(cell);

      body.appendChild(tr);
    });
  }

  // keepSelection: the page's own ticks and names added by hand win over the
  // saved list, so a refresh before Save does not throw them away.
  function loadEventTypes(keepSelection = false) {
    Homey.api('GET', '/event-types', (err, rows) => {
      if (err) return;
      const list = rows || [];
      if (keepSelection) {
        const listed = new Set(list.map((r) => r.name));
        for (const name of ignoreSet) {
          if (!listed.has(name)) list.push({ name, count: 0, lastAt: null });
        }
      } else {
        ignoreSet = new Set(list.filter((r) => r.ignored).map((r) => r.name));
      }
      renderEventTypes(list);
    });
  }

  function refreshStatus() {
    Homey.api('GET', '/status', (err, stats) => {
      if (!err) renderStats(stats);
    });
  }

  // ---------------------------------------------------------------------------
  // Logs — incremental fetch, only new lines cross the API
  // ---------------------------------------------------------------------------

  function categoryOf(entry) {
    return LOG_CATEGORIES[entry && entry.type] || 'info';
  }

  /**
   * Formats a wall clock time without Intl. Homey's webview cannot be relied on
   * to carry locale data for every language, and a timestamp that silently falls
   * back to another format would be worse than not choosing one.
   */
  function formatTime(at) {
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    const h = d.getHours();
    const rest = `${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (!hour12) return `${pad(h)}:${rest}`;
    return `${h % 12 === 0 ? 12 : h % 12}:${rest} ${h < 12 ? 'AM' : 'PM'}`;
  }

  /**
   * Renders from the entries the page already holds. Two consequences worth
   * having: changing the filter or the clock format costs no round trip, and
   * nothing is discarded on the way in, so a category can always be shown again.
   *
   * `follow` keeps the view pinned to the newest entry when it already was —
   * scrolling back to read something must not be undone by the next poll.
   */
  function renderLogs(follow = true) {
    const wanted = els.logFilter.value;
    const visible = wanted === 'all'
      ? logEntries
      : logEntries.filter((entry) => categoryOf(entry) === wanted);

    const atBottom = els.log.scrollHeight - els.log.clientHeight <= els.log.scrollTop + 30;

    els.log.textContent = '';

    if (!visible.length) {
      const li = document.createElement('li');
      li.className = 'log-empty';
      li.textContent = logEntries.length
        ? t('settings.logs.allFiltered', 'Every entry is hidden by the filter above.')
        : t('settings.logs.empty', 'No logs available yet.');
      els.log.appendChild(li);
    }

    visible.forEach((entry) => {
      const li = document.createElement('li');
      const tint = ROW_TINT[categoryOf(entry)];
      if (tint) li.className = tint;

      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = formatTime(entry.at);
      li.appendChild(time);

      const msg = document.createElement('span');
      msg.className = 'log-msg';
      msg.textContent = logMessage(entry); // textContent, never innerHTML
      li.appendChild(msg);

      els.log.appendChild(li);
    });

    const suffix = t('settings.logs.shownSuffix', 'shown');
    els.logCount.textContent = visible.length === logEntries.length
      ? `${visible.length} ${suffix}`
      : `${visible.length} / ${logEntries.length} ${suffix}`;

    if (!follow || atBottom) els.log.scrollTop = els.log.scrollHeight;
  }

  function fetchLogs(reset = false) {
    if (reset) {
      logsSeen = 0; logEntries = []; logsEpoch = '';
    }
    Homey.api('GET', `/logs?since=${logsSeen}&epoch=${encodeURIComponent(logsEpoch)}`, (err, res) => {
      if (err || !res) return;

      // The app cleared or rebuilt its buffer (or restarted): what this page
      // holds is gone, and res.entries is the whole buffer again.
      if (res.reset) logEntries = [];
      logsEpoch = String(res.epoch);

      // The app owns the clock, so the page never has to know Homey's language.
      // The checkbox is set from the effective value, not from whether a
      // preference happens to be stored — otherwise it reads "off" while the log
      // plainly shows 24-hour times.
      let clockChanged = false;
      if (!clockWriting) {
        const nextHour12 = res.hour12 === true;
        clockChanged = nextHour12 !== hour12;
        hour12 = nextHour12;
        els.clock24h.checked = !hour12;
      }

      if (Array.isArray(res.entries) && res.entries.length) {
        logEntries = logEntries.concat(res.entries).slice(-200);
        logsSeen = res.total;
        renderLogs();
      } else if (res.reset || clockChanged || !logEntries.length) {
        logsSeen = res.total;
        renderLogs();
      }

      renderStats(res.stats);
    });
  }

  // ---------------------------------------------------------------------------
  // Tabs — logs are polled only while their pane is visible
  // ---------------------------------------------------------------------------

  function startLogPolling() {
    if (logPollTimer) return;
    fetchLogs();
    logPollTimer = setInterval(fetchLogs, LOG_POLL_MS);
  }

  function stopLogPolling() {
    if (!logPollTimer) return;
    clearInterval(logPollTimer);
    logPollTimer = null;
  }

  els.password.addEventListener('input', () => {
    passwordTouched = true;
  });
  els.host.addEventListener('input', updatePlainHttpWarning);

  $('manual-ignore-add').addEventListener('click', () => {
    const name = $('manual-ignore-input').value.trim();
    if (!name) return;
    ignoreSet.add(name);
    $('manual-ignore-input').value = '';
    loadEventTypes(true);
  });

  async function loadSettings() {
    els.host.value = await getSetting('biostar_host');
    els.ws.value = await getSetting('biostar_ws_uri');
    els.user.value = await getSetting('biostar_user');
    savedHost = els.host.value;
    savedUser = els.user.value.trim();
    updatePlainHttpWarning();
    // Verification is on unless it was explicitly turned off.
    els.ssl.checked = (await getSetting('biostar_reject_unauthorized', true)) !== false;

    // Ask the app whether a password exists rather than reading the setting:
    // the page only needs the boolean, and the secret never leaves Homey.
    const status = await apiGet('/status');
    const hasPassword = Boolean(status && status.hasPassword);
    els.password.value = hasPassword ? PASSWORD_MASK : '';
    $('password-hint').textContent = hasPassword
      ? t('settings.connection.passwordStored', 'A password is stored. Leave unchanged to keep it.')
      : t('settings.connection.passwordEmpty', 'No password stored yet.');

    const toText = (v) => (Array.isArray(v) ? v.join('\n') : (v || ''));
    els.ignoreSubstrings.value = toText(await getSetting('biostar_ignore_substrings'));
    els.heartbeat.value = await getSetting('biostar_heartbeat_s');
    els.reconnectMin.value = await getSetting('biostar_reconnect_min_s');
    els.reconnectMax.value = await getSetting('biostar_reconnect_max_s');
    els.logUserNames.checked = (await getSetting('biostar_log_usernames', true)) !== false;

    // Both log options come from the app's effective state rather than the raw
    // settings, so each box shows what is actually in force.
    els.clock24h.checked = status ? status.clock24h === true : false;
    els.persistLogs.checked = status ? status.persistLogs === true : false;
    hour12 = !els.clock24h.checked;

    const savedFilter = await getSetting('log_filter', 'all');
    if ([...els.logFilter.options].some((o) => o.value === savedFilter)) {
      els.logFilter.value = savedFilter;
    }

    refreshStatus();
  }

  function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetPaneId = btn.getAttribute('data-tab');

        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));

        btn.classList.add('active');
        $(targetPaneId).classList.add('active');

        if (targetPaneId === 'pane-logs') startLogPolling();
        else stopLogPolling();

        if (targetPaneId === 'pane-advanced') loadEventTypes(true);
      });
    });

    // Stop polling when the page is hidden, resume when it comes back.
    document.addEventListener('visibilitychange', () => {
      const logsVisible = $('pane-logs').classList.contains('active');
      if (document.hidden) stopLogPolling();
      else if (logsVisible) startLogPolling();
    });
  }

  // Live status pushed by the app instead of polled.
  Homey.on('status', (payload) => {
    if (!payload) return;
    renderStatus(payload.status);
    renderStats(payload.stats);
  });

  // Filtering is a view choice, so it is applied to what the page already has
  // and jumps back to the newest entry rather than leaving you mid-history.
  // Remembered so the choice survives closing the settings page.
  // Deliberately not prefixed 'biostar_': the app restarts its BioStar client
  // when a 'biostar_' setting it does not recognise changes, and a view
  // preference must never cost the event stream a reconnect.
  els.logFilter.addEventListener('change', () => {
    renderLogs(false);
    Homey.set('log_filter', els.logFilter.value, () => {});
  });

  // The two log options sit with the log and save on the spot: there is no Save
  // button on this tab, and both take effect immediately.
  els.clock24h.addEventListener('change', () => {
    // Applied in both directions at once, so the log reformats under the cursor
    // instead of waiting for a poll. clockWriting stops the poll in flight from
    // reading back the old value and flipping the box while the write lands.
    clockWriting = true;
    hour12 = !els.clock24h.checked;
    renderLogs(false);
    Homey.set('biostar_clock_24h', els.clock24h.checked, () => {
      clockWriting = false;
      fetchLogs();
    });
  });

  els.persistLogs.addEventListener('change', () => {
    Homey.set('biostar_persist_logs', els.persistLogs.checked, () => {});
  });

  $('refresh-logs-button').addEventListener('click', () => fetchLogs(true));

  $('clear-logs-button').addEventListener('click', () => {
    Homey.api('POST', '/clear-logs', {}, (err) => {
      if (!err) fetchLogs(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  function currentPassword() {
    return passwordTouched && els.password.value !== PASSWORD_MASK ? els.password.value : undefined;
  }

  $('test-button').addEventListener('click', () => {
    const payload = {
      biostarHost: normaliseHost(els.host.value),
      wsUri: els.ws.value.trim(),
      loginUser: els.user.value.trim(),
      rejectUnauthorized: els.ssl.checked,
    };
    const pw = currentPassword();
    if (pw) payload.password = pw;

    // The stored password is only valid for the saved host and user. Ask for it
    // here rather than send a request the app is going to refuse.
    const targetChanged = hostKey(payload.biostarHost) !== hostKey(savedHost) || payload.loginUser !== savedUser;
    if (!pw && targetChanged) {
      els.testResult.textContent = `✖ ${t('errors.passwordRequired',
        'Enter the password to test a host or user other than the saved one. The stored password is only sent to the saved host.')}`;
      els.testResult.style.color = '#d9534f';
      return;
    }

    els.testResult.textContent = t('settings.messages.testing', 'Testing connection to BioStar 2...');
    els.testResult.style.color = '#555';

    Homey.api('POST', '/test', payload, (err, res) => {
      if (err) {
        const label = t('settings.messages.testError', 'Error testing connection:');
        els.testResult.textContent = `✖ ${label} ${err.message || err}`;
        els.testResult.style.color = '#d9534f';
      } else if (res && res.success) {
        els.testResult.textContent = `✓ ${res.message}`;
        els.testResult.style.color = '#5cb85c';
      } else {
        els.testResult.textContent = `✖ ${(res && res.message)
          || t('settings.messages.testFailed', 'Connection failed.')}`;
        els.testResult.style.color = '#d9534f';
      }
      refreshStatus();
    });
  });

  $('forget-cert-button').addEventListener('click', () => {
    Homey.confirm(t('settings.messages.forgetConfirm',
      'Forget the trusted certificate? The next successful connection trusts whatever certificate the server then presents.'),
    'warning', (confirmErr, yes) => {
      if (confirmErr || !yes) return;
      Homey.api('POST', '/forget-certificate', {}, (err) => {
        els.testResult.textContent = err
          ? `✖ ${err.message || err}`
          : `✓ ${t('settings.messages.certificateForgotten', 'Trusted certificate forgotten. Reconnecting.')}`;
        els.testResult.style.color = err ? '#d9534f' : '#5cb85c';
        setTimeout(refreshStatus, 2000);
      });
    });
  });

  $('reconnect-button').addEventListener('click', () => {
    els.testResult.textContent = t('settings.messages.reconnecting', 'Reconnecting to BioStar 2...');
    els.testResult.style.color = '#555';
    Homey.api('POST', '/reconnect', {}, (err) => {
      els.testResult.textContent = err
        ? `✖ ${t('settings.messages.reconnectFailed', 'Reconnect failed:')} ${err.message || err}`
        : `✓ ${t('settings.messages.reconnectRequested', 'Reconnect requested.')}`;
      els.testResult.style.color = err ? '#d9534f' : '#5cb85c';
      setTimeout(refreshStatus, 1500);
    });
  });

  // Resolves once Homey has stored every value, so the page never reports a save
  // that did not happen.
  const saveAll = (entries) => Promise.all(entries.map(([key, value]) => new Promise((resolve, reject) => {
    Homey.set(key, value, (err) => (err ? reject(err) : resolve()));
  })));
  const saveFailed = (err) => Homey.alert(
    `${t('settings.messages.saveFailed', 'Saving failed:')} ${(err && err.message) || err}`,
  );

  $('save-button').addEventListener('click', () => {
    els.host.value = normaliseHost(els.host.value);
    updatePlainHttpWarning();
    const host = els.host.value;
    const user = els.user.value.trim();
    const entries = [
      ['biostar_host', host],
      ['biostar_ws_uri', els.ws.value.trim()],
      ['biostar_user', user],
      ['biostar_reject_unauthorized', els.ssl.checked],
    ];
    const pw = currentPassword();
    if (pw !== undefined) entries.push(['biostar_password', pw]);

    saveAll(entries).then(() => {
      savedHost = host;
      savedUser = user;
      if (pw !== undefined) {
        passwordTouched = false;
        els.password.value = pw ? PASSWORD_MASK : '';
      }
      Homey.alert(t('settings.messages.saved', 'BioStar 2 settings saved successfully.'));
      setTimeout(refreshStatus, 1500);
    }).catch(saveFailed);
  });

  $('save-advanced-button').addEventListener('click', () => {
    const toList = (text) => text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const toNumber = (input) => {
      const n = Number(input.value);
      return Number.isFinite(n) && n > 0 ? n : '';
    };

    // The clock and persistence options live on the Live Logs tab and save
    // themselves when toggled, so they are deliberately not written here.
    saveAll([
      ['biostar_ignore_events', [...ignoreSet]],
      ['biostar_ignore_substrings', toList(els.ignoreSubstrings.value)],
      ['biostar_heartbeat_s', toNumber(els.heartbeat)],
      ['biostar_reconnect_min_s', toNumber(els.reconnectMin)],
      ['biostar_reconnect_max_s', toNumber(els.reconnectMax)],
      ['biostar_log_usernames', els.logUserNames.checked],
    ]).then(() => {
      Homey.alert(t('settings.messages.savedAdvanced',
        'Advanced settings saved. Reconnecting with the new configuration.'));
      setTimeout(refreshStatus, 2000);
    }).catch(saveFailed);
  });

  // ---------------------------------------------------------------------------
  // Start up
  // ---------------------------------------------------------------------------

  applyTranslations();
  bindTabs();
  loadEventTypes();
  loadSettings().catch(() => {
    els.testResult.textContent = `✖ ${t('settings.messages.loadFailed',
      'Could not load the stored settings.')}`;
    els.testResult.style.color = '#d9534f';
  });
}
