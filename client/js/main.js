/**
 * DejaVu — panel controller.
 *
 * Owns: settings persistence (localStorage), the dejavu polling
 * loop, template preview, and status display. All actual document
 * I/O happens through the UXP host bridge; this file only orchestrates calls into it.
 */
"use strict";

const DEJAVU_IS_CEP = typeof window.__adobe_cep__ !== "undefined" &&
    typeof CSInterface === "function";
const DEJAVU_IS_UXP = !DEJAVU_IS_CEP &&
    typeof window.DejaVuHost !== "undefined";
const csInterface = DEJAVU_IS_CEP ? new CSInterface() : null;

const installPanelDropGuard = () => {
    if (window.__DEJAVU_DROP_GUARD_INSTALLED__) return;
    window.__DEJAVU_DROP_GUARD_INSTALLED__ = true;
    const blockDragDrop = (evt) => {
        if (evt.dataTransfer) {
            evt.dataTransfer.dropEffect = "none";
        }
        evt.preventDefault();
        evt.stopPropagation();
    };
    [
        "drag",
        "dragstart",
        "dragenter",
        "dragover",
        "dragleave",
        "drop"
    ].forEach((eventName) => {
        window.addEventListener(eventName, blockDragDrop, true);
        document.addEventListener(eventName, blockDragDrop, true);
    });
};

installPanelDropGuard();

const FLYOUT_MENU_IDS = {
    autoFitPanel: "dejavuAutoFitPanel",
    dejavuNow: "dejavuDejavuNow",
    createCheckpoint: "dejavuCreateCheckpoint",
    refreshStatus: "dejavuRefreshStatus",
    refreshTimeline: "dejavuRefreshTimeline",
    revealFolder: "dejavuRevealFolder",
    checkForUpdates: "dejavuCheckForUpdates",
    openTimeline: "dejavuOpenTimeline",
    openRecovery: "dejavuOpenRecovery",
    openDocuments: "dejavuOpenDocuments",
    pauseFive: "dejavuPauseFive",
    resume: "dejavuResume"
};

const FLYOUT_MENU_LABELS = {
    autoFitPanel: "Auto-adjust panel height",
    dejavuNow: "Dejavu now",
    createCheckpoint: "Create named checkpoint",
    refreshStatus: "Refresh status",
    refreshTimeline: "Refresh timeline",
    revealFolder: "Reveal dejavu folder",
    checkForUpdates: "Check for updates",
    openTimeline: "Show Timeline",
    openRecovery: "Show Recovery Center",
    openDocuments: "Show Open Documents",
    pauseFive: "Pause for 5 minutes",
    resume: "Resume dejavu"
};

const STORAGE_KEY = "dejavuai.settings.v1";
const STORAGE_BACKUP_KEY = "dejavuai.settings.lastGood.v1";
const STORAGE_CORRUPT_KEY = "dejavuai.settings.corrupt.v1";
const SNOOZE_STORAGE_KEY = "dejavuai.snoozeUntil.v1";
const SNOOZE_META_STORAGE_KEY = "dejavuai.snoozeMeta.v1";
const CRASH_SESSION_KEY = "dejavuai.crashSession.v1";
const RECOVERY_CANDIDATES_KEY = "dejavuai.recoveryCandidates.v1";

const DONATION_CONFIG = {
    defaultPlatform: "kofi",
    defaultAmount: 1,
    defaultCurrency: "EUR",
    itemName: "DejaVu coffee",
    platforms: {
        kofi: {
            label: "Ko-fi",
            handle: "joaoslopes",
            baseUrl: "https://ko-fi.com/joaoslopes"
        },
        buymeacoffee: {
            label: "Buy Me a Coffee",
            handle: "joaoslopes",
            baseUrl: "https://www.buymeacoffee.com/joaoslopes"
        }
    }
};

const DEJAVU_MODE_OFF_ALL = "offAll";
const DEJAVU_MODE_OFF_CURRENT = "offCurrent";
const DEJAVU_MODE_ON_CURRENT = "onCurrent";
const DEJAVU_MODE_ON_ALL = "onAll";

const CANCELLED_FOLDER_VALUES = ["", "null", "undefined", "__CANCELLED__"];

/**
 * Fmt — pure, stateless display formatting (time, byte sizes,
 * relative age, signed size deltas). No DOM or settings access.
 */
// Thin façade over the pure, unit-tested formatting helpers in DEJAVU
// (client/js/core.js). Kept as `Fmt.*` so existing call sites are unchanged.
class Fmt {
    static pad2(n) {
        return DEJAVU.pad2(n);
    }

    static time(d) {
        return DEJAVU.formatTime(d);
    }

    static bytes(bytes) {
        return DEJAVU.formatBytes(bytes);
    }

    static timestamp(ms) {
        return DEJAVU.formatTimestamp(ms);
    }

    static relative(ms) {
        return DEJAVU.relativeAge(ms);
    }

    static sizeDelta(bytes, prevBytes) {
        return DEJAVU.sizeDelta(bytes, prevBytes);
    }
}

// Absolute path to the extension root (CEP only; null otherwise).
const DEJAVU_EXTENSION_ROOT = (() => {
    try {
        if (DEJAVU_IS_CEP && csInterface && typeof SystemPath !== "undefined") {
            return csInterface.getSystemPath(SystemPath.EXTENSION);
        }
    } catch (e) {}
    return null;
})();

// Runtime config read once from manifest.json's `dejavu` block, so dev
// mode and the GitHub update-check are configurable in the manifest rather
// than hard-coded. Falls back to safe defaults if the file can't be read.
const DEJAVU_CONFIG = (() => {
    const defaults = {
        version: "0.0.0",
        devMode: null,
        updateCheck: {
            enabled: true,
            owner: "kairos-xx",
            repo: "dejavu",
            intervalDays: 7,
            includePrereleases: false,
            apiBase: "https://api.github.com",
            releasesPageUrl: ""
        }
    };
    try {
        if (typeof require !== "function" || !DEJAVU_EXTENSION_ROOT) return defaults;
        const fs = require("fs");
        const manifest = JSON.parse(
            fs.readFileSync(`${DEJAVU_EXTENSION_ROOT}/manifest.json`, "utf8")
        );
        const cfg = manifest.dejavu || {};
        return {
            version: manifest.version || defaults.version,
            devMode: typeof cfg.devMode === "boolean" ? cfg.devMode : null,
            updateCheck: Object.assign(
                {}, defaults.updateCheck, cfg.updateCheck || {}
            )
        };
    } catch (e) {
        return defaults;
    }
})();

// Development mode controls the dev aids — the host $.evalFile re-load and
// the on-disk asset reload watcher (B-10). Resolution order:
//   1. window.__DEJAVU_FORCE_DEV__ (runtime override),
//   2. manifest.json → dejavu.devMode (the manifest flag),
//   3. presence of a `.debug` file at the extension root — the CEP dev-install
//      marker, excluded from the packaged production .zxp so a shipped build
//      disables the dev aids automatically.
const DEJAVU_DEV_MODE = (() => {
    if (typeof window !== "undefined" &&
        typeof window.__DEJAVU_FORCE_DEV__ === "boolean") {
        return window.__DEJAVU_FORCE_DEV__;
    }
    if (typeof DEJAVU_CONFIG.devMode === "boolean") return DEJAVU_CONFIG.devMode;
    try {
        if (!DEJAVU_IS_CEP || typeof require !== "function" ||
            !DEJAVU_EXTENSION_ROOT) {
            return false;
        }
        return require("fs").existsSync(`${DEJAVU_EXTENSION_ROOT}/.debug`);
    } catch (e) {
        return false;
    }
})();

// Dev aid: re-load host.jsx via $.evalFile on each CEP panel open so host
// edits take effect on a simple reopen. Off in production.
const FORCE_HOST_RELOAD = DEJAVU_DEV_MODE;

// Must match DEJAVU_HOST_VERSION in host/host.jsx. After load the panel
// reads the host's version back; a mismatch means an OLD host.jsx
// is still resident in Illustrator's ExtendScript engine.
const EXPECTED_HOST_VERSION = "2026.06.25-r33";
const EXPECTED_UXP_HOST_VERSION = "2026.06.25-r33";

// Some host panel sessions can stay alive when their tabs are hidden.
// Reload once when a previously-hidden panel becomes visible so the
// cache-busted asset URLs in index.html are read freshly.
let panelWasHidden = false;
let panelReloading = false;

const reloadPanelAfterReopen = () => {
    if (panelReloading) return;
    panelReloading = true;
    window.location.reload(true);
};

window.dejavu_isUpdateCheckEnabled = () => {
    return typeof state !== "undefined" &&
        state.settings &&
        state.settings.checkForUpdates !== false;
};

if (csInterface && typeof csInterface.addEventListener === "function") {
    csInterface.addEventListener(
        "com.adobe.csxs.events.panelWindowStatusChanged",
        (event) => {
            const visible = String(event && event.data).toLowerCase() === "true";
            if (!visible) {
                panelWasHidden = true;
            } else if (panelWasHidden) {
                reloadPanelAfterReopen();
            }
        }
    );
}

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        panelWasHidden = true;
    } else if (panelWasHidden) {
        reloadPanelAfterReopen();
    }
});

/**
 * Watches development assets on disk and reloads this persistent CEP page
 * whenever one changes. Illustrator often keeps a closed panel alive and
 * emits no reliable reopen event, so file watching is the only dependable
 * edit-refresh loop during extension development.
 */
const installDevelopmentReloadWatcher = () => {
    if (!DEJAVU_DEV_MODE) return;
    if (window.__DEJAVU_DEV_RELOAD_WATCHER__) return;
    if (!csInterface) return;
    if (typeof require !== "function") return;
    try {
        const fs = require("fs");
        const path = require("path");
        const extensionRoot = csInterface.getSystemPath(
            SystemPath.EXTENSION
        );
        const watchedFiles = [
            "client/index.html",
            "client/css/style.css",
            "client/js/main.js",
            "client/js/top.js",
            "client/js/interval.js",
            "client/js/locations.js",
            "client/js/timeline.js",
            "client/js/recovery.js",
            "client/js/open.js",
            "client/js/advanced.js",
            "client/js/bottom.js",
            "client/js/theme.js",
            "host/host.jsx",
            "host/host.js",
            "manifest.json",
            "CSXS/manifest.xml"
        ];

        const getDevelopmentSignature = () => {
            const parts = [];
            for (let iWatch = 0; iWatch < watchedFiles.length; iWatch++) {
                const fullPath = path.join(extensionRoot, watchedFiles[iWatch]);
                try {
                    const stat = fs.statSync(fullPath);
                    parts.push(
                        `${watchedFiles[iWatch]}:${stat.mtime.getTime()}:${stat.size}`
                    );
                } catch (eStat) {
                    parts.push(`${watchedFiles[iWatch]}:missing`);
                }
            }
            return parts.join("|");
        };

        let signature = getDevelopmentSignature();
        window.__DEJAVU_DEV_RELOAD_WATCHER__ = window.setInterval(
            () => {
                const nextSignature = getDevelopmentSignature();
                if (nextSignature !== signature) {
                    signature = nextSignature;
                    reloadPanelAfterReopen();
                }
            },
            1000
        );
    } catch (eWatcher) {
        // Automatic reload is a development convenience only.
    }
};

installDevelopmentReloadWatcher();

