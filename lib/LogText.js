'use strict';

const BiostarError = require('./BiostarError');
const en = require('../locales/en.json');

// Names and error texts can be long; the log line itself is capped in app.js.
const MAX_PARAM_LENGTH = 200;
const MAX_DEPTH = 3;

/**
 * Activity log lines are stored as a locale key under `log.` plus parameters,
 * and the settings page renders them in the viewer's language. The English
 * rendering is stored as `message` as well: for Homey's own console log, for
 * lines written before keys existed, and as the fallback for a missing key.
 *
 * A parameter is a string or number, or a nested message `{ key, params, text }`
 * that is rendered in turn (a connection status, an error), with `text` as its
 * fallback. settings/index.js carries the same renderer; keep the two in step.
 */
class LogText {

  /** The value at a dotted key in a locale object, or undefined. */
  static lookup(dict, key) {
    return String(key).split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);
  }

  /**
   * Fills `__name__` placeholders. `translate(key)` returns the template or
   * undefined; the result is null when the key has no template at all.
   */
  static render(translate, key, params = {}, depth = 0) {
    const template = typeof key === 'string' ? translate(key) : undefined;
    if (typeof template !== 'string') return null;
    return template.replace(/__(\w+)__/g, (_, name) => {
      const value = params ? params[name] : undefined;
      if (value === undefined || value === null) return '';
      if (typeof value !== 'object') return String(value);
      const nested = depth < MAX_DEPTH ? LogText.render(translate, value.key, value.params, depth + 1) : null;
      return nested !== null ? nested : String(value.text || '');
    });
  }

  /** English text of a log line; the key itself if en.json lacks it. */
  static english(key, params) {
    const text = LogText.render((k) => LogText.lookup(en, k), key, params);
    return text !== null ? text : String(key);
  }

  /**
   * A nested message for an error: a client error by its code, so it is
   * translated like the error texts elsewhere; any other error by its message.
   */
  static error(err) {
    if (!(err instanceof BiostarError)) return { text: String((err && err.message) || err) };
    const params = { ...err.params };
    if (err.cause) params.reason = LogText.error(err.cause);
    return { key: `errors.client.${err.code}`, params, text: err.message };
  }

  /** A nested message for a connection status, e.g. CONNECTED. */
  static status(status) {
    return { key: `settings.status.${status}`, text: String(status) };
  }

  /**
   * Parameters as plain data with capped strings, so a log line cannot grow
   * without bound or carry anything but text into the stored log.
   */
  static clean(params, depth = 0) {
    const out = {};
    if (!params || typeof params !== 'object' || depth > MAX_DEPTH) return out;
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'number' || typeof value === 'boolean') {
        out[name] = value;
      } else if (typeof value === 'string') {
        out[name] = value.length > MAX_PARAM_LENGTH ? `${value.slice(0, MAX_PARAM_LENGTH)}…` : value;
      } else if (value && typeof value === 'object') {
        const nested = {};
        if (typeof value.key === 'string') nested.key = value.key;
        if (value.params) nested.params = LogText.clean(value.params, depth + 1);
        if (value.text !== undefined) nested.text = String(value.text).slice(0, MAX_PARAM_LENGTH);
        out[name] = nested;
      }
    }
    return out;
  }

}

module.exports = LogText;
