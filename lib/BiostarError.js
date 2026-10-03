'use strict';

/**
 * An error whose text the app can translate. `code` names the locale key under
 * `errors.client`, `params` fills its placeholders; `message` stays English for
 * the logs. The client has no Homey reference, so translation happens in app.js.
 */
class BiostarError extends Error {

  constructor(code, message, params = {}, cause = null) {
    super(message);
    this.name = 'BiostarError';
    this.code = code;
    this.params = params;
    if (cause) this.cause = cause;
  }

}

module.exports = BiostarError;