/**
 * HostBridge — the single channel to host.jsx in Illustrator's
 * ExtendScript engine. Owns (re)loading the host script and invoking
 * its functions with JSON marshalling plus a one-shot retry when a
 * host function is missing (i.e. a stale host). Module-scoped
 * collaborators (csInterface, FORCE_HOST_RELOAD) are used directly.
 */
class HostBridge {
    constructor() {
        this.loadedPromise = null;
    }

    ensureLoaded(forceReload) {
        if (DEJAVU_IS_UXP && window.DejaVuHost) {
            if (!forceReload) {
                return Promise.resolve({ ok: true, runtime: "uxp" });
            }
            return this.reloadUxpHost()
                .then(() => ({ ok: true, runtime: "uxp", reloaded: true }))
                .catch((error) => ({
                    ok: false,
                    runtime: "uxp",
                    error: error && error.message ? error.message : String(error)
                }));
        }
        if (!csInterface) {
            return Promise.resolve({
                ok: false,
                error: "No CEP or UXP host bridge is available."
            });
        }
        if (forceReload) this.loadedPromise = null;
        if (this.loadedPromise) return this.loadedPromise;
        this.loadedPromise = new Promise((resolve) => {
            const checkScript =
                `typeof dejavu_getActiveDocInfo === "function" ? "ok" : "missing"`;

            csInterface.evalScript(checkScript, (initialCheck) => {
                if (initialCheck === "ok" && !FORCE_HOST_RELOAD) {
                    // Manifest-driven <ScriptPath> load already
                    // succeeded — the normal, expected case. No need
                    // to touch $.evalFile at all.
                    resolve({ ok: true });
                    return;
                }

                // Either host.jsx isn't loaded yet, or FORCE_HOST_RELOAD
                // is on — explicitly (re-)load it so the latest host
                // code is what runs. A reload redefines every host
                // function in the persistent ExtendScript engine.
                try {
                    const extensionRoot = csInterface.getSystemPath(
                        SystemPath.EXTENSION
                    );
                    const jsxPath = `${extensionRoot}/host/host.jsx`;

                    // Resolve the real path (the install is a symlink
                    // to the working copy) and read the source via
                    // Node, so we can eval the host content DIRECTLY —
                    // independent of how ExtendScript resolves a
                    // symlinked File path, which is the failure that
                    // let a stale host stay resident across reopens.
                    let realPath = jsxPath;
                    let hostCode = null;
                    try {
                        const fsMod = require("fs");
                        const pathMod = require("path");
                        const joined = pathMod.join(
                            extensionRoot, "host/host.jsx"
                        );
                        try {
                            realPath = fsMod.realpathSync(joined);
                        } catch (eReal) {
                            realPath = joined;
                        }
                        hostCode = fsMod.readFileSync(realPath, "utf8");
                    } catch (eNode) {
                        hostCode = null;
                    }

                    const finalize = (loadResult) => {
                        csInterface.evalScript(checkScript, (finalCheck) => {
                            if (finalCheck !== "ok") {
                                // eslint-disable-next-line no-console
                                console.error(
                                    `[DejaVu] host.jsx failed to (re)load.
  realPath: ${realPath}
  result: ${loadResult}
  check: ${finalCheck}`
                                );
                            }
                            resolve(
                                finalCheck === "ok"
                                    ? { ok: true }
                                    : {
                                          ok: false,
                                          error:
                                              `Could not load host.jsx: ${String(loadResult)} [${realPath}]`
                                      }
                            );
                        });
                    };

                    const doEvalFile = () => {
                        const escaped = realPath
                            .replace(/\\/g, "\\\\")
                            .replace(/"/g, '\\"');
                        const loadScript =
                            `(function () {try {let file = new File("${escaped}");if (!file.exists) return "missing-file: " + file.fsName;$.evalFile(file);return typeof dejavu_getActiveDocInfo === "function"? "ok" : "missing-function";} catch (e) { return "load-error: " + e; }}())`;
                        csInterface.evalScript(loadScript, (r) => {
                            finalize(r);
                        });
                    };

                    if (hostCode && hostCode.length > 0) {
                        // Direct source eval: defines every host
                        // function in the persistent ExtendScript
                        // engine regardless of file-path resolution.
                        csInterface.evalScript(hostCode, () => {
                            csInterface.evalScript(checkScript, (afterEval) => {
                                if (afterEval === "ok") {
                                    finalize("node-eval ok");
                                } else {
                                    doEvalFile();
                                }
                            });
                        });
                    } else {
                        doEvalFile();
                    }
                } catch (e) {
                    // eslint-disable-next-line no-console
                    console.error(
                        `[DejaVu] ensureHostLoaded threw: ${(e && e.message ? e.message : e)}`
                    );
                    resolve({
                        ok: false,
                        error:
                            `Could not resolve host.jsx: ${(e && e.message ? e.message : e)}`
                    });
                }
            });
        });
        return this.loadedPromise;
    }

    /**
     * Re-fetches host.js from disk (bypassing any panel script cache) and
     * re-executes it so the UXP host bridge matches the current source. This
     * mirrors the CEP $.evalFile reload path and avoids requiring a full
     * Illustrator restart after host-side fixes.
     */
    reloadUxpHost() {
        return new Promise((resolve, reject) => {
            if (typeof document === "undefined") {
                reject(new Error("No document available to reload UXP host"));
                return;
            }
            const token = window.__DEJAVU_ASSET_RELOAD_TOKEN__ || String(Date.now());
            const url = `../host/host.js?reload=${token}`;
            fetch(url)
                .then((response) => {
                    if (!response.ok) {
                        throw new Error(`Failed to fetch host.js: ${response.status}`);
                    }
                    return response.text();
                })
                .then((source) => {
                    const blob = new Blob([source], { type: "application/javascript" });
                    const blobUrl = URL.createObjectURL(blob);
                    const script = document.createElement("script");
                    script.src = blobUrl;
                    script.onload = () => {
                        URL.revokeObjectURL(blobUrl);
                        if (typeof window.DejaVuHost === "undefined" ||
                                !window.DejaVuHost) {
                            reject(new Error(
                                "host.js reloaded but window.DejaVuHost is missing"
                            ));
                            return;
                        }
                        resolve();
                    };
                    script.onerror = () => {
                        URL.revokeObjectURL(blobUrl);
                        reject(new Error(`Failed to load reloaded host.js from ${url}`));
                    };
                    document.head.appendChild(script);
                })
                .catch((error) => {
                    reject(error && error.message ? error : new Error(String(error)));
                });
        });
    }

    call(fnName, args, retried) {
        if (DEJAVU_IS_UXP && window.DejaVuHost &&
                typeof window.DejaVuHost[fnName] === "function") {
            return Promise.resolve()
                .then(() => window.DejaVuHost[fnName](...(args || [])))
                .then((result) => {
                    if (typeof result === "string") {
                        try {
                            return JSON.parse(result);
                        } catch (eParse) {
                            return {
                                ok: false,
                                error: `Bad UXP host response for ${fnName}(): ${result}`
                            };
                        }
                    }
                    return result || { ok: true };
                })
                .catch((error) => ({
                    ok: false,
                    error: error && error.message ? error.message : String(error)
                }));
        }
        return this.ensureLoaded(!!retried).then((hostStatus) => {
            if (!hostStatus || hostStatus.ok === false) {
                return {
                    ok: false,
                    error:
                        (hostStatus && hostStatus.error) ||
                        "Illustrator host script is unavailable."
                };
            }
            return new Promise((resolve) => {
                const serializedArgs = (args || [])
                    .map((a) => {
                        return JSON.stringify(a);
                    })
                    .join(", ");
                const script = `${fnName}(${serializedArgs})`;
                csInterface.evalScript(script, (result) => {
                    if (
                        result === undefined ||
                        result === null ||
                        result === "undefined" ||
                        result === "EvalScript error."
                    ) {
                        resolve({
                            ok: false,
                            error:
                                `ExtendScript call to ${fnName}() failed (host.jsx may not be loaded, or the function threw). Raw response: ${String(result)}`
                        });
                        return;
                    }
                    try {
                        resolve(JSON.parse(result));
                    } catch (e) {
                        if (
                            !retried &&
                            (/is not a function/i.test(String(result)) ||
                                /Error 24/.test(String(result)))
                        ) {
                            resolve({
                                ok: false,
                                retryMissingHostFunction: true,
                                error: String(result)
                            });
                            return;
                        }
                        resolve({
                            ok: false,
                            error:
                                `Bad host response for ${fnName}(): ${result}`
                        });
                    }
                });
            });
        }).then((result) => {
            if (result && result.retryMissingHostFunction) {
                return this.call(fnName, args, true);
            }
            return result;
        });
    }
}

const host = new HostBridge();

// Thin module-level wrappers so existing call sites keep working
// while the logic lives in HostBridge.
const ensureHostLoaded = (forceReload) => {
    return host.ensureLoaded(forceReload);
};

const TOKENS = [
    { token: "$filename", hint: "original name" },
    { token: "$hh", hint: "hour" },
    { token: "$mm", hint: "minute" },
    { token: "$ss", hint: "second" },
    { token: "$dd", hint: "day" },
    { token: "$MM", hint: "month" },
    { token: "$YYYY", hint: "year" },
    { token: "$YY", hint: "yr (2-digit)" },
    { token: "$date", hint: "YYYYMMDD" },
    { token: "$time", hint: "HHMMSS" },
    { token: "$counter", hint: "collision counter" }
];

const FOLDER_TOKENS = ["$defaultFolder", "$filename"];

const DEFAULT_SETTINGS = {
    enabled: false,
    enabledForAll: false,
    fileDejavuOverrides: {},
    intervalValue: 2,
    intervalUnit: 60,
    folder: "~/",
    folderValidated: false,
    template: "$filename_$hh$mm$ss_$dd$MM$YYYY",
    overwriteExisting: true,
    onlySaveWhenChanged: true,
    folderPerDocument: false,
    pendingUnsavedDejavuFolder: "",
    pendingUnsavedBaseName: "",
    pendingUnsavedDocumentSessionId: "",
    pendingUnsavedFoldersBySession: {},
    keepCount: 20,
    keepDays: 0,
    maxFolderSizeMb: 0,
    diskSpaceWarningMb: 1024,
    diskSpaceRefreshMb: 256,
    recoveryVersionsPerUnsavedDoc: 5,
    recoveryMaxCandidates: 80,
    folderTemplate: "$defaultFolder/$filename",
    recoveryCheck: true,
    autoRecoverAfterCrash: true,
    checkForUpdates: true,
    autoPinEvery: 0,
    dejavuSuccessCount: 0,
    backupOriginalBeforeDejavu: false,
    saveImmediatelyOnEnable: true,
    saveOnDocumentSwitch: false,
    autoRefreshTimeline: true,
    timelineFilter: "",
    timelineSort: "newest",
    timelineRange: "all",
    timelineCompact: false,
    timelinePinnedOnly: false,
    recoveryCompact: false,
    recoveryPinnedOnly: false,
    recoveryFilter: "",
    recoverySort: "newest",
    recoveryRange: "all",
    protectedSnapshots: {},
    snapshotNotes: {},
    drawerState: {},
    autoFitPanel: true,
    installSignature: "",
    donationDismissedInstallSignature: "",
    donationAmount: DONATION_CONFIG.defaultAmount,
    donationCurrency: DONATION_CONFIG.defaultCurrency,
    donationPlatform: DONATION_CONFIG.defaultPlatform
};

/**
 * SettingsStore — owns persistence of the panel's settings object:
 * loading (schema-merge of known keys, the two-state migration, and a
 * corrupt → backup → defaults fallback chain) and saving (keeping a
 * backup of the prior good copy). Module-scoped collaborators
 * (DEFAULT_SETTINGS, the normalize* helpers, pathIsInside, state, el)
 * are used directly.
 */
class SettingsStore {
    load() {
        try {
            const raw = window.localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                const defaults = clone(DEFAULT_SETTINGS);
                defaults.fileDejavuOverrides = {};
                defaults.drawerState = {};
                defaults.protectedSnapshots = {};
                defaults.snapshotNotes = {};
                return defaults;
            }
            const parsed = JSON.parse(raw);
            // Only adopt keys that are part of the current settings schema,
            // dropping stale/unknown keys from older data (DEJAVU.adoptKnownKeys,
            // unit-tested). A throwaway clone is passed so the normalizations
            // below can mutate the result without touching DEFAULT_SETTINGS.
            const base = clone(DEFAULT_SETTINGS);
            base.fileDejavuOverrides = {};
            const merged = DEJAVU.adoptKnownKeys(base, parsed);
            // Migrate the original two-state toggle into the global
            // baseline; per-file overrides are sanitized below.
            if (typeof merged.enabledForAll !== "boolean") {
                merged.enabledForAll = !!merged.enabled;
            }
            merged.fileDejavuOverrides = normalizeFileDejavuOverrides(
                merged.fileDejavuOverrides
            );
            merged.pendingUnsavedFoldersBySession = normalizePlainObject(
                merged.pendingUnsavedFoldersBySession
            );
            merged.drawerState = normalizePlainObject(merged.drawerState);
            merged.protectedSnapshots = normalizePlainObject(
                merged.protectedSnapshots
            );
            merged.timelineSort = normalizeTimelineSort(merged.timelineSort);
            merged.timelineRange = normalizeTimelineRange(merged.timelineRange);
            merged.timelineFilter = String(merged.timelineFilter || "");
            merged.snapshotNotes = normalizeStringMap(merged.snapshotNotes);
            merged.enabled = !!merged.enabledForAll;
            // Drop a remembered unsaved-document folder that no longer
            // belongs under the current default folder (prevents a
            // stale "/Untitled-1"-style path from being retried).
            if (
                merged.pendingUnsavedDejavuFolder &&
                !pathIsInside(
                    merged.pendingUnsavedDejavuFolder,
                    merged.folder
                )
            ) {
                merged.pendingUnsavedDejavuFolder = "";
                merged.pendingUnsavedBaseName = "";
                merged.pendingUnsavedDocumentSessionId = "";
            }
            Object.keys(merged.pendingUnsavedFoldersBySession).forEach((key) => {
                const record = merged.pendingUnsavedFoldersBySession[key];
                if (
                    !record ||
                    !record.folder ||
                    !pathIsInside(record.folder, merged.folder)
                ) {
                    delete merged.pendingUnsavedFoldersBySession[key];
                }
            });
            return merged;
        } catch (e) {
            try {
                if (raw) {
                    window.localStorage.setItem(
                        STORAGE_CORRUPT_KEY,
                        JSON.stringify({
                            capturedAt: Date.now(),
                            error: String(e && e.message ? e.message : e),
                            raw
                        })
                    );
                }
                const backupRaw = window.localStorage.getItem(
                    STORAGE_BACKUP_KEY
                );
                if (backupRaw) {
                    JSON.parse(backupRaw);
                    window.localStorage.setItem(STORAGE_KEY, backupRaw);
                    return this.load();
                }
            } catch (eBackup) {
                // Fall through to clean defaults if both copies are invalid.
            }
            const fallback = clone(DEFAULT_SETTINGS);
            fallback.fileDejavuOverrides = {};
            fallback.drawerState = {};
            fallback.protectedSnapshots = {};
            fallback.snapshotNotes = {};
            return fallback;
        }
    }

