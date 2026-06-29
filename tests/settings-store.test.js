"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const DejaVuSettingsStore = require("../client/js/settings-store.js");

const memoryStorage = (seed) => {
    const data = Object.assign({}, seed || {});
    return {
        data,
        getItem(key) {
            return Object.prototype.hasOwnProperty.call(data, key)
                ? data[key]
                : null;
        },
        setItem(key, value) {
            data[key] = String(value);
        }
    };
};

const createStore = (storage, options) => {
    const o = options || {};
    return new DejaVuSettingsStore({
        storage,
        storageKey: "settings",
        backupKey: "settings.backup",
        corruptKey: "settings.corrupt",
        makeDefaults: o.makeDefaults || (() => ({ enabled: false })),
        normalize: o.normalize || ((value) => value),
        now: () => 1234,
        onSaveError: o.onSaveError
    });
};

test("settings store returns clean defaults when no settings exist", () => {
    const store = createStore(memoryStorage());
    assert.deepEqual(store.load(), { enabled: false });
});

test("settings store normalizes parsed settings", () => {
    const storage = memoryStorage({
        settings: JSON.stringify({ enabled: true, stale: "drop" })
    });
    const store = createStore(storage, {
        normalize: (value) => ({ enabled: !!value.enabled })
    });
    assert.deepEqual(store.load(), { enabled: true });
});

test("settings store captures corrupt settings and restores valid backup", () => {
    const backup = { enabled: true };
    const storage = memoryStorage({
        settings: "{bad json",
        "settings.backup": JSON.stringify(backup)
    });
    const store = createStore(storage);
    assert.deepEqual(store.load(), backup);
    assert.equal(storage.getItem("settings"), JSON.stringify(backup));
    const captured = JSON.parse(storage.getItem("settings.corrupt"));
    assert.equal(captured.capturedAt, 1234);
    assert.equal(captured.raw, "{bad json");
    assert.match(captured.error, /JSON|Unexpected|Expected/i);
});

test("settings store falls back to defaults when primary and backup are invalid", () => {
    const storage = memoryStorage({
        settings: "{bad json",
        "settings.backup": "{also bad"
    });
    const store = createStore(storage);
    assert.deepEqual(store.load(), { enabled: false });
});

test("settings store saves the previous good value as backup", () => {
    const previous = JSON.stringify({ enabled: false });
    const storage = memoryStorage({ settings: previous });
    const store = createStore(storage);
    assert.equal(store.save({ enabled: true }), true);
    assert.equal(storage.getItem("settings.backup"), previous);
    assert.equal(storage.getItem("settings"), JSON.stringify({ enabled: true }));
});
