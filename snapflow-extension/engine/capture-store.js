/**
 * SnapFlow - Local Capture Store
 *
 * IndexedDB persistence shared by the service worker (writer) and the Studio (reader).
 * Screenshots are written one frame at a time as they are taken, so a long capture
 * never holds every frame in memory and survives a service-worker restart.
 * Nothing here leaves the device.
 */

class CaptureStore {
  static DB_NAME = 'SnapFlowCaptureDB';
  static DB_VERSION = 2;
  static CAPTURES = 'captures';
  static FRAMES = 'frames';

  /** Finished captures kept for reopening a Studio tab; older ones are deleted. */
  static KEEP_RECENT = 10;

  static open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.CAPTURES)) {
          db.createObjectStore(this.CAPTURES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(this.FRAMES)) {
          const frames = db.createObjectStore(this.FRAMES, { keyPath: 'id' });
          frames.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  static async run(storeNames, mode, work) {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
        work(tx, (value) => { result = value; });
      });
    } finally {
      db.close();
    }
  }

  static frameKey(sessionId, index) {
    return `${sessionId}:${index}`;
  }

  static putCapture(record) {
    return this.run([this.CAPTURES], 'readwrite', (tx) => {
      tx.objectStore(this.CAPTURES).put(record);
    });
  }

  static getCapture(id) {
    return this.run([this.CAPTURES], 'readonly', (tx, done) => {
      const req = tx.objectStore(this.CAPTURES).get(id);
      req.onsuccess = () => done(req.result);
    });
  }

  static putFrame(sessionId, index, blob) {
    return this.run([this.FRAMES], 'readwrite', (tx) => {
      tx.objectStore(this.FRAMES).put({ id: this.frameKey(sessionId, index), sessionId, index, blob });
    });
  }

  static getFrame(sessionId, index) {
    return this.run([this.FRAMES], 'readonly', (tx, done) => {
      const req = tx.objectStore(this.FRAMES).get(this.frameKey(sessionId, index));
      req.onsuccess = () => done(req.result ? req.result.blob : null);
    });
  }

  static deleteFrames(sessionId) {
    return this.run([this.FRAMES], 'readwrite', (tx) => {
      const range = IDBKeyRange.only(sessionId);
      const req = tx.objectStore(this.FRAMES).index('sessionId').openKeyCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        tx.objectStore(this.FRAMES).delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  }

  /**
   * Deletes all but the most recent captures, plus frames left behind by captures
   * that were cancelled or failed before they were saved.
   *
   * @param {string|null} activeSessionId frames of a capture still in progress are kept
   */
  static async prune(activeSessionId = null) {
    const captures = await this.run([this.CAPTURES], 'readonly', (tx, done) => {
      const req = tx.objectStore(this.CAPTURES).getAllKeys();
      const all = [];
      req.onsuccess = () => {
        const keys = req.result;
        let pending = keys.length;
        if (!pending) done(all);
        keys.forEach((key) => {
          const get = tx.objectStore(this.CAPTURES).get(key);
          get.onsuccess = () => {
            all.push({ id: key, timestamp: (get.result && get.result.timestamp) || 0 });
            if (--pending === 0) done(all);
          };
        });
      };
    });

    captures.sort((a, b) => b.timestamp - a.timestamp);
    const keep = new Set(captures.slice(0, this.KEEP_RECENT).map((c) => c.id));
    if (activeSessionId) keep.add(activeSessionId);
    const expired = captures.filter((c) => !keep.has(c.id)).map((c) => c.id);

    await this.run([this.CAPTURES, this.FRAMES], 'readwrite', (tx) => {
      for (const id of expired) tx.objectStore(this.CAPTURES).delete(id);
      const req = tx.objectStore(this.FRAMES).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (!keep.has(cursor.value.sessionId)) cursor.delete();
        cursor.continue();
      };
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CaptureStore;
} else if (typeof globalThis !== 'undefined') {
  globalThis.CaptureStore = CaptureStore;
}