    save() {
        try {
            const serialized = JSON.stringify(state.settings);
            const previous = window.localStorage.getItem(STORAGE_KEY);
            if (previous) {
                window.localStorage.setItem(STORAGE_BACKUP_KEY, previous);
            }
            window.localStorage.setItem(STORAGE_KEY, serialized);
            return true;
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error(`[DejaVu] Settings save failed: ${e}`);
            if (el.footerHint) {
                setHint("Settings could not be stored locally.", "warn");
            }
            return false;
        }
    }
}

const settingsStore = new SettingsStore();

const restoredSnooze = loadPersistedSnoozeState();

const state = {
    settings: loadSettings(),
    timerId: null,
    lastFingerprint: null,
    lastSavedAt: null,
    nextTickAt: null,
    intervalTotalMs: 0,
    countdownId: null,
    pieRafId: null,
    isSaving: false,
    saveRequestedWhileBusy: false,
    retryTimerId: null,
    retryAt: 0,
    retryDelayMs: 0,
    consecutiveSaveFailures: 0,
    dotError: false,
    finalizingFolder: false,
    currentDejavuFolder: "",
    recoveryWarningPath: "",
    versions: [],
    selectedSnapshotPaths: {},
    selectedRecoveryPaths: {},
    latestSnapshot: null,
    currentDocKey: "",
    hasActiveDoc: false,
    activeInfo: null,
    documentSwitchSaveId: null,
    saveStartedAt: 0,
    savingShownAt: 0,
    savingClearTimer: null,
    sessionSaveCount: 0,
    sessionFailureCount: 0,
    sessionBytes: 0,
    sessionLastDurationMs: 0,
    currentSaveStartedAt: 0,
    snoozeUntil: restoredSnooze.until,
    snoozeStartedAt: restoredSnooze.startedAt,
    snoozeTotalMs: restoredSnooze.totalMs,
    snoozeTickId: null,
    installSignature: "",
    isPainting: false,
    paintState: null,
    paintStartPath: null,
    isPaintingPin: false,
    paintPinState: null,
    deleteConfirming: false,
    deleteConfirmTimer: null,
    docLastSaved: {},
    openDocsFirstSeen: {},
    openDocsCache: [],
    openDocsSelection: {},
    openDocsLastClickedKey: null,
    openDocsUnsavedOnly: false,
    openDocsRange: "all",
    openDocsBusy: false,
    periodicRefreshBusy: false,
    periodicRefreshId: null,
    refreshVersionsPromise: null,
    lastDiskSpaceCheckAt: 0,
    lastDiskSpaceSessionBytes: 0,
    lastCacheHealth: null
};

let crashHeartbeatId = null;

/**
 * Wires up all DOM event listeners.
 */
