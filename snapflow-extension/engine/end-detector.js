/**
 * SnapFlow - End-of-Content Detector
 *
 * A scroll container that loads more as it is scrolled (conversation histories,
 * feeds, search results) reports an end that is only the end of what has loaded so
 * far. Being at the bottom is therefore a claim to be tested, not a fact.
 *
 * The capture engine parks the container at its bottom and reports what it sees
 * there every POLL_MS. This class turns those observations into a decision:
 *
 *   'wait'       keep watching
 *   'nudge'      the bottom has been quiet long enough; make one more scroll
 *                attempt (away from the bottom and back) and keep watching
 *   'grew'       more content is available below: the end was not the end
 *   'end'        the bottom stayed put before and after the extra scroll attempt
 *   'unsettled'  the content never stopped changing; waiting longer will not help
 *
 * No single signal is trusted. An unchanged scroll height counts as evidence only
 * together with an unchanged DOM, over several consecutive observations, and after
 * a further scroll attempt has failed to reveal anything.
 *
 * How long "quiet long enough" is depends on what the container has shown:
 *   - never seen to grow, nothing visibly loading: QUIET_MS, so ordinary containers
 *     are not delayed
 *   - has grown before, or shows a loading indicator: long enough for another load,
 *     scaled from the slowest load seen so far
 *
 * The class holds no DOM references and no timers, so these rules are tested
 * exactly in tests/engine-tests.js.
 */

(() => {
  class EndDetector {
    static DEFAULTS = {
      pollMs: 150,           // spacing of observations
      quietMs: 600,          // quiet time at the bottom of a container that has never grown
      confirmMs: 450,        // quiet time required after the extra scroll attempt
      minPatienceMs: 3000,   // a container known to load more always gets at least this long
      maxPatienceMs: 8000,   // ...and never more than this for one load
      patienceFactor: 2.5,   // ...normally this multiple of its slowest load so far
      hardLimitMs: 20000     // one check never lasts longer than this
    };

    constructor(options = {}) {
      this.opts = { ...EndDetector.DEFAULTS, ...options };
      this.loads = 0;             // times the content was seen to grow
      this.slowestLoadMs = 0;
      this.lastExtent = null;     // extent at the most recent observation
      this.confirmedExtent = null; // extent last confirmed as the real end
      this.check = null;
    }

    /** True once the container has been seen to load more content. */
    get dynamic() {
      return this.loads > 0;
    }

    /** How long the bottom must stay quiet before the extra scroll attempt. */
    patience(busy = false) {
      if (!this.dynamic && !busy) return this.opts.quietMs;
      const scaled = this.slowestLoadMs * this.opts.patienceFactor;
      return Math.max(this.opts.minPatienceMs, Math.min(this.opts.maxPatienceMs, scaled));
    }

    /**
     * The container has just been parked at the bottom of `extent`.
     * An extent already confirmed as the end is re-checked briefly instead of in full.
     */
    arrive(now, extent) {
      // Growth that happened while nobody was watching still marks the container as dynamic.
      if (this.lastExtent !== null && extent > this.lastExtent + 1) this.loads++;
      this.lastExtent = extent;
      this.check = {
        start: now,
        quietSince: now,
        extent,
        nudged: this.confirmedExtent !== null && Math.abs(extent - this.confirmedExtent) <= 1
      };
    }

    /** The extra scroll attempt has finished and the container is back at its bottom. */
    settled(now) {
      if (this.check) this.check.quietSince = now;
    }

    /**
     * @param {Object} o
     * @param {number} o.now      monotonic time in ms
     * @param {number} o.extent   scrollable extent (scrollHeight)
     * @param {boolean} o.changed the DOM changed, or the container was moved off its bottom
     * @param {boolean} [o.busy]  a loading indicator is showing inside the container
     * @returns {'wait'|'nudge'|'grew'|'end'|'unsettled'}
     */
    observe(o) {
      const c = this.check;
      if (!c) throw new Error('EndDetector.observe called before arrive');
      this.lastExtent = o.extent;

      if (o.extent > c.extent + 1) {
        this.loads++;
        this.slowestLoadMs = Math.max(this.slowestLoadMs, o.now - c.start);
        this.confirmedExtent = null;
        this.check = null;
        return 'grew';
      }

      // A placeholder that disappears makes the content shorter: a change, not an end.
      const shrank = o.extent < c.extent - 1;
      if (shrank) c.extent = o.extent;
      if (o.changed || shrank) c.quietSince = o.now;

      if (o.now - c.start >= this.opts.hardLimitMs) {
        this.check = null;
        return 'unsettled';
      }

      const quiet = o.now - c.quietSince;
      if (!c.nudged) {
        if (quiet < this.patience(!!o.busy)) return 'wait';
        c.nudged = true;
        c.quietSince = o.now;
        return 'nudge';
      }
      if (quiet < this.opts.confirmMs) return 'wait';

      this.confirmedExtent = c.extent;
      this.check = null;
      return 'end';
    }
  }

  // Assigned rather than declared at the top level, so injecting this file into a
  // page that already has it (after the extension is reloaded) cannot throw.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EndDetector;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.SnapFlowEndDetector = EndDetector;
  }
})();
