'use strict';

/**
 * EventMapper - Evaluates raw BioStar 2 event frames and maps them to Homey event classifications.
 *
 * Three event types:
 *   'success'             - User identified + access granted
 *   'identification_fail' - Unknown person (fingerprint/card/face not matched)
 *   'access_denied'       - Known person denied access (wrong door, wrong schedule, etc.)
 *
 * The ignore checks run before any field extraction, so filtered background events
 * (LOCKED/UNLOCKED/TIME_SET, which dominate the stream) cost almost nothing.
 */

const DEFAULT_IGNORE_EVENTS = ['LOCKED', 'UNLOCKED', 'ENROLL_SUCCESS', 'PARTIAL_UPDATE_SUCCESS', 'TIME_SET'];
const RECORD_MANAGEMENT = /(^|_)(ENROLL|UPDATE|DELETE)_/;

class EventMapper {

  static get DEFAULT_IGNORE_EVENTS() {
    return DEFAULT_IGNORE_EVENTS;
  }

  /**
   * Unwraps the event payload (BioStar 2 nests it inconsistently).
   */
  static unwrap(eventData) {
    return (eventData && eventData.Event) || eventData || null;
  }

  /**
   * Reads the event type name without touching any other field.
   */
  static rawNameOf(ev) {
    return (ev && (ev.event_type_id?.name || ev.name)) || 'UNKNOWN';
  }

  /**
   * Reads the user id without building the full profile.
   * Returns null when the event carries no usable user reference.
   */
  static userIdOf(ev) {
    const raw = ev?.user_id?.user_id || ev?.user_id?.id || ev?.user_id_code;
    if (!raw) return null;
    const id = String(raw);
    return (id === 'N/A' || id === '0') ? null : id;
  }

  /**
   * True when this event should be dropped without further processing.
   */
  static isIgnored(rawName, ignoreEvents, ignoreEventSubstrings = []) {
    if (ignoreEvents && typeof ignoreEvents.has === 'function' && ignoreEvents.has(rawName)) return true;
    for (const sub of ignoreEventSubstrings) {
      if (sub && rawName.includes(sub)) return true;
    }
    return false;
  }

  /**
   * Classifies an event name. Returns 'success' | 'access_denied' | 'identification_fail' | null.
   * DENIED is checked before FAIL because BioStar 2 uses both words in some denial events.
   */
  static classify(rawName) {
    if (rawName.includes('IDENTIFY_SUCCESS') || rawName.includes('VERIFY_SUCCESS')) return 'success';
    if (rawName.includes('DENIED')) return 'access_denied';
    // Record management (ENROLL_FAIL, PARTIAL_UPDATE_FAIL, DELETE_FAIL …) is an
    // admin action on the server, never a person at a reader.
    if (rawName.includes('FAIL') && !RECORD_MANAGEMENT.test(rawName)) return 'identification_fail';
    return null;
  }

  /**
   * The reader id as a string, or '' when the event carries none. `device_id` is
   * either an object or a bare id; an object without an id must not turn into
   * the text "[object Object]".
   */
  static deviceIdOf(ev) {
    const raw = ev?.device_id;
    const id = raw && typeof raw === 'object' ? (raw.id || raw.device_id) : raw;
    if (id === undefined || id === null || typeof id === 'object') return '';
    return String(id);
  }

  /**
   * Converts BioStar 2's own event time to an ISO string.
   * Falls back to the current time only when the event carries no usable timestamp,
   * so the tag reflects when access happened rather than when Homey processed it.
   */
  static timestampOf(ev) {
    const raw = ev?.datetime || ev?.server_datetime || ev?.event_datetime;
    if (raw) {
      // BioStar 2 sends either ISO ("2026-07-27T06:05:19.000Z") or "YYYY-MM-DD HH:MM:SS".
      const normalised = typeof raw === 'string' && raw.includes(' ') && !raw.includes('T')
        ? raw.replace(' ', 'T')
        : raw;
      const parsed = new Date(normalised);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return new Date().toISOString();
  }

  /**
   * Evaluates a BioStar 2 event payload.
   * @param {Object} eventData - Raw event object (or msg.Event) from WebSocket frame.
   * @param {Set<string>} ignoreEvents - Set of exact event names to ignore.
   * @param {string[]} ignoreEventSubstrings - Array of substring fragments to ignore.
   * @param {Object|null} userCacheDetails - Cached user profile details (optional enrichment).
   * @returns {Object|null} Mapped event object with rich user metadata or null if ignored.
   */
  static processEvent(eventData, ignoreEvents = new Set(), ignoreEventSubstrings = [], userCacheDetails = null) {
    const ev = EventMapper.unwrap(eventData);
    if (!ev) return null;

    const rawName = EventMapper.rawNameOf(ev);

    // 1. Ignore lists first — cheapest possible rejection of background noise.
    if (EventMapper.isIgnored(rawName, ignoreEvents, ignoreEventSubstrings)) return null;

    // 2. Classify before extracting user fields — unmapped events cost nothing either.
    const type = EventMapper.classify(rawName);
    if (!type) return null;

    const device = ev.device_id?.name || ev.device_name || 'BioStar';
    const deviceId = EventMapper.deviceIdOf(ev);
    const timestamp = EventMapper.timestampOf(ev);

    // 3. Identification failure: unknown person, BioStar 2 has no user to report.
    if (type === 'identification_fail') {
      return {
        type, device, deviceId, rawName, timestamp,
      };
    }

    // 4. Success / denial: build the enriched user profile.
    const uObj = ev.user_id || {};
    const user = userCacheDetails?.name || uObj.name || ev.user_name || 'N/A';

    // Security rule: a success with no identified user must never reach a Flow.
    if (type === 'success' && (!user || user === 'N/A')) return null;

    return {
      type,
      user,
      userId: userCacheDetails?.id || String(uObj.user_id || uObj.id || ev.user_id_code || 'N/A'),
      group: userCacheDetails?.group || uObj.user_group_id?.name || uObj.user_group?.name || 'N/A',
      email: userCacheDetails?.email || uObj.email || 'N/A',
      title: userCacheDetails?.title || uObj.title || 'N/A',
      department: userCacheDetails?.department || uObj.department || 'N/A',
      telephone: userCacheDetails?.telephone || uObj.phone_number || uObj.phone || uObj.telephone || 'N/A',
      loginId: userCacheDetails?.loginId || uObj.login_id || 'N/A',
      device,
      deviceId,
      rawName,
      timestamp,
    };
  }

}

module.exports = EventMapper;