const bindEvents = () => {
    // Briefly flash a spin button's pressed style — used so keyboard arrows
    // give the same visual feedback as a mouse click (2.2).
    const flashSpinButton = (targetId, action) => {
        const btn = document.querySelector(
            `.number-spin-button[data-target="${targetId}"][data-action="${action}"]`
        );
        if (!btn) return;
        btn.classList.add("is-active");
        window.setTimeout(() => btn.classList.remove("is-active"), 140);
    };

    // Steps a number input by its step (optionally a factor, e.g. 10x for
    // Shift+Arrow), clamps to min/max, and notifies listeners. Dispatching
    // both input and change keeps the live UI and the persisted setting in
    // sync (number inputs persist on "change").
    const stepNumberInput = (input, action, factor) => {
        const min = parseFloat(input.getAttribute("min"));
        const max = parseFloat(input.getAttribute("max"));
        const step = (parseFloat(input.getAttribute("step")) || 1) * (factor || 1);
        let value = parseFloat(input.value) || 0;
        value += action === "up" ? step : -step;
        if (!isNaN(min) && value < min) value = min;
        if (!isNaN(max) && value > max) value = max;
        // Trim floating-point drift from fractional steps.
        value = Math.round(value * 1e6) / 1e6;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    // Custom spin button handlers for number inputs
    document.querySelectorAll(".number-spin-button").forEach((btn) => {
        btn.addEventListener("click", (evt) => {
            evt.preventDefault();
            const input = document.getElementById(btn.getAttribute("data-target"));
            if (!input) return;
            stepNumberInput(input, btn.getAttribute("data-action"), 1);
        });
    });

    // Keyboard arrows mirror the spin buttons: flash the matching button and,
    // with Shift held, step by 10x (2.2).
    document.querySelectorAll(
        ".number-input-group input[type=\"number\"]"
    ).forEach((input) => {
        input.addEventListener("keydown", (evt) => {
            if (evt.key !== "ArrowUp" && evt.key !== "ArrowDown") return;
            evt.preventDefault();
            const action = evt.key === "ArrowUp" ? "up" : "down";
            stepNumberInput(input, action, evt.shiftKey ? 10 : 1);
            flashSpinButton(input.id, action);
        });
    });

    const closeCustomSelectMenus = () => {
        document.querySelectorAll(".select-menu.is-open").forEach((menu) => {
            menu.classList.remove("is-open");
            menu.setAttribute("aria-hidden", "true");
            if (menu._selectWrap) menu._selectWrap.classList.remove("is-open");
        });
    };

    const positionCustomSelectMenu = (wrap, menu) => {
        const rect = wrap.getBoundingClientRect();
        const below = window.innerHeight - rect.bottom - 4;
        const above = rect.top - 4;
        const openBelow = below >= Math.min(menu.scrollHeight, 120) || below >= above;
        const maxHeight = Math.max(80, Math.min(280, openBelow ? below : above));

        menu.style.left = `${Math.round(rect.left)}px`;
        menu.style.minWidth = `${Math.round(rect.width)}px`;
        menu.style.maxHeight = `${Math.round(maxHeight)}px`;
        menu.style.top = openBelow
            ? `${Math.round(rect.bottom - 1)}px`
            : `${Math.round(Math.max(4, rect.top - Math.min(menu.scrollHeight, maxHeight) + 1))}px`;
    };

    const renderCustomSelectMenu = (wrap, select, menu) => {
        menu.innerHTML = "";
        Array.from(select.options).forEach((option, index) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "select-menu__item";
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(option.selected));
            item.disabled = option.disabled;
            item.dataset.index = String(index);

            const check = document.createElement("span");
            check.className = "select-menu__check";
            check.setAttribute("aria-hidden", "true");

            const label = document.createElement("span");
            label.className = "select-menu__label";
            label.textContent = option.textContent;

            item.appendChild(check);
            item.appendChild(label);
            item.addEventListener("click", () => {
                if (select.selectedIndex !== index) {
                    select.selectedIndex = index;
                    select.dispatchEvent(new Event("input", { bubbles: true }));
                    select.dispatchEvent(new Event("change", { bubbles: true }));
                }
                closeCustomSelectMenus();
                select.focus();
            });
            menu.appendChild(item);
        });
    };

    const openCustomSelectMenu = (wrap, select, menu) => {
        closeCustomSelectMenus();
        renderCustomSelectMenu(wrap, select, menu);
        menu._selectWrap = wrap;
        menu._select = select;
        menu.classList.add("is-open");
        menu.setAttribute("aria-hidden", "false");
        wrap.classList.add("is-open");
        positionCustomSelectMenu(wrap, menu);
    };

    const moveCustomSelectFocus = (menu, direction) => {
        const items = Array.from(menu.querySelectorAll(".select-menu__item:not(:disabled)"));
        if (!items.length) return;
        const activeIndex = items.indexOf(document.activeElement);
        let nextIndex = activeIndex + direction;
        if (activeIndex < 0) nextIndex = items.findIndex((item) => item.getAttribute("aria-selected") === "true");
        if (nextIndex < 0) nextIndex = items.length - 1;
        if (nextIndex >= items.length) nextIndex = 0;
        items[nextIndex].focus();
    };

    document.addEventListener("click", (evt) => {
        if (evt.target.closest(".select-wrapper") || evt.target.closest(".select-menu")) return;
        closeCustomSelectMenus();
    });
    window.addEventListener("resize", closeCustomSelectMenus);
    document.addEventListener("scroll", closeCustomSelectMenus, true);

    // Give every <select> a real chevron and replace the native popup with a
    // themed menu that can show the selected checkmark consistently in CEF.
    // Extracted so dynamically-rendered selects (e.g. the Similarity drawer)
    // can be enhanced after the fact via window.dejavuEnhanceSelects(root).
    const enhanceSelectWrapper = (wrap) => {
        if (!wrap.querySelector(".select-chevron")) {
            const chevron = document.createElement("span");
            chevron.className = "select-chevron";
            chevron.setAttribute("aria-hidden", "true");
            chevron.innerHTML =
                "<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" " +
                "stroke-width=\"2.5\" stroke-linecap=\"round\" " +
                "stroke-linejoin=\"round\"><path d=\"M2 6l6 4 6-4\"/></svg>";
            wrap.appendChild(chevron);
        }

        const select = wrap.querySelector("select");
        if (select && !select.dataset.openTracked) {
            select.dataset.openTracked = "1";
            const menu = document.createElement("div");
            menu.className = "select-menu";
            menu.setAttribute("role", "listbox");
            menu.setAttribute("aria-hidden", "true");
            document.body.appendChild(menu);

            select.addEventListener("mousedown", (evt) => {
                evt.preventDefault();
                select.focus();
                if (wrap.classList.contains("is-open")) closeCustomSelectMenus();
                else openCustomSelectMenu(wrap, select, menu);
            });
            select.addEventListener("keydown", (evt) => {
                if (evt.key === " " || evt.key === "Enter" ||
                    (evt.key === "ArrowDown" && evt.altKey)) {
                    evt.preventDefault();
                    openCustomSelectMenu(wrap, select, menu);
                    moveCustomSelectFocus(menu, 1);
                } else if (evt.key === "Escape" || evt.key === "Tab") {
                    closeCustomSelectMenus();
                }
            });
            select.addEventListener("change", closeCustomSelectMenus);
            menu.addEventListener("keydown", (evt) => {
                if (evt.key === "ArrowDown") {
                    evt.preventDefault();
                    moveCustomSelectFocus(menu, 1);
                } else if (evt.key === "ArrowUp") {
                    evt.preventDefault();
                    moveCustomSelectFocus(menu, -1);
                } else if (evt.key === "Home") {
                    evt.preventDefault();
                    const first = menu.querySelector(".select-menu__item:not(:disabled)");
                    if (first) first.focus();
                } else if (evt.key === "End") {
                    evt.preventDefault();
                    const items = menu.querySelectorAll(".select-menu__item:not(:disabled)");
                    if (items.length) items[items.length - 1].focus();
                } else if (evt.key === "Escape" || evt.key === "Tab") {
                    closeCustomSelectMenus();
                    select.focus();
                }
            });
        }
    };
    window.dejavuEnhanceSelects = (root) => {
        (root || document)
            .querySelectorAll(".select-wrapper")
            .forEach(enhanceSelectWrapper);
    };
    window.dejavuEnhanceSelects(document);

    el.modeSegButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
            if (btn.disabled) return;
            const mode = btn.dataset.mode;
            const wasEnabled = isDejavuEnabledForCurrent();
            applyDejavuMode(mode);
            const nowEnabled = isDejavuEnabledForCurrent();
            setHint(
                `Dejavu ${getDejavuModeLabel(mode)}.`,
                nowEnabled ? "ok" : ""
            );
            if (
                !wasEnabled &&
                nowEnabled &&
                state.settings.saveImmediatelyOnEnable !== false
            ) {
                window.setTimeout(() => {
                    runDejavuCycle(true).catch((err) => {
                        setHint(
                            `Immediate dejavu failed: ${(err && err.message ? err.message : err)}`,
                            "warn"
                        );
                    });
                }, 150);
            }
        });
    });

    el.intervalInput.addEventListener("change", () => {
        state.settings.intervalValue = Math.max(
            1,
            parseInt(el.intervalInput.value, 10) || 1
        );
        el.intervalInput.value = state.settings.intervalValue;
        saveSettings();
        syncIntervalPresets();
        syncSafetyProfiles();
        if (isDejavuEnabledForCurrent()) startLoop();
    });

    el.intervalUnit.addEventListener("change", () => {
        const oldUnit = parseInt(state.settings.intervalUnit, 10) || 60;
        const newUnit = parseInt(el.intervalUnit.value, 10) || 60;
        convertIntervalUnit(oldUnit, newUnit);
        saveSettings();
        if (isDejavuEnabledForCurrent()) startLoop();
    });

    if (el.intervalPresets) {
        el.intervalPresets.addEventListener("click", (evt) => {
            const target = evt.target;
            if (!target || !target.getAttribute) return;
            const seconds = target.getAttribute("data-seconds");
            if (!seconds) return;
            applyIntervalSeconds(parseInt(seconds, 10));
        });
    }

    if (el.safetyProfiles) {
        el.safetyProfiles.addEventListener("click", (evt) => {
            const chip = evt.target && evt.target.closest
                ? evt.target.closest("[data-profile]")
                : null;
            if (!chip) return;
            applySafetyProfile(chip.getAttribute("data-profile"));
        });
    }

    if (el.templatePresets) {
        el.templatePresets.addEventListener("click", (evt) => {
            const chip = evt.target && evt.target.closest
                ? evt.target.closest("[data-template]")
                : null;
            if (!chip) return;
            applyTemplateString(chip.getAttribute("data-template"));
        });
    }

    el.browseFolderBtn.addEventListener("click", () => {
        callHost("dejavu_chooseFolder", [state.settings.folder || ""]).then((result) => {
            if (!result || !result.ok) {
                return;
            }
            if (!isValidFolderValue(result.path)) {
                return;
            }
            applyFolderSelection(result.path);
            setHint("Folder set.", "ok");
        });
    });

    if (el.folderInput) {
        el.folderInput.addEventListener("input", onFolderInputTyped);
    }

    // Filename template editor is now managed by the TokenInput
    // library (see setupFilenameTokenInput); the folder template uses a
    // dedicated editor whose only editable region is the middle segment
    // between the fixed $defaultFolder and $filename tokens.
    bindFolderTemplateEditor();

    el.overwriteToggle.addEventListener("change", () => {
        state.settings.overwriteExisting = el.overwriteToggle.checked;
        saveSettings();
        updatePreview();
        syncSafetyProfiles();
    });

    el.onlyIfChangedToggle.addEventListener("change", () => {
        state.settings.onlySaveWhenChanged =
            el.onlyIfChangedToggle.checked;
        saveSettings();
    });

    el.keepCountInput.addEventListener("change", () => {
        state.settings.keepCount = readNumberInput(el.keepCountInput, 20);
        el.keepCountInput.value = state.settings.keepCount;
        saveSettings();
        updateTimelineInsights();
        syncSafetyProfiles();
    });

    el.keepDaysInput.addEventListener("change", () => {
        state.settings.keepDays = readNumberInput(el.keepDaysInput, 0);
        el.keepDaysInput.value = state.settings.keepDays;
        saveSettings();
        updateTimelineInsights();
    });

    el.maxFolderSizeInput.addEventListener("change", () => {
        state.settings.maxFolderSizeMb = readNumberInput(el.maxFolderSizeInput, 0);
        el.maxFolderSizeInput.value = state.settings.maxFolderSizeMb;
        saveSettings();
        updateTimelineInsights();
    });

    if (el.diskSpaceWarningInput) {
        el.diskSpaceWarningInput.addEventListener("change", () => {
            state.settings.diskSpaceWarningMb = readNumberInput(
                el.diskSpaceWarningInput,
                1024
            );
            el.diskSpaceWarningInput.value = state.settings.diskSpaceWarningMb;
            saveSettings();
            auditCacheHealth({ quiet: true });
        });
    }

    if (el.diskSpaceRefreshInput) {
        el.diskSpaceRefreshInput.addEventListener("change", () => {
            state.settings.diskSpaceRefreshMb = Math.max(
                1,
                readNumberInput(el.diskSpaceRefreshInput, 256)
            );
            el.diskSpaceRefreshInput.value = state.settings.diskSpaceRefreshMb;
            saveSettings();
        });
    }

    if (el.recoveryVersionsInput) {
        el.recoveryVersionsInput.addEventListener("change", () => {
            state.settings.recoveryVersionsPerUnsavedDoc = Math.max(
                1,
                Math.min(20, readNumberInput(el.recoveryVersionsInput, 5))
            );
            el.recoveryVersionsInput.value =
                state.settings.recoveryVersionsPerUnsavedDoc;
            saveSettings();
            writeLocalJson(
                RECOVERY_CANDIDATES_KEY,
                trimRecoveryCandidates(getRecoveryCandidates())
            );
            renderRecoveryCenter();
        });
    }

    if (el.recoveryMaxEntriesInput) {
        el.recoveryMaxEntriesInput.addEventListener("change", () => {
            state.settings.recoveryMaxCandidates = Math.max(
                10,
                Math.min(500, readNumberInput(el.recoveryMaxEntriesInput, 80))
            );
            el.recoveryMaxEntriesInput.value =
                state.settings.recoveryMaxCandidates;
            saveSettings();
            writeLocalJson(
                RECOVERY_CANDIDATES_KEY,
                trimRecoveryCandidates(getRecoveryCandidates())
            );
            renderRecoveryCenter();
        });
    }

    el.recoveryCheckToggle.addEventListener("change", () => {
        state.settings.recoveryCheck = el.recoveryCheckToggle.checked;
        saveSettings();
    });

    el.autoRecoverCrashToggle.addEventListener("change", () => {
        state.settings.autoRecoverAfterCrash =
            el.autoRecoverCrashToggle.checked;
        saveSettings();
    });

    if (el.checkForUpdatesToggle) {
        el.checkForUpdatesToggle.addEventListener("change", () => {
            state.settings.checkForUpdates =
                el.checkForUpdatesToggle.checked;
            saveSettings();
        });
    }

    el.autoPinEveryInput.addEventListener("change", () => {
        state.settings.autoPinEvery = Math.max(
            0,
            parseInt(el.autoPinEveryInput.value, 10) || 0
        );
        el.autoPinEveryInput.value = state.settings.autoPinEvery;
        saveSettings();
    });

    el.recoveryCompactToggle.addEventListener("click", () => {
        const on = !toggleIconIsOn(el.recoveryCompactToggle);
        setToggleIcon(el.recoveryCompactToggle, on);
        state.settings.recoveryCompact = on;
        saveSettings();
        renderRecoveryCenter();
    });

    el.recoveryPinnedOnlyToggle.addEventListener("click", () => {
        const on = !toggleIconIsOn(el.recoveryPinnedOnlyToggle);
        setToggleIcon(el.recoveryPinnedOnlyToggle, on);
        state.settings.recoveryPinnedOnly = on;
        saveSettings();
        renderRecoveryCenter();
    });

    if (el.recoverySelectAllToggle) {
        el.recoverySelectAllToggle.addEventListener("click", () => {
            const on = !toggleIconIsOn(el.recoverySelectAllToggle);
            const table = getRecoveryTable();
            if (table) {
                table.toggleAllVisible(on);
                return;
            }
            if (!state.selectedRecoveryPaths) state.selectedRecoveryPaths = {};
            getVisibleRecoveryCandidates().forEach((candidate) => {
                if (candidate && candidate.path) {
                    state.selectedRecoveryPaths[candidate.path] = on;
                    if (!on) delete state.selectedRecoveryPaths[candidate.path];
                }
            });
            updateRecoveryBulkBar();
            renderRecoveryCenter();
        });
    }

    el.recoveryFilterInput.addEventListener("input", () => {
        state.settings.recoveryFilter = el.recoveryFilterInput.value || "";
        saveSettings();
        renderRecoveryCenter();
    });

    el.recoverySortSelect.addEventListener("change", () => {
        state.settings.recoverySort = el.recoverySortSelect.value;
        saveSettings();
        renderRecoveryCenter();
    });

    el.recoveryRangeSelect.addEventListener("change", () => {
        state.settings.recoveryRange = el.recoveryRangeSelect.value;
        saveSettings();
        renderRecoveryCenter();
    });

    el.recoveryBulkCopyPathsBtn.addEventListener("click", () => {
        const paths = getSelectedRecoveryPaths();
        if (paths.length === 0) return;
        const text = paths.join("\n");
        copyToClipboard(text);
        setHint(`Copied ${paths.length} path(s) to clipboard.`, "ok");
    });

    el.recoveryBulkDelBtn.addEventListener("click", () => {
        const paths = getSelectedRecoveryPaths();
        if (paths.length === 0) return;
        bulkDeleteRecoveryEntries(paths);
    });

    let recoveryClearArmed = false;
    let recoveryClearDisarmTimer = null;

    const disarmRecoveryClear = () => {
        recoveryClearArmed = false;
        el.recoveryBulkClearBtn.textContent = "Clear";
        el.recoveryBulkClearBtn.classList.remove("btn--danger-armed");
        if (recoveryClearDisarmTimer) {
            window.clearTimeout(recoveryClearDisarmTimer);
            recoveryClearDisarmTimer = null;
        }
    };

    el.recoveryBulkClearBtn.addEventListener("click", () => {
        if (!recoveryClearArmed) {
            recoveryClearArmed = true;
            el.recoveryBulkClearBtn.textContent = "Confirm";
            el.recoveryBulkClearBtn.classList.add("btn--danger-armed");
            recoveryClearDisarmTimer = window.setTimeout(disarmRecoveryClear, 4000);
            return;
        }
        disarmRecoveryClear();
        clearRecoverySelection();
    });

    el.recoveryExportCsvBtn.addEventListener("click", () => {
        const candidates = getRecoveryCandidates();
        if (!candidates || candidates.length === 0) {
            setHint("No recovery entries to export.", "warn");
            return;
        }
        const rows = [["Timestamp", "Name", "Pinned", "Note", "Path"]];
        [...candidates].sort((a, b) => {
            return (b.timestamp || 0) - (a.timestamp || 0);
        }).forEach((candidate) => {
            rows.push([
                new Date(candidate.timestamp).toISOString(),
                candidate.name,
                isSnapshotProtected(candidate.path) ? "yes" : "no",
                (state.settings.snapshotNotes && state.settings.snapshotNotes[candidate.path]) || "",
                candidate.path
            ]);
        });
        const csv = rows.map((row) => {
            return row.map(csvCell).join(",");
        }).join("\r\n");
        callHost("dejavu_saveTextFile", [
            "recovery-history.csv",
            csv
        ]).then((result) => {
            if (result && result.ok) {
                setHint(`Recovery CSV exported: ${result.path}`, "ok");
            } else if (result && result.cancelled) {
                setHint("Recovery export cancelled.");
            } else {
                setHint(`Recovery export failed: ${(result && result.error ? result.error : "unknown")}`, "warn");
            }
        });
    });

    // Disarm all armed buttons when clicking outside them
    document.addEventListener("click", (evt) => {
        const target = evt.target;
        if (clearArmed && !el.bulkClearBtn.contains(target)) {
            disarmClear();
        }
        if (recoveryClearArmed && !el.recoveryBulkClearBtn.contains(target)) {
            disarmRecoveryClear();
        }
    });

    el.backupOriginalToggle.addEventListener("change", () => {
        state.settings.backupOriginalBeforeDejavu =
            el.backupOriginalToggle.checked;
        saveSettings();
    });

    el.saveOnEnableToggle.addEventListener("change", () => {
        state.settings.saveImmediatelyOnEnable =
            el.saveOnEnableToggle.checked;
        saveSettings();
    });

    el.saveOnDocumentSwitchToggle.addEventListener("change", () => {
        state.settings.saveOnDocumentSwitch =
            el.saveOnDocumentSwitchToggle.checked;
        saveSettings();
    });

    el.autoRefreshTimelineToggle.addEventListener("click", () => {
        const on = !toggleIconIsOn(el.autoRefreshTimelineToggle);
        setToggleIcon(el.autoRefreshTimelineToggle, on);
        state.settings.autoRefreshTimeline = on;
        saveSettings();
        if (on) refreshVersions(true);
    });

    if (el.timelineSelectAllToggle) {
        el.timelineSelectAllToggle.addEventListener("click", () => {
            const on = !toggleIconIsOn(el.timelineSelectAllToggle);
            const table = getTimelineTable();
            if (table) {
                table.toggleAllVisible(on);
                return;
            }
            getVisibleSnapshots().forEach((item) => {
                if (item && item.path) {
                    state.selectedSnapshotPaths[item.path] = on;
                    if (!on) delete state.selectedSnapshotPaths[item.path];
                }
            });
            updateTimelineBulkBar();
            rerenderTimeline();
        });
    }

    if (el.openDocsSelectAllToggle) {
        el.openDocsSelectAllToggle.addEventListener("click", () => {
            const on = !toggleIconIsOn(el.openDocsSelectAllToggle);
            visibleOpenDocs().forEach((doc) => {
                setOpenDocSelected(docKeyForListedDoc(doc), on);
            });
            renderOpenDocuments(state.openDocsCache);
        });
    }
    if (el.openDocsUnsavedOnlyToggle) {
        el.openDocsUnsavedOnlyToggle.addEventListener("click", () => {
            const on = !toggleIconIsOn(el.openDocsUnsavedOnlyToggle);
            setToggleIcon(el.openDocsUnsavedOnlyToggle, on);
            state.openDocsUnsavedOnly = on;
            renderOpenDocuments(state.openDocsCache);
        });
    }
    if (el.openDocsFilterInput) {
        el.openDocsFilterInput.addEventListener("input", () => {
            state.openDocsFilter = el.openDocsFilterInput.value || "";
            renderOpenDocuments(state.openDocsCache);
        });
    }
    if (el.openDocsSortSelect) {
        el.openDocsSortSelect.addEventListener("change", () => {
            state.openDocsSort = el.openDocsSortSelect.value || "newest";
            renderOpenDocuments(state.openDocsCache);
        });
    }
    if (el.openDocsRangeSelect) {
        el.openDocsRangeSelect.addEventListener("change", () => {
            state.openDocsRange = el.openDocsRangeSelect.value || "all";
            renderOpenDocuments(state.openDocsCache);
        });
    }
    if (el.openDocsSaveAllBtn) {
        el.openDocsSaveAllBtn.addEventListener("click", () => {
            saveOpenDocs(state.openDocsCache.slice());
        });
    }
    if (el.openDocsBulkOnBtn) {
        el.openDocsBulkOnBtn.addEventListener("click", () => {
            bulkSetDejavuSelected(true);
        });
    }
    if (el.openDocsBulkOffBtn) {
        el.openDocsBulkOffBtn.addEventListener("click", () => {
            bulkSetDejavuSelected(false);
        });
    }
    if (el.openDocsBulkSaveBtn) {
        el.openDocsBulkSaveBtn.addEventListener("click", () => {
            saveOpenDocs(selectedOpenDocs());
        });
    }
    initOpenDocsBulkSaveMenu();

    el.timelineCompactToggle.addEventListener("click", () => {
        const on = !toggleIconIsOn(el.timelineCompactToggle);
        setToggleIcon(el.timelineCompactToggle, on);
        state.settings.timelineCompact = on;
        saveSettings();
        rerenderTimeline();
    });

    el.timelinePinnedOnlyToggle.addEventListener("click", () => {
        const on = !toggleIconIsOn(el.timelinePinnedOnlyToggle);
        setToggleIcon(el.timelinePinnedOnlyToggle, on);
        state.settings.timelinePinnedOnly = on;
        saveSettings();
        rerenderTimeline();
    });

    el.timelineFilterInput.addEventListener("input", () => {
        state.settings.timelineFilter = el.timelineFilterInput.value || "";
        saveSettings();
        rerenderTimeline();
    });

    el.timelineSortSelect.addEventListener("change", () => {
        state.settings.timelineSort = normalizeTimelineSort(
            el.timelineSortSelect.value
        );
        saveSettings();
        rerenderTimeline();
    });

    el.timelineRangeSelect.addEventListener("change", () => {
        state.settings.timelineRange = normalizeTimelineRange(
            el.timelineRangeSelect.value
        );
        saveSettings();
        rerenderTimeline();
    });

    el.refreshVersionsBtn.addEventListener("click", () => {
        refreshVersions(true);
    });

    el.exportTimelineBtn.addEventListener("click", exportTimelineCsv);
    el.bulkCopyPathsBtn.addEventListener(
        "click",
        copySelectedSnapshotPaths
    );
    el.bulkDelBtn.addEventListener("click", bulkDeleteSelected);
    el.bulkClearBtn.addEventListener("click", () => {
        if (!clearArmed) {
            clearArmed = true;
            el.bulkClearBtn.textContent = "Confirm";
            el.bulkClearBtn.classList.add("btn--danger-armed");
            clearDisarmTimer = window.setTimeout(disarmClear, 4000);
            return;
        }
        disarmClear();
        clearSnapshotSelection();
    });

    el.revealLogBtn.addEventListener("click", () => {
        callHost("dejavu_getLogPath", []).then((result) => {
            if (result && result.ok) revealPath(result.path);
        });
    });

    el.healthCheckBtn.addEventListener("click", () => {
        runHealthCheck();
    });

    if (el.cacheDiskSpaceRefresh) {
        el.cacheDiskSpaceRefresh.addEventListener("click", () => {
            auditCacheHealth({ quiet: false });
        });
    }

    el.clearTemplateBtn.addEventListener("click", () => {
        applyTemplateString(DEFAULT_SETTINGS.template);
        setHint("Filename template restored to default.", "ok");
    });

    el.exportSettingsBtn.addEventListener("click", () => {
        exportSettings();
    });

    el.importSettingsBtn.addEventListener("click", () => {
        el.importSettingsInput.value = "";
        el.importSettingsInput.click();
    });

    el.importSettingsInput.addEventListener("change", () => {
        const file = el.importSettingsInput.files && el.importSettingsInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                importSettingsObject(JSON.parse(String(reader.result || "{}")));
            } catch (eParse) {
                setHint("Import failed: invalid JSON.", "warn");
            }
        };
        reader.readAsText(file);
    });

    let resetSettingsArmed = false;
    let resetSettingsDisarmTimer = null;
    const disarmHeaderReset = () => {
        resetSettingsArmed = false;
        el.headerResetSettingsBtn.classList.remove("is-armed");
        el.headerResetSettingsBtn.setAttribute(
            "aria-label",
            "Reset settings"
        );
        el.headerResetSettingsBtn.title = "Reset settings";
        if (resetSettingsDisarmTimer !== null) {
            window.clearTimeout(resetSettingsDisarmTimer);
            resetSettingsDisarmTimer = null;
        }
    };
    el.headerResetSettingsBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (!resetSettingsArmed) {
            resetSettingsArmed = true;
            el.headerResetSettingsBtn.classList.add("is-armed");
            el.headerResetSettingsBtn.setAttribute(
                "aria-label",
                "Confirm reset settings"
            );
            el.headerResetSettingsBtn.title =
                "Click again to reset all settings";
            setHint("Click the red reset icon again to confirm.", "warn");
            resetSettingsDisarmTimer = window.setTimeout(
                disarmHeaderReset,
                4000
            );
            return;
        }
        disarmHeaderReset();
        resetSettings();
    });
    document.addEventListener("click", disarmHeaderReset);
    window.addEventListener("blur", disarmHeaderReset);
    window.addEventListener("mouseup", () => {
        const wasPainting = state.isPainting;
        state.isPainting = false;
        state.paintState = null;
        state.paintStartPath = null;
        state.isPaintingPin = false;
        state.paintPinState = null;
        // Rerender after painting ends to update UI
        if (wasPainting) {
            rerenderTimeline();
            rerenderRecoveryCenter();
        }
    });

    if (el.snoozeChips) {
        el.snoozeChips.addEventListener("click", (evt) => {
            const untilChip = evt.target && evt.target.closest
                ? evt.target.closest("[data-snooze-until]")
                : null;
            if (untilChip) {
                snoozeUntilTomorrow();
                return;
            }
            const chip = evt.target && evt.target.closest
                ? evt.target.closest("[data-snooze]")
                : null;
            if (!chip) return;
            snoozeFor(parseInt(chip.getAttribute("data-snooze"), 10) || 900);
        });
    }
    if (el.snoozeResumeBtn) {
        el.snoozeResumeBtn.addEventListener("click", resumeFromSnooze);
    }

    if (el.donationInfoBtn) {
        el.donationInfoBtn.addEventListener("click", () => {
            showDonationSplash(true);
        });
    }

    if (el.donationCloseBtn) {
        el.donationCloseBtn.addEventListener("click", () => {
            closeDonationSplash();
        });
    }

    if (el.donationLaterBtn) {
        el.donationLaterBtn.addEventListener("click", () => {
            closeDonationSplash();
        });
    }

    if (el.donationScrim) {
        el.donationScrim.addEventListener("click", () => {
            closeDonationSplash();
        });
    }

    if (el.donationPayBtn) {
        el.donationPayBtn.addEventListener("click", () => {
            openDonationPayment();
        });
    }

    if (el.donationAmountInput) {
        el.donationAmountInput.addEventListener("change", () => {
            el.donationAmountInput.value = normalizeDonationAmount(
                el.donationAmountInput.value
            );
        });
    }

    if (el.donationCurrencySelect) {
        el.donationCurrencySelect.addEventListener("change", () => {
            el.donationCurrencySelect.value = normalizeDonationCurrency(
                el.donationCurrencySelect.value
            );
        });
    }

    if (el.donationPlatformSelect) {
        el.donationPlatformSelect.addEventListener("change", () => {
            el.donationPlatformSelect.value = normalizeDonationPlatform(
                el.donationPlatformSelect.value
            );
            renderDonationPlatformButton();
        });
    }

    if (el.folderStatusValue) {
        let folderClickTimer = null;
        el.folderStatusValue.addEventListener("click", () => {
            if (folderClickTimer !== null) {
                window.clearTimeout(folderClickTimer);
            }
            folderClickTimer = window.setTimeout(() => {
                folderClickTimer = null;
                revealCurrentDejavuFolder();
            }, 230);
        });
        el.folderStatusValue.addEventListener("dblclick", (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            if (folderClickTimer !== null) {
                window.clearTimeout(folderClickTimer);
                folderClickTimer = null;
            }
            el.folderBalloon.hidden = false;
            el.folderBalloonCopyBtn.focus();
        });
        el.folderStatusValue.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter" || evt.key === " ") {
                evt.preventDefault();
                revealCurrentDejavuFolder();
            }
        });
    }
    el.folderBalloonCopyBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        let folder = state.currentDejavuFolder;
        if (!isValidFolderValue(folder)) folder = state.settings.folder || "";
        copyTextToClipboard(folder);
        el.folderBalloon.hidden = true;
    });
    document.addEventListener("click", (evt) => {
        if (
            !el.folderBalloon.hidden &&
            !el.folderBalloon.contains(evt.target) &&
            evt.target !== el.folderStatusValue
        ) {
            el.folderBalloon.hidden = true;
        }
    });

    document.addEventListener("keydown", (evt) => {
        if (
            String(evt.key) === "Escape" &&
            el.folderBalloon &&
            !el.folderBalloon.hidden
        ) {
            evt.preventDefault();
            el.folderBalloon.hidden = true;
            el.folderStatusValue.focus();
            return;
        }
        if (
            String(evt.key) === "Escape" &&
            el.donationModal &&
            !el.donationModal.classList.contains("donation-modal--hidden")
        ) {
            evt.preventDefault();
            closeDonationSplash();
            return;
        }
        const mod = evt.metaKey || evt.ctrlKey;
        if (!mod || evt.altKey) return;
        if (evt.shiftKey && String(evt.key).toLowerCase() === "s") {
            evt.preventDefault();
            runDejavuCycle(true);
        } else if (evt.shiftKey && String(evt.key).toLowerCase() === "r") {
            evt.preventDefault();
            refreshVersions(true);
        }
    });
};

