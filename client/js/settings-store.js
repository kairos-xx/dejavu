/*
 * DejaVu — injectable settings persistence store.
 *
 * Keeps localStorage recovery/backup behavior out of the panel controller while
 * leaving project-specific schema normalization with the caller.
 */
(function (root) {
    "use strict";

    const noop = function () {};

    const messageOf = function (error) {
        return String(error && error.message ? error.message : error);
    };

    class DejaVuSettingsStore {
        constructor(options) {
            const o = options || {};
            this.storage = o.storage;
            this.storageKey = String(o.storageKey || "");
            this.backupKey = String(o.backupKey || "");
            this.corruptKey = String(o.corruptKey || "");
            this.makeDefaults = typeof o.makeDefaults === "function"
                ? o.makeDefaults
                : function () { return {}; };
            this.normalize = typeof o.normalize === "function"
                ? o.normalize
                : function (settings) { return settings || {}; };
            this.now = typeof o.now === "function" ? o.now : Date.now;
            this.onSaveError = typeof o.onSaveError === "function"
                ? o.onSaveError
                : noop;
        }

        load() {
            let raw = "";
            try {
                raw = this.storage.getItem(this.storageKey);
                if (!raw) return this.makeDefaults();
                return this.normalize(JSON.parse(raw));
            } catch (error) {
                return this.recover(raw, error);
            }
        }

        recover(raw, error) {
            try {
                if (raw && this.corruptKey) {
                    this.storage.setItem(
                        this.corruptKey,
                        JSON.stringify({
                            capturedAt: this.now(),
                            error: messageOf(error),
                            raw
                        })
                    );
                }
                const backupRaw = this.backupKey
                    ? this.storage.getItem(this.backupKey)
                    : "";
                if (backupRaw) {
                    JSON.parse(backupRaw);
                    this.storage.setItem(this.storageKey, backupRaw);
                    return this.load();
                }
            } catch (backupError) {}
            return this.makeDefaults();
        }

        save(settings) {
            try {
                const serialized = JSON.stringify(settings);
                const previous = this.storage.getItem(this.storageKey);
                if (previous && this.backupKey) {
                    this.storage.setItem(this.backupKey, previous);
                }
                this.storage.setItem(this.storageKey, serialized);
                return true;
            } catch (error) {
                this.onSaveError(error);
                return false;
            }
        }
    }

    root.DejaVuSettingsStore = DejaVuSettingsStore;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = DejaVuSettingsStore;
    }
})(typeof window !== "undefined" ? window : globalThis);
