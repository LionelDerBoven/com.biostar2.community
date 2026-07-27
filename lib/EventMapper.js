'use strict';

/**
 * EventMapper - Evaluates raw BioStar 2 event frames and maps them to Homey event classifications.
 *
 * Three event types:
 *   'success'             - User identified + access granted
 *   'identification_fail' - Unknown person (fingerprint/card/face not matched)
 *   'access_denied'       - Known person denied access (wrong door, wrong schedule, etc.)
 */
class EventMapper {

  /**
   * Evaluates a BioStar 2 event payload.
   * @param {Object} eventData - Raw event object (or msg.Event) from WebSocket frame.
   * @param {Set<string>} ignoreEvents - Set of exact event names to ignore.
   * @param {string[]} ignoreEventSubstrings - Array of substring fragments to ignore.
   * @param {Object|null} userCacheDetails - Cached user profile details (optional enrichment).
   * @returns {Object|null} Mapped event object with rich user metadata or null if ignored.
   */
  static processEvent(eventData, ignoreEvents = new Set(), ignoreEventSubstrings = [], userCacheDetails = null) {
    if (!eventData) return null;

    // BioStar 2 wraps event properties inside eventData.Event or directly in eventData
    const ev = eventData.Event || eventData;

    // Extract raw event properties safely
    const rawName = ev.event_type_id?.name || ev.name || 'UNKNOWN';

    // Extract user object properties
    const uObj = ev.user_id || {};
    const user = userCacheDetails?.name || uObj.name || ev.user_name || 'N/A';
    const userId = userCacheDetails?.id || String(uObj.user_id || uObj.id || ev.user_id_code || 'N/A');
    const group = userCacheDetails?.group || uObj.user_group_id?.name || uObj.user_group?.name || 'N/A';
    const email = userCacheDetails?.email || uObj.email || 'N/A';
    const title = userCacheDetails?.title || uObj.title || 'N/A';
    const department = userCacheDetails?.department || uObj.department || 'N/A';
    const telephone = userCacheDetails?.telephone || uObj.phone_number || uObj.phone || uObj.telephone || 'N/A';
    const loginId = userCacheDetails?.loginId || uObj.login_id || 'N/A';

    const device = ev.device_id?.name || ev.device_name || 'BioStar';

    // 1. Exact ignore list matching
    if (ignoreEvents.has(rawName)) {
      return null;
    }

    // 2. Substring ignore list matching
    for (const sub of ignoreEventSubstrings) {
      if (sub && rawName.includes(sub)) {
        return null;
      }
    }

    const now = new Date().toISOString();

    // 3. Success: user identified + access granted
    const isSuccessPattern = rawName.includes('IDENTIFY_SUCCESS') || rawName.includes('VERIFY_SUCCESS');
    if (isSuccessPattern) {
      if (!user || user === 'N/A') {
        // Security rule: Drop success events that have no identified user
        return null;
      }
      return {
        type: 'success',
        user, userId, group, email, title, department, telephone, loginId,
        device, rawName, timestamp: now
      };
    }

    // 4. Access Denied: known person, no permission (BioStar knows who they are)
    const isDenied = rawName.includes('DENIED');
    if (isDenied) {
      return {
        type: 'access_denied',
        user, userId, group, email, title, department, telephone, loginId,
        device, rawName, timestamp: now
      };
    }

    // 5. Identification Failed: unknown person (fingerprint/card/face not matched)
    const isFail = rawName.includes('FAIL');
    if (isFail) {
      return {
        type: 'identification_fail',
        device, rawName, timestamp: now
      };
    }

    // 6. Unmapped event — dropped
    return null;
  }

}

module.exports = EventMapper;