/**
 * Runs the background status refresh as one serialized transaction.
 * Skipping hidden/busy ticks prevents overlapping host calls when
 * Illustrator is occupied or the panel is not visible.
 */
const runPeriodicRefresh = () => {
    if (state.periodicRefreshBusy || document.hidden) return;
    state.periodicRefreshBusy = true;
    refreshDocStatus().then(() => {
        return refreshVersions(false);
    }).then(() => {
        return checkRecoveryWarning();
    }).then(() => {
        // The overview only matters while it's expanded.
        if (el.openDocsDrawer && el.openDocsDrawer.open) {
            return refreshOpenDocuments();
        }
    }).then(() => {
        state.periodicRefreshBusy = false;
    }, (err) => {
        state.periodicRefreshBusy = false;
        // eslint-disable-next-line no-console
        console.error(`[DejaVu] Background refresh failed: ${err}`);
    });
};

/**
 * Tooltip — a single shared, themed hover/focus tooltip that stands
 * in for the slow, unstyled native title tooltip. It is fully
 * delegated, so any element carrying a `title` (or `data-tooltip`)
 * attribute gets one automatically, including rows rendered after
 * init. The native title is stashed and removed while the element is
 * hovered (so the OS tooltip never double-shows) and restored on
 * leave, keeping the attribute available for assistive tech at rest.
 */
