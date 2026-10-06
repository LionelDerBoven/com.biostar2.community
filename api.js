'use strict';

module.exports = {
  async testConnection({ homey, body }) {
    return homey.app.testConnection(body || {});
  },
  async getLogs({ homey, query }) {
    return homey.app.getLogs(query?.since, query?.epoch);
  },
  async clearLogs({ homey }) {
    return homey.app.clearLogs();
  },
  async getEventTypes({ homey }) {
    return homey.app.getEventTypes();
  },
  async getStatus({ homey }) {
    return homey.app.getStats();
  },
  async reconnect({ homey }) {
    return homey.app.forceReconnect();
  },
};
