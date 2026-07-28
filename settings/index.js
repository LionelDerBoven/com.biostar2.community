'use strict';

// Placeholder shown instead of the stored password, so the real secret is
// never sent to the settings page. Saving only overwrites it when changed.
const PASSWORD_MASK = '••••••••••';
const LOG_POLL_MS = 3000;

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
    status: $('connection-status'),
    permWarning: $('perm-warning'),
    testResult: $('test-result'),
    logWindow: $('log-window'),
  };

  let logPollTimer = null;
  let logsSeen = 0;
  let logLines = [];
  let passwordTouched = false;
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
    return `${formatDuration(Date.now() - timestamp)} ago`;
  }

  const STATUS_CLASS = { CONNECTED: 'ok', DISCONNECTED: 'bad' };

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

  function loadEventTypes() {
    Homey.api('GET', '/event-types', (err, rows) => {
      if (err) return;
      ignoreSet = new Set((rows || []).filter((r) => r.ignored).map((r) => r.name));
      renderEventTypes(rows);
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

  function fetchLogs(reset = false) {
    if (reset) {
      logsSeen = 0; logLines = [];
    }
    Homey.api('GET', `/logs?since=${logsSeen}`, (err, res) => {
      if (err || !res) return;

      // The buffer was cleared or rotated behind us — start over.
      if (res.total < logsSeen) {
        logsSeen = 0; logLines = [];
      }

      if (Array.isArray(res.lines) && res.lines.length) {
        logLines = logLines.concat(res.lines).slice(-200);
        logsSeen = res.total;

        const atBottom = els.logWindow.scrollHeight - els.logWindow.clientHeight
          <= els.logWindow.scrollTop + 30;
        els.logWindow.textContent = logLines.join('\n');
        if (atBottom) els.logWindow.scrollTop = els.logWindow.scrollHeight;
      } else if (!logLines.length) {
        els.logWindow.textContent = t('settings.logs.empty', 'No logs available yet.');
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

  $('manual-ignore-add').addEventListener('click', () => {
    const name = $('manual-ignore-input').value.trim();
    if (!name) return;
    ignoreSet.add(name);
    $('manual-ignore-input').value = '';
    loadEventTypes();
  });

  async function loadSettings() {
    els.host.value = await getSetting('biostar_host');
    els.ws.value = await getSetting('biostar_ws_uri');
    els.user.value = await getSetting('biostar_user');
    els.ssl.checked = (await getSetting('biostar_reject_unauthorized', false)) === true;

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

        if (targetPaneId === 'pane-advanced') loadEventTypes();
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
    els.testResult.textContent = t('settings.messages.testing', 'Testing connection to BioStar 2...');
    els.testResult.style.color = '#555';

    const payload = {
      biostarHost: els.host.value.trim(),
      wsUri: els.ws.value.trim(),
      loginUser: els.user.value.trim(),
      rejectUnauthorized: els.ssl.checked,
    };
    const pw = currentPassword();
    if (pw !== undefined) payload.password = pw;

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

  $('save-button').addEventListener('click', () => {
    Homey.set('biostar_host', els.host.value.trim());
    Homey.set('biostar_ws_uri', els.ws.value.trim());
    Homey.set('biostar_user', els.user.value.trim());
    Homey.set('biostar_reject_unauthorized', els.ssl.checked);

    const pw = currentPassword();
    if (pw !== undefined) {
      Homey.set('biostar_password', pw);
      passwordTouched = false;
      els.password.value = pw ? PASSWORD_MASK : '';
    }

    Homey.alert(t('settings.messages.saved', 'BioStar 2 settings saved successfully.'));
    setTimeout(refreshStatus, 1500);
  });

  $('save-advanced-button').addEventListener('click', () => {
    const toList = (text) => text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const toNumber = (input) => {
      const n = Number(input.value);
      return Number.isFinite(n) && n > 0 ? n : '';
    };

    Homey.set('biostar_ignore_events', [...ignoreSet]);
    Homey.set('biostar_ignore_substrings', toList(els.ignoreSubstrings.value));
    Homey.set('biostar_heartbeat_s', toNumber(els.heartbeat));
    Homey.set('biostar_reconnect_min_s', toNumber(els.reconnectMin));
    Homey.set('biostar_reconnect_max_s', toNumber(els.reconnectMax));
    Homey.set('biostar_log_usernames', els.logUserNames.checked);

    Homey.alert(t('settings.messages.savedAdvanced',
      'Advanced settings saved. Reconnecting with the new configuration.'));
    setTimeout(refreshStatus, 2000);
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