const Tooltip = (() => {
    let box = null;
    let armed = null;
    let timer = null;

    const ensureBox = () => {
        if (!box) {
            box = document.createElement("div");
            box.className = "tooltip";
            box.setAttribute("role", "tooltip");
            document.body.appendChild(box);
        }
        return box;
    };

    const targetFrom = (node) => {
        while (node && node.nodeType === 1 && node !== document.body) {
            if (node.getAttribute("data-tooltip") ||
                node.getAttribute("title")) {
                return node;
            }
            node = node.parentNode;
        }
        return null;
    };

    const disarm = () => {
        window.clearTimeout(timer);
        if (armed) {
            const saved = armed.getAttribute("data-tt-title");
            if (saved !== null && !armed.getAttribute("title")) {
                armed.setAttribute("title", saved);
            }
            armed.removeAttribute("data-tt-title");
            armed = null;
        }
        if (box) box.classList.remove("tooltip--visible");
    };

    const reveal = (target) => {
        if (armed !== target) return;
        const text = target.getAttribute("data-tooltip") ||
            target.getAttribute("data-tt-title") || "";
        if (!text) return;
        const b = ensureBox();
        b.textContent = text;
        b.classList.add("tooltip--visible");
        const r = target.getBoundingClientRect();
        const gap = 6;
        let left = r.left + r.width / 2 - b.offsetWidth / 2;
        let top = r.top - b.offsetHeight - gap;
        const below = top < 4;
        if (below) top = r.bottom + gap;
        left = Math.max(
            4, Math.min(left, window.innerWidth - b.offsetWidth - 4)
        );
        b.style.left = `${Math.round(left)}px`;
        b.style.top = `${Math.round(top)}px`;
        b.classList.toggle("tooltip--below", below);
    };

    const arm = (target, immediate) => {
        armed = target;
        const native = target.getAttribute("title");
        if (native) {
            target.setAttribute("data-tt-title", native);
            target.removeAttribute("title");
        }
        window.clearTimeout(timer);
        if (immediate) {
            reveal(target);
        } else {
            timer = window.setTimeout(() => {
                reveal(target);
            }, 320);
        }
    };

    const onOver = (evt) => {
        const target = targetFrom(evt.target);
        if (!target || target === armed) return;
        disarm();
        arm(target, false);
    };

    const onOut = (evt) => {
        if (!armed) return;
        if (!evt.relatedTarget || !armed.contains(evt.relatedTarget)) {
            disarm();
        }
    };

    const init = () => {
        document.addEventListener("mouseover", onOver);
        document.addEventListener("mouseout", onOut);
        document.addEventListener("focusin", (evt) => {
            // Only surface the tooltip for keyboard focus. A mouse click also
            // focuses the element, and we don't want the tooltip popping up on
            // click — hover (mouseover) is the pointer trigger.
            const focused = evt.target;
            let keyboardFocus = false;
            try {
                keyboardFocus = !!focused &&
                    typeof focused.matches === "function" &&
                    focused.matches(":focus-visible");
            } catch (e) {
                keyboardFocus = false;
            }
            if (!keyboardFocus) return;
            const target = targetFrom(focused);
            if (target && target !== armed) {
                disarm();
                arm(target, true);
            }
        });
        document.addEventListener("focusout", disarm);
        document.addEventListener("mousedown", disarm, true);
        window.addEventListener("scroll", disarm, true);
    };

    return { init, hide: disarm };
})();

// ---- Adaptive panel height --------------------------------------

let panelResizeRaf = null;
let lastPanelHeight = 0;
let panelObserver = null;

// Panel geometry bounds from CSXS/manifest.xml.
const PANEL_MIN_HEIGHT = 480;
const PANEL_MAX_HEIGHT = 1000;
const PANEL_MIN_WIDTH = 450;
const PANEL_MAX_WIDTH = 600;

/**
 * Measures the panel's *natural* content height by summing the
 * heights of the .app's direct children. The footer is pinned with
 * margin-top:auto, so we deliberately ignore that flexible gap (and
 * any element's auto margin) — otherwise an over-tall panel would
 * always measure back its own viewport height and never shrink.
 * @return {number} Content height in CSS pixels.
 */
