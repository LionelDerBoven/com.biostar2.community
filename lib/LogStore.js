'use strict';

const fs = require('fs');
const path = require('path');

// /userdata is the app's own writable directory on Homey and survives restarts
// and app updates. Everything this class touches lives inside it.
const DIR = '/userdata';
const FILENAME = 'activity.log';

// One rotation of 128 KB. Large enough that a restart keeps a useful history,
// small enough that both files can be read back in one go without streaming.
const MAX_BYTES = 128 * 1024;

// Lines are buffered and written in batches. Flash has a finite erase budget and
// the app can log several lines per second during a busy minute at the door, so
// one write per line would be both slow and needlessly hard on the hardware.
const FLUSH_MS = 5000;
const MAX_PENDING = 300;

/**
 * Append-only activity log on flash, with a bounded size and batched writes.
 *
 * Disabled by default: the in-memory log is enough for live troubleshooting,
 * and writing access-control history to persistent storage is a choice the
 * owner should make deliberately rather than inherit.
 */
class LogStore {

  constructor(options = {}) {
    this.errorLog = options.errorLog || (() => {});
    this.maxBytes = options.maxBytes || MAX_BYTES;
    this.flushMs = options.flushMs || FLUSH_MS;
    this.dir = options.dir || DIR;
    this.current = path.join(this.dir, FILENAME);
    this.previous = `${this.current}.1`;

    this.enabled = false;
    this.pending = [];
    this.flushTimer = null;
    this.bytes = 0;

    // Serialises every file operation, so a flush, a rotate and a clear can
    // never interleave and produce a half-written or resurrected file.
    this.queue = Promise.resolve();
  }

  /**
   * Chains work onto the single file-operation queue. Failures are logged and
   * swallowed: losing a log line must never take down the app.
   */
  run(job) {
    this.queue = this.queue.then(job).catch((err) => {
      this.errorLog(`Persistent log: ${err.message}`);
    });
    return this.queue;
  }

  /**
   * Turns persistence on or off. Switching it off removes the files, so "off"
   * really means nothing of this app's log is left on flash.
   */
  async setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;

    if (!enabled) {
      this.stopTimer();
      this.pending = [];
      await this.clear();
      return;
    }

    await this.run(async () => {
      await fs.promises.mkdir(this.dir, { recursive: true });
      this.bytes = await this.sizeOf(this.current);
    });
  }

  async sizeOf(file) {
    try {
      const stat = await fs.promises.stat(file);
      return stat.size;
    } catch (_) {
      return 0; // not created yet
    }
  }

  append(line) {
    if (!this.enabled) return;
    this.pending.push(line);

    // A burst is flushed on size rather than waiting out the timer, so a busy
    // period cannot pile up in memory or be lost to a crash.
    // flush() routes through run(), which already swallows and reports its own
    // failures. The trailing catch is only there to satisfy the lint rule.
    if (this.pending.length >= MAX_PENDING) {
      this.flush().catch(() => {});
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch(() => {});
      }, this.flushMs);
    }
  }

  flush() {
    if (!this.pending.length) return this.queue;
    const chunk = `${this.pending.join('\n')}\n`;
    this.pending = [];
    this.stopTimer();

    return this.run(async () => {
      if (!this.enabled) return;
      await fs.promises.appendFile(this.current, chunk, 'utf8');
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes >= this.maxBytes) await this.rotate();
    });
  }

  /**
   * Keeps exactly one generation: the current file becomes the previous one and
   * whatever was previous is dropped. Total on flash stays under 2x maxBytes.
   */
  async rotate() {
    await fs.promises.rename(this.current, this.previous);
    this.bytes = 0;
  }

  /**
   * The stored lines, oldest first, capped at `limit`. Read back into the
   * in-memory buffer at startup so a restart does not blank the log view.
   */
  async readRecent(limit = 100) {
    const lines = [];
    for (const file of [this.previous, this.current]) {
      try {
        const raw = await fs.promises.readFile(file, 'utf8');
        for (const line of raw.split('\n')) {
          if (line) lines.push(line);
        }
      } catch (_) { /* absent, which is normal */ }
    }
    return lines.slice(-limit);
  }

  async clear() {
    this.pending = [];
    this.stopTimer();
    await this.run(async () => {
      for (const file of [this.current, this.previous]) {
        try {
          await fs.promises.unlink(file);
        } catch (_) { /* already gone */ }
      }
      this.bytes = 0;
    });
  }

  stopTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Writes out whatever is buffered. Called when the app shuts down, so the
   * last lines before a restart are not the ones you lose.
   */
  async destroy() {
    this.stopTimer();
    await this.flush();
    this.enabled = false;
  }

}

module.exports = LogStore;
