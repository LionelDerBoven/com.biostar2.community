/* global Homey */
'use strict';

function onHomeyReady(Homey) {
  Homey.ready();

  // Elements
  const hostInput = document.getElementById('biostar_host');
  const wsInput = document.getElementById('biostar_ws_uri');
  const userInput = document.getElementById('biostar_user');
  const passwordInput = document.getElementById('biostar_password');
  const sslCheckbox = document.getElementById('biostar_reject_unauthorized');
  const saveBtn = document.getElementById('save-button');
  const testBtn = document.getElementById('test-button');
  const testResult = document.getElementById('test-result');
  const statusEl = document.getElementById('connection-status');
  const logWindow = document.getElementById('log-window');
  const refreshLogsBtn = document.getElementById('refresh-logs-button');
  const clearLogsBtn = document.getElementById('clear-logs-button');
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  // Tab switching logic
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetPaneId = btn.getAttribute('data-tab');

      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(targetPaneId).classList.add('active');

      if (targetPaneId === 'pane-logs') {
        fetchLogs();
      }
    });
  });

  // Load saved settings (or leave empty on start)
  Homey.get('biostar_host', (err, val) => {
    if (!err && val) hostInput.value = val;
    else hostInput.value = '';
  });

  Homey.get('biostar_ws_uri', (err, val) => {
    if (!err && val) wsInput.value = val;
    else wsInput.value = '';
  });

  Homey.get('biostar_user', (err, val) => {
    if (!err && val) userInput.value = val;
    else userInput.value = '';
  });

  Homey.get('biostar_password', (err, val) => {
    if (!err && val) passwordInput.value = val;
    else passwordInput.value = '';
  });

  Homey.get('biostar_reject_unauthorized', (err, val) => {
    if (!err && typeof val === 'boolean') sslCheckbox.checked = val;
    else sslCheckbox.checked = false; // default: allow self-signed certs
  });

  Homey.get('connection_status', (err, val) => {
    if (!err && val) statusEl.textContent = val;
  });

  // Listen for live status updates
  Homey.on('settings.set', (key) => {
    if (key === 'connection_status') {
      Homey.get('connection_status', (err, val) => {
        if (!err && val) statusEl.textContent = val;
      });
    }
  });

  // Function to fetch and display live logs from app
  function fetchLogs() {
    Homey.api('GET', '/logs', (err, logs) => {
      if (!err && Array.isArray(logs)) {
        if (logs.length === 0) {
          logWindow.textContent = 'No logs available yet.';
        } else {
          const isScrolledToBottom = logWindow.scrollHeight - logWindow.clientHeight <= logWindow.scrollTop + 30;
          logWindow.textContent = logs.join('\n');
          if (isScrolledToBottom) {
            logWindow.scrollTop = logWindow.scrollHeight;
          }
        }
      }
    });
  }

  // Initial log fetch & auto-refresh every 3 seconds
  fetchLogs();
  setInterval(fetchLogs, 3000);

  refreshLogsBtn.addEventListener('click', fetchLogs);

  clearLogsBtn.addEventListener('click', () => {
    Homey.api('POST', '/clear-logs', {}, (err) => {
      if (!err) fetchLogs();
    });
  });

  // Test connection button event handler
  testBtn.addEventListener('click', () => {
    testResult.textContent = 'Testing connection to BioStar 2...';
    testResult.style.color = '#555';

    const payload = {
      biostarHost: hostInput.value.trim(),
      wsUri: wsInput.value.trim(),
      loginUser: userInput.value.trim(),
      password: passwordInput.value,
      rejectUnauthorized: sslCheckbox.checked
    };

    Homey.api('POST', '/test', payload, (err, res) => {
      if (err) {
        testResult.textContent = '✖ Error testing connection: ' + (err.message || err);
        testResult.style.color = '#d9534f';
      } else if (res && res.success) {
        testResult.textContent = '✓ ' + res.message;
        testResult.style.color = '#5cb85c';
      } else {
        testResult.textContent = '✖ ' + (res?.message || 'Connection failed.');
        testResult.style.color = '#d9534f';
      }
      fetchLogs();
    });
  });

  // Save button click event
  saveBtn.addEventListener('click', () => {
    Homey.set('biostar_host', hostInput.value.trim());
    Homey.set('biostar_ws_uri', wsInput.value.trim());
    Homey.set('biostar_user', userInput.value.trim());
    Homey.set('biostar_password', passwordInput.value);
    Homey.set('biostar_reject_unauthorized', sslCheckbox.checked);

    Homey.alert('BioStar 2 Settings saved successfully!');
    setTimeout(fetchLogs, 1000);
  });
}