const naturalContentHeight = () => {
    const app = el.app;
    if (!app) return 0;
    let total = 0;
    const kids = app.children;
    for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        const cs = window.getComputedStyle(child);
        if (cs.display === "none") continue;
        total += child.offsetHeight;
        total += parseFloat(cs.marginBottom) || 0;
        // Skip the footer's auto top margin (the flexible spacer).
        if (!child.classList.contains("app__footer")) {
            total += parseFloat(cs.marginTop) || 0;
        }
    }
    const as = window.getComputedStyle(app);
    total += (parseFloat(as.paddingTop) || 0) +
        (parseFloat(as.paddingBottom) || 0);
    return Math.ceil(total);
};

/** Resizes the host panel to fit the current content height. */
const applyPanelAutoSize = () => {
    if (state.settings.autoFitPanel === false) return;
    let height = naturalContentHeight();
    if (!height) return;
    height = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, height));
    if (Math.abs(height - lastPanelHeight) < 2) return;
    lastPanelHeight = height;
    const width = Math.max(
        PANEL_MIN_WIDTH,
        Math.min(PANEL_MAX_WIDTH, Math.round(window.innerWidth) || 500)
    );
    if (
        DEJAVU_IS_CEP &&
        csInterface &&
        typeof csInterface.resizeContent === "function"
    ) {
        csInterface.resizeContent(width, height);
    }
};

/** Coalesces resize requests to once per animation frame. */
const schedulePanelAutoSize = () => {
    if (panelResizeRaf) return;
    panelResizeRaf = window.requestAnimationFrame(() => {
        panelResizeRaf = null;
        applyPanelAutoSize();
    });
};

/**
 * Watches the app subtree for the structural changes that affect
 * height (drawers opening, lists re-rendering, bars showing/hiding)
 * and re-fits the panel. Text-only mutations are ignored so the
 * once-a-second countdown does not thrash the host.
 */
const initPanelAutoSize = () => {
    el.app = el.app || document.querySelector(".app");
    if (!el.app || typeof window.MutationObserver !== "function") return;
    panelObserver = new MutationObserver(schedulePanelAutoSize);
    panelObserver.observe(el.app, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["open", "hidden", "class", "style"]
    });
    schedulePanelAutoSize();
};

// ---- Native panel flyout ("hamburger") menu ---------------------

const escapeMenuXml = (value) => {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
};

const flyoutMenuItem = (id, label, checked) => {
    return `<MenuItem Id="${escapeMenuXml(id)}" Label="${escapeMenuXml(label)}" Enabled="true" Checked="${checked ? "true" : "false"}"/>`;
};

const updateFlyoutMenuState = () => {
    if (
        !DEJAVU_IS_CEP ||
        !csInterface ||
        typeof csInterface.updatePanelMenuItem !== "function"
    ) {
        return;
    }
    const autoFit = state.settings.autoFitPanel !== false;
    const hasDocument = !!state.hasActiveDoc;
    const snoozed = isSnoozed();
    csInterface.updatePanelMenuItem(
        FLYOUT_MENU_LABELS.autoFitPanel,
        true,
        autoFit
    );
    csInterface.updatePanelMenuItem(
        FLYOUT_MENU_LABELS.dejavuNow,
        hasDocument,
        false
    );
    csInterface.updatePanelMenuItem(
        FLYOUT_MENU_LABELS.createCheckpoint,
        hasDocument,
        false
    );
    csInterface.updatePanelMenuItem(
        FLYOUT_MENU_LABELS.pauseFive,
        isDejavuEnabledForCurrent() && !snoozed,
        false
    );
    csInterface.updatePanelMenuItem(
        FLYOUT_MENU_LABELS.resume,
        snoozed,
        false
    );
};

const openPanelDrawer = (drawerId) => {
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;
    drawer.open = true;
    drawer.scrollIntoView({ block: "nearest" });
    if (drawerId === "openDocsDrawer") refreshOpenDocuments();
    if (drawerId === "versionDrawer") refreshVersions(true);
    if (drawerId === "recoveryCenterDrawer") renderRecoveryCenter();
    schedulePanelAutoSize();
};

const handleFlyoutMenuClick = (event) => {
    let data = event && event.data;
    if (typeof data === "string") {
        try {
            data = JSON.parse(data);
        } catch (e) {}
    }
    let menuId = data && (data.menuId || data.menuID || data.id);
    if (!menuId && data && data.menuName) {
        Object.keys(FLYOUT_MENU_LABELS).some((key) => {
            if (FLYOUT_MENU_LABELS[key] === data.menuName) {
                menuId = FLYOUT_MENU_IDS[key];
                return true;
            }
            return false;
        });
    }
    switch (menuId) {
    case FLYOUT_MENU_IDS.autoFitPanel:
        state.settings.autoFitPanel = state.settings.autoFitPanel === false;
        saveSettings();
        updateFlyoutMenuState();
        if (state.settings.autoFitPanel !== false) {
            lastPanelHeight = 0;
            schedulePanelAutoSize();
        }
        setHint(
            state.settings.autoFitPanel !== false
                ? "Panel auto-adjust enabled."
                : "Panel auto-adjust disabled.",
            "ok"
        );
        break;
    case FLYOUT_MENU_IDS.dejavuNow:
        runDejavuCycle(true).catch((err) => {
            setHint(
                `Dejavu failed: ${(err && err.message ? err.message : err)}`,
                "warn"
            );
        });
        break;
    case FLYOUT_MENU_IDS.createCheckpoint:
        createNamedCheckpoint();
        break;
    case FLYOUT_MENU_IDS.refreshStatus:
        refreshDocStatus().then(() => refreshOpenDocuments()).then(() => {
            setHint("Status refreshed.", "ok");
        }).catch((err) => {
            setHint(
                `Refresh failed: ${(err && err.message ? err.message : err)}`,
                "warn"
            );
        });
        break;
    case FLYOUT_MENU_IDS.refreshTimeline:
        refreshVersions(true).catch((err) => {
            setHint(
                `Timeline refresh failed: ${(err && err.message ? err.message : err)}`,
                "warn"
            );
        });
        break;
    case FLYOUT_MENU_IDS.revealFolder:
        revealPath(state.currentDejavuFolder || state.settings.folder || "~/");
        break;
    case FLYOUT_MENU_IDS.checkForUpdates:
        if (typeof window.dejavu_checkForUpdatesNow === "function") {
            window.dejavu_checkForUpdatesNow();
        }
        break;
    case FLYOUT_MENU_IDS.openTimeline:
        openPanelDrawer("versionDrawer");
        break;
    case FLYOUT_MENU_IDS.openRecovery:
        openPanelDrawer("recoveryCenterDrawer");
        break;
    case FLYOUT_MENU_IDS.openDocuments:
        openPanelDrawer("openDocsDrawer");
        break;
    case FLYOUT_MENU_IDS.pauseFive:
        snoozeFor(300);
        updateFlyoutMenuState();
        break;
    case FLYOUT_MENU_IDS.resume:
        resumeFromSnooze();
        updateFlyoutMenuState();
        break;
    default:
        break;
    }
};

/**
 * Suppresses the embedded Chromium right-click menu (Back / Forward /
 * Print / View Page Source) inside the panel. Editable fields keep their
 * native menu so copy/paste still works there.
 */
const suppressBrowserContextMenu = () => {
    document.addEventListener("contextmenu", (evt) => {
        const t = evt.target;
        const editable = !!t && (
            (t.tagName === "INPUT" &&
                /^(text|search|url|email|tel|password|number)$/i.test(
                    t.getAttribute("type") || "text"
                )) ||
            t.tagName === "TEXTAREA" ||
            t.isContentEditable
        );
        if (!editable) evt.preventDefault();
    });
};

const initFlyoutMenu = () => {
    if (
        !DEJAVU_IS_CEP ||
        !csInterface ||
        typeof csInterface.setPanelFlyoutMenu !== "function"
    ) {
        return;
    }
    const xml = [
        "<Menu>",
        flyoutMenuItem(
            FLYOUT_MENU_IDS.autoFitPanel,
            FLYOUT_MENU_LABELS.autoFitPanel,
            state.settings.autoFitPanel !== false
        ),
        '<MenuItem Label="---" />',
        flyoutMenuItem(
            FLYOUT_MENU_IDS.checkForUpdates,
            FLYOUT_MENU_LABELS.checkForUpdates,
            false
        ),
        flyoutMenuItem(FLYOUT_MENU_IDS.dejavuNow, FLYOUT_MENU_LABELS.dejavuNow, false),
        flyoutMenuItem(FLYOUT_MENU_IDS.createCheckpoint, FLYOUT_MENU_LABELS.createCheckpoint, false),
        flyoutMenuItem(FLYOUT_MENU_IDS.refreshStatus, FLYOUT_MENU_LABELS.refreshStatus, false),
        flyoutMenuItem(FLYOUT_MENU_IDS.refreshTimeline, FLYOUT_MENU_LABELS.refreshTimeline, false),
        flyoutMenuItem(FLYOUT_MENU_IDS.revealFolder, FLYOUT_MENU_LABELS.revealFolder, false),
        '<MenuItem Label="---" />',
        flyoutMenuItem(FLYOUT_MENU_IDS.openTimeline, FLYOUT_MENU_LABELS.openTimeline, false),
        flyoutMenuItem(FLYOUT_MENU_IDS.openRecovery, FLYOUT_MENU_LABELS.openRecovery, false),
        flyoutMenuItem(FLYOUT_MENU_IDS.openDocuments, FLYOUT_MENU_LABELS.openDocuments, false),
        '<MenuItem Label="---" />',
        flyoutMenuItem(FLYOUT_MENU_IDS.pauseFive, FLYOUT_MENU_LABELS.pauseFive, false),
        flyoutMenuItem(FLYOUT_MENU_IDS.resume, FLYOUT_MENU_LABELS.resume, false),
        "</Menu>"
    ].join("");
    csInterface.setPanelFlyoutMenu(xml);
    csInterface.addEventListener(
        "com.adobe.csxs.events.flyoutMenuClicked",
        handleFlyoutMenuClick
    );
    csInterface.addEventListener(
        "com.adobe.csxs.events.flyoutMenuOpened",
        updateFlyoutMenuState
    );
    updateFlyoutMenuState();
};

/**
 * Caches DOM references and boots the panel.
 */
