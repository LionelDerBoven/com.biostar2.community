'use strict';

module.exports = {
  async testConnection({ homey, body }) {
    return homey.app.testConnection(body);
  },
  async getLogs({ homey }) {
    return homey.app.getLogs();
  },
  async clearLogs({ homey }) {
    return homey.app.clearLogs();
  }
};