const init = () => {
    const crashDetected = beginCrashRecoverySession();
    if (window.DejaVuTheme) {
        DejaVuTheme.init();
    }

    el.appTitle = document.querySelector(".app__title");
    el.statusDot = document.getElementById("statusDot");
    el.appLogo = document.getElementById("appLogo");
    el.headerResetSettingsBtn = document.getElementById(
        "headerResetSettingsBtn"
    );
    // el.modeTag = document.getElementById("modeTag");
    el.modeSeg = document.getElementById("modeSeg");
    el.modeSegButtons = el.modeSeg
        ? Array.prototype.slice.call(
            el.modeSeg.querySelectorAll(".mode-seg__btn")
        )
        : [];
    el.snoozeBar = document.getElementById("snoozeBar");
    el.snoozeLabel = document.getElementById("snoozeLabel");
    el.snoozeChips = document.getElementById("snoozeChips");
    el.snoozeResumeBtn = document.getElementById("snoozeResumeBtn");
    el.docNameValue = document.getElementById("docNameValue");
    el.formatValue = document.getElementById("formatValue");
    el.lastSavedValue = document.getElementById("lastSavedValue");
    el.nextCheckValue = document.getElementById("nextCheckValue");
    el.nextCheckLabel = document.getElementById("nextCheckLabel");
    el.modeValue = document.getElementById("modeValue");
    el.sessionStatsValue = document.getElementById("sessionStatsValue");
    el.folderStatusValue = document.getElementById("folderStatusValue");
    el.folderBalloon = document.getElementById("folderBalloon");
    el.folderBalloonCopyBtn = document.getElementById(
        "folderBalloonCopyBtn"
    );
    el.savingBar = document.getElementById("savingBar");
    el.countdownPie = document.getElementById("countdownPie");
    el.countdownPieSweep = document.getElementById("countdownPieSweep");
    el.intervalInput = document.getElementById("intervalInput");
    el.intervalUnit = document.getElementById("intervalUnit");
    el.intervalPresets = document.getElementById("intervalPresets");
    el.safetyProfiles = document.getElementById("safetyProfiles");
    el.folderInput = document.getElementById("folderInput");
    el.folderField = document.getElementById("folderField");
    el.folderValidity = document.getElementById("folderValidity");
    el.browseFolderBtn = document.getElementById("browseFolderBtn");
    el.templateInput = document.getElementById("templateInput");
    el.templateEditor = document.getElementById("templateEditor");
    el.tokensList = document.getElementById("tokensList");
    el.templatePresets = document.getElementById("templatePresets");
    el.templatePreview = document.getElementById("templatePreview");
    el.overwriteToggle = document.getElementById("overwriteToggle");
    el.onlyIfChangedToggle = document.getElementById(
        "onlyIfChangedToggle"
    );
    el.keepCountInput = document.getElementById("keepCountInput");
    el.keepDaysInput = document.getElementById("keepDaysInput");
    el.maxFolderSizeInput = document.getElementById("maxFolderSizeInput");
    el.diskSpaceWarningInput = document.getElementById("diskSpaceWarningInput");
    el.recoveryVersionsInput = document.getElementById("recoveryVersionsInput");
    el.recoveryMaxEntriesInput = document.getElementById(
        "recoveryMaxEntriesInput"
    );
    el.cacheHealthSummary = document.getElementById("cacheHealthSummary");
    el.cacheHealthWarning = document.getElementById("cacheHealthWarning");
    el.diskSpaceRefreshInput = document.getElementById("diskSpaceRefreshInput");
    el.cacheDiskSpace = document.getElementById("cacheDiskSpace");
    el.cacheDiskSpaceRefresh = document.getElementById("cacheDiskSpaceRefresh");
    el.cacheDiskSpaceSummary = document.getElementById(
        "cacheDiskSpaceSummary"
    );
    el.cacheDiskSpacePercent = document.getElementById(
        "cacheDiskSpacePercent"
    );
    el.cacheDiskSpaceFill = document.getElementById("cacheDiskSpaceFill");
    el.folderTemplateInput = document.getElementById("folderTemplateInput");
    el.folderTemplateEditor = document.getElementById(
        "folderTemplateEditor"
    );
    el.recoveryCheckToggle = document.getElementById("recoveryCheckToggle");
    el.autoRecoverCrashToggle = document.getElementById(
        "autoRecoverCrashToggle"
    );
    el.checkForUpdatesToggle = document.getElementById(
        "checkForUpdatesToggle"
    );
    el.autoPinEveryInput = document.getElementById("autoPinEveryInput");
    el.recoveryCandidateList = document.getElementById(
        "recoveryCandidateList"
    );
    el.recoveryCandidateCount = document.getElementById(
        "recoveryCandidateCount"
    );
    el.openDocsDrawer = document.getElementById("openDocsDrawer");
    el.openDocsList = document.getElementById("openDocsList");
    el.openDocsCount = document.getElementById("openDocsCount");
    el.openDocsSelectAllToggle = document.getElementById(
        "openDocsSelectAllToggle"
    );
    el.openDocsUnsavedOnlyToggle = document.getElementById(
        "openDocsUnsavedOnlyToggle"
    );
    el.openDocsFilterInput = document.getElementById("openDocsFilterInput");
    el.openDocsSortSelect = document.getElementById("openDocsSortSelect");
    el.openDocsRangeSelect = document.getElementById("openDocsRangeSelect");
    el.openDocsSaveAllBtn = document.getElementById("openDocsSaveAllBtn");
    el.openDocsBulkBar = document.getElementById("openDocsBulkBar");
    el.openDocsSelectionCount = document.getElementById(
        "openDocsSelectionCount"
    );
    el.openDocsBulkOnBtn = document.getElementById("openDocsBulkOnBtn");
    el.openDocsBulkOffBtn = document.getElementById("openDocsBulkOffBtn");
    el.openDocsBulkSaveBtn = document.getElementById("openDocsBulkSaveBtn");
    el.openDocsBulkSaveMenuBtn = document.getElementById(
        "openDocsBulkSaveMenuBtn"
    );
    el.recoveryOpenAllBtn = document.getElementById("recoveryOpenAllBtn");
    el.recoveryClearMissingBtn = document.getElementById(
        "recoveryClearMissingBtn"
    );
    el.recoveryClearHistoryBtn = document.getElementById(
        "recoveryClearHistoryBtn"
    );
    el.recoveryCompactToggle = document.getElementById("recoveryCompactToggle");
    el.recoveryPinnedOnlyToggle = document.getElementById("recoveryPinnedOnlyToggle");
    el.recoveryFilterInput = document.getElementById("recoveryFilterInput");
    el.recoverySortSelect = document.getElementById("recoverySortSelect");
    el.recoveryRangeSelect = document.getElementById("recoveryRangeSelect");
    el.recoveryBulkBar = document.getElementById("recoveryBulkBar");
    el.recoverySelectionCount = document.getElementById("recoverySelectionCount");
    el.recoveryBulkCopyPathsBtn = document.getElementById("recoveryBulkCopyPathsBtn");
    el.recoveryBulkDelBtn = document.getElementById("recoveryBulkDelBtn");
    el.recoveryBulkClearBtn = document.getElementById("recoveryBulkClearBtn");
    el.recoveryExportCsvBtn = document.getElementById("recoveryExportCsvBtn");
    el.recoverySelectAllToggle = document.getElementById("recoverySelectAllToggle");
    el.backupOriginalToggle = document.getElementById("backupOriginalToggle");
    el.saveOnEnableToggle = document.getElementById("saveOnEnableToggle");
    el.saveOnDocumentSwitchToggle = document.getElementById("saveOnDocumentSwitchToggle");
    el.versionList = document.getElementById("versionList");
    el.versionCount = document.getElementById("versionCount");
    el.timelineFilterInput = document.getElementById("timelineFilterInput");
    el.timelineSortSelect = document.getElementById("timelineSortSelect");
    el.timelineRangeSelect = document.getElementById("timelineRangeSelect");
    el.timelineSelectAllToggle = document.getElementById("timelineSelectAllToggle");
    el.timelineCompactToggle = document.getElementById("timelineCompactToggle");
    el.timelinePinnedOnlyToggle = document.getElementById(
        "timelinePinnedOnlyToggle"
    );
    el.autoRefreshTimelineToggle = document.getElementById("autoRefreshTimelineToggle");
    el.timelineInsights = document.getElementById("timelineInsights");
    el.timelineStorageSummary = document.getElementById(
        "timelineStorageSummary"
    );
    el.timelineRetentionSummary = document.getElementById(
        "timelineRetentionSummary"
    );
    el.timelineUsageFill = document.getElementById("timelineUsageFill");
    el.refreshVersionsBtn = document.getElementById("refreshVersionsBtn");
    el.exportTimelineBtn = document.getElementById("exportTimelineBtn");
    el.timelineBulkBar = document.getElementById("timelineBulkBar");
    el.timelineSelectionCount = document.getElementById(
        "timelineSelectionCount"
    );
    el.bulkCopyPathsBtn = document.getElementById("bulkCopyPathsBtn");
    el.bulkDelBtn = document.getElementById("bulkDelBtn");
    el.bulkClearBtn = document.getElementById("bulkClearBtn");
    el.revealLogBtn = document.getElementById("revealLogBtn");
    el.healthCheckBtn = document.getElementById("healthCheckBtn");
    el.clearTemplateBtn = document.getElementById("clearTemplateBtn");
    el.exportSettingsBtn = document.getElementById("exportSettingsBtn");
    el.importSettingsBtn = document.getElementById("importSettingsBtn");
    el.importSettingsInput = document.getElementById("importSettingsInput");
    el.footerHint = document.getElementById("footerHint");
    el.donationInfoBtn = document.getElementById("donationInfoBtn");
    el.donationModal = document.getElementById("donationModal");
    el.donationScrim = document.getElementById("donationScrim");
    el.donationCloseBtn = document.getElementById("donationCloseBtn");
    el.donationLaterBtn = document.getElementById("donationLaterBtn");
    el.donationPayBtn = document.getElementById("donationPayBtn");
    el.donationAmountInput = document.getElementById("donationAmountInput");
    el.donationCurrencySelect = document.getElementById(
        "donationCurrencySelect"
    );
    el.donationPlatformSelect = document.getElementById(
        "donationPlatformSelect"
    );
    el.donationVersion = document.getElementById("donationVersion");
    el.donationGithubUrl = document.getElementById("donationGithubUrl");

    setupFilenameTokenInput();
    renderFolderTokenPalette();
    hydrateForm();
    bindEvents();
    bindDrawerState();
    Tooltip.init();
    suppressBrowserContextMenu();
    initFlyoutMenu();
    if (el.openDocsDrawer) {
        el.openDocsDrawer.addEventListener("toggle", () => {
            if (el.openDocsDrawer.open) refreshOpenDocuments();
        });
    }
    renderRecoveryCenter();
    updateSessionStats();
    if (isSnoozed()) {
        state.snoozeTickId = window.setInterval(tickSnooze, 1000);
        updateSnoozeUi();
    } else {
        persistSnoozeUntil(0);
    }

    // Explicitly verify the UXP host bridge before any host-dependent call
    // fires. callHost() also checks this internally.
    ensureHostLoaded().then(() => {
        verifyHostVersion();
        validateFolderInput();
        syncInstallSignatureAndSplash();
        refreshDocStatus().then(() => {
            refreshVersions(true);
            auditCacheHealth({ quiet: true });
            checkRecoveryWarning();
            refreshOpenDocuments();
        }).then(() => {
            if (
                crashDetected &&
                state.settings.autoRecoverAfterCrash !== false
            ) {
                return recoverLastCrashSession(true);
            }
            return null;
        });
        if (isDejavuEnabledForCurrent()) startLoop();
    });

    state.periodicRefreshId = window.setInterval(
        runPeriodicRefresh,
        4000
    );

    // Surface the post-reset confirmation that survived the reload kicked
    // off by resetSettings().
    try {
        if (window.sessionStorage.getItem("dejavu:settingsResetHint")) {
            window.sessionStorage.removeItem("dejavu:settingsResetHint");
            setHint("Settings reset.", "ok");
        }
    } catch (e) {
        // sessionStorage unavailable — skip the confirmation hint.
    }

    // Start watching content height once the first layout settles, so
    // the panel fits its expanded/collapsed drawers from the outset.
    initPanelAutoSize();
};

document.addEventListener("DOMContentLoaded", init);
