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

// Expose dev mode so the inline debug-skin switcher (index.html) can reveal
// itself only in development.
if (typeof window !== "undefined") {
    window.__DEJAVU_DEV_MODE__ = DEJAVU_DEV_MODE;
}

// Dev aid: re-load host.jsx via $.evalFile on each CEP panel open so host
// edits take effect on a simple reopen. Off in production.
const FORCE_HOST_RELOAD = DEJAVU_DEV_MODE;

// Must match DEJAVU_HOST_VERSION in host/host.jsx. After load the panel
// reads the host's version back; a mismatch means an OLD host.jsx
// is still resident in Illustrator's ExtendScript engine.
const EXPECTED_HOST_VERSION = "2026.06.25-r37";
const EXPECTED_UXP_HOST_VERSION = "2026.06.25-r37";

// Some host panel sessions can stay alive when their tabs are hidden.
// Reload once when a previously-hidden panel becomes visible so the
// cache-busted asset URLs in index.html are read freshly.
let panelWasHidden = false;
let panelReloading = false;

const reloadPanelAfterReopen = () => {
    if (panelReloading) return;
    // Skip reload if stop loops is enabled (debug mode)
    if (window.__DEJAVU_STOP_LOOPS__) {
        console.log("[Debug] Auto-reload skipped due to stop loops being enabled");
        return;
    }
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
        const path = require("path");
        const extensionRoot = csInterface.getSystemPath(
            SystemPath.EXTENSION
        );
        const comparePath = path.join(extensionRoot, "scripts", "compare.js");
        const { changed } = require(comparePath);

        let lastChanged = false;
        window.__DEJAVU_DEV_RELOAD_WATCHER__ = window.setInterval(
            async () => {
                try {
                    const isChanged = await changed(extensionRoot, extensionRoot, {
                        dirs: ["scripts", "jsx", "icons", "host", "client"],
                        ext: [".js", ".jsx", ".htm", ".html", ".css", ".json", ".svg"],
                        ignore: [
                            /(^|\/)\.git(\/|$)/,
                            /(^|\/)node_modules(\/|$)/,
                            /(^|\/)\.history(\/|$)/,
                            /(^|\/)build(\/|$)/,
                            /(^|\/)\.DS_Store$/,
                            /(^|\/)vendor(\/|$)/
                        ]
                    });
                    if (isChanged && !lastChanged) {
                        lastChanged = true;
                        reloadPanelAfterReopen();
                    } else if (!isChanged) {
                        lastChanged = false;
                    }
                } catch (eCompare) {
                    // Fall back to silent failure; auto-reload is a convenience only.
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
	        if (DEJAVU_IS_UXP && window.DejaVuHost) {
	            if (typeof window.DejaVuHost[fnName] !== "function") {
	                return Promise.resolve(
	                    DejaVuHostContract.missingFunction(fnName, "UXP host")
	                );
	            }
	            return Promise.resolve()
	                .then(() => window.DejaVuHost[fnName](...(args || [])))
	                .then((result) => {
	                    return DejaVuHostContract.parseUxpResult(fnName, result);
	                })
	                .catch((error) => DejaVuHostContract.fromThrown(error));
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
	                    resolve(
	                        DejaVuHostContract.parseCepResult(
	                            fnName,
	                            result,
	                            retried
	                        )
	                    );
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
    autoFitPanel: true,
    installSignature: "",
    donationDismissedInstallSignature: "",
    donationAmount: DONATION_CONFIG.defaultAmount,
    donationCurrency: DONATION_CONFIG.defaultCurrency,
    donationPlatform: DONATION_CONFIG.defaultPlatform
};

const cleanDefaultSettings = () => {
    const defaults = clone(DEFAULT_SETTINGS);
    defaults.fileDejavuOverrides = {};
    defaults.protectedSnapshots = {};
    defaults.snapshotNotes = {};
    return defaults;
};

const normalizeLoadedSettings = (parsed) => {
    const base = clone(DEFAULT_SETTINGS);
    base.fileDejavuOverrides = {};
    const merged = DEJAVU.adoptKnownKeys(base, parsed);
    if (typeof merged.enabledForAll !== "boolean") {
        merged.enabledForAll = !!merged.enabled;
    }
    merged.fileDejavuOverrides = normalizeFileDejavuOverrides(
        merged.fileDejavuOverrides
    );
    merged.pendingUnsavedFoldersBySession = normalizePlainObject(
        merged.pendingUnsavedFoldersBySession
    );
    merged.protectedSnapshots = normalizePlainObject(
        merged.protectedSnapshots
    );
    merged.timelineSort = normalizeTimelineSort(merged.timelineSort);
    merged.timelineRange = normalizeTimelineRange(merged.timelineRange);
    merged.timelineFilter = String(merged.timelineFilter || "");
    merged.snapshotNotes = normalizeStringMap(merged.snapshotNotes);
    merged.enabled = !!merged.enabledForAll;
    if (
        merged.pendingUnsavedDejavuFolder &&
        !pathIsInside(merged.pendingUnsavedDejavuFolder, merged.folder)
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
};

const settingsStore = new DejaVuSettingsStore({
    storage: window.localStorage,
    storageKey: STORAGE_KEY,
    backupKey: STORAGE_BACKUP_KEY,
    corruptKey: STORAGE_CORRUPT_KEY,
    makeDefaults: cleanDefaultSettings,
    normalize: normalizeLoadedSettings,
    onSaveError: (error) => {
        console.error(`[DejaVu] Settings save failed: ${error}`);
        if (el.footerHint) {
            setHint("Settings could not be stored locally.", "warn");
        }
    }
});

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

    const spinRefreshIcon = (button) => {
        if (!button) return;
        const insights = button.closest(".timeline-insights");
        button.classList.remove("is-spinning");
        if (insights) insights.classList.remove("is-refreshing");
        void button.offsetWidth;
        button.classList.add("is-spinning");
        if (insights) insights.classList.add("is-refreshing");
        button.addEventListener("animationend", () => {
            button.classList.remove("is-spinning");
            if (insights) insights.classList.remove("is-refreshing");
        }, { once: true });
    };

    document.addEventListener("click", (evt) => {
        const target = evt.target.closest(".icon-refresh, .table-toggle");
        const refreshIcon = target && target.classList.contains("icon-refresh")
            ? target
            : target
                ? target.querySelector(".icon-refresh")
                : null;
        if (refreshIcon) spinRefreshIcon(refreshIcon);
    });

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
            check.dataset.icon = "check-corner";
            check.setAttribute("aria-hidden", "true");
            if (window.dejavu && window.dejavu.injectIcon) {
                window.dejavu.injectIcon(check);
            }

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
    // Extracted so dynamically-rendered selects (e.g. the Similarity panel)
    // can be enhanced after the fact via window.dejavuEnhanceSelects(root).
    const enhanceSelectWrapper = (wrap) => {
        if (!wrap.querySelector(".select-chevron")) {
            const chevron = document.createElement("span");
            chevron.className = "select-chevron";
            chevron.dataset.icon = "chevron-down";
            chevron.setAttribute("aria-hidden", "true");
            wrap.appendChild(chevron);
            if (window.dejavu && window.dejavu.injectIcon) {
                window.dejavu.injectIcon(chevron);
            }
        }

        const select = wrap.querySelector("select");
        if (select && !select.dataset.openTracked) {
            select.dataset.openTracked = "1";
            const menu = document.createElement("div");
            menu.className = "select-menu";
            menu.setAttribute("role", "listbox");
            menu.setAttribute("aria-hidden", "true");
            const menuHost =
                wrap.closest(".panel-view") ||
                wrap.closest(".shell-content") ||
                wrap.closest(".shell") ||
                document.body;
            menuHost.appendChild(menu);

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

    if (el.intervalUnit) {
        el.intervalUnit.addEventListener("change", () => {
            const oldUnit = parseInt(state.settings.intervalUnit, 10) || 60;
            const newUnit = parseInt(el.intervalUnit.value, 10) || 60;
            convertIntervalUnit(oldUnit, newUnit);
            saveSettings();
            if (isDejavuEnabledForCurrent()) startLoop();
        });
    }

    if (el.intervalPresets) {
        el.intervalPresets.addEventListener("click", (evt) => {
            const chip = evt.target.closest("[data-seconds]");
            if (!chip || !el.intervalPresets.contains(chip)) return;
            applyIntervalSeconds(chip.getAttribute("data-seconds"));
        });
    }

    if (el.safetyProfiles) {
        el.safetyProfiles.addEventListener("click", (evt) => {
            const chip = evt.target.closest("[data-profile]");
            if (!chip || !el.safetyProfiles.contains(chip)) return;
            applySafetyProfile(chip.getAttribute("data-profile"));
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

    if (el.folderPerDocumentToggle) {
        el.folderPerDocumentToggle.addEventListener("change", () => {
            state.settings.folderPerDocument =
                el.folderPerDocumentToggle.checked;
            saveSettings();
            updateFolderStatus();
        });
    }

    // Filename and folder templates are managed by TokenField.
    bindFolderTemplateEditor();

    if (el.templatePresets) {
        el.templatePresets.addEventListener("click", (evt) => {
            const chip = evt.target.closest("[data-template]");
            if (!chip || !el.templatePresets.contains(chip)) return;
            applyTemplateString(chip.getAttribute("data-template") || "");
        });
    }

    if (el.clearTemplateBtn) {
        el.clearTemplateBtn.addEventListener("click", () => {
            applyTemplateString("");
        });
    }

    el.overwriteToggle.addEventListener("change", () => {
        state.settings.overwriteExisting = el.overwriteToggle.checked;
        saveSettings();
        updatePreview();
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

    el.autoPinEveryToggle.addEventListener("change", () => {
        // The number input became a checkbox in the settings refactor:
        // ON keeps the existing cadence (or a sensible default of every 10
        // dejavus); OFF disables auto-pinning.
        if (el.autoPinEveryToggle.checked) {
            const prev = parseInt(state.settings.autoPinEvery, 10) || 0;
            state.settings.autoPinEvery = prev > 0 ? prev : 10;
        } else {
            state.settings.autoPinEvery = 0;
        }
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

    if (el.donationBuyMeCoffeeBtn) {
        el.donationBuyMeCoffeeBtn.addEventListener("click", () => {
            openDonationPayment("buymeacoffee");
        });
    }

    if (el.donationKofiBtn) {
        el.donationKofiBtn.addEventListener("click", () => {
            openDonationPayment("kofi");
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
        return checkRecoveryWarning();
    }).then(() => {
        if (isPanelVisible("timelinePanel")) {
            return refreshVersions(false);
        }
    }).then(() => {
        // The overview only matters while it's expanded.
        if (isPanelVisible("openDocumentsPanel")) {
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

const outerElementHeight = (node) => {
    if (!node) return 0;
    const cs = window.getComputedStyle(node);
    if (cs.display === "none") return 0;
    return (
        node.offsetHeight +
        (parseFloat(cs.marginTop) || 0) +
        (parseFloat(cs.marginBottom) || 0)
    );
};

const naturalStackHeight = (node) => {
    if (!node) return 0;
    const cs = window.getComputedStyle(node);
    if (cs.display === "none") return 0;
    const gap = parseFloat(cs.rowGap || cs.gap) || 0;
    let total = (parseFloat(cs.paddingTop) || 0) +
        (parseFloat(cs.paddingBottom) || 0);
    let visibleCount = 0;
    Array.prototype.forEach.call(node.children, (child) => {
        const childCs = window.getComputedStyle(child);
        if (childCs.display === "none") return;
        if (visibleCount > 0) total += gap;
        total += child.offsetHeight;
        total += (parseFloat(childCs.marginTop) || 0) +
            (parseFloat(childCs.marginBottom) || 0);
        visibleCount += 1;
    });
    return Math.ceil(total);
};

/**
 * Measures the panel's natural content height from the current shell layout.
 * The scroll containers are flex-sized in the live UI, so using offsetHeight
 * directly would measure the viewport rather than the content that should fit.
 * @return {number} Content height in CSS pixels.
 */
const naturalContentHeight = () => {
    const wrapper = document.querySelector(".wrapper");
    const container = wrapper
        ? wrapper.querySelector(":scope > .container")
        : document.querySelector(".container");
    const activeShell = container
        ? container.querySelector(".shell:not([hidden])")
        : document.querySelector(".shell:not([hidden])");
    const containerCs = container
        ? window.getComputedStyle(container)
        : null;
    const shellCs = activeShell
        ? window.getComputedStyle(activeShell)
        : null;
    let total = 0;
    if (wrapper) {
        total += outerElementHeight(wrapper.querySelector(":scope > .header"));
        total += outerElementHeight(
            wrapper.querySelector(":scope > .app__footer")
        );
        const ws = window.getComputedStyle(wrapper);
        total += (parseFloat(ws.paddingTop) || 0) +
            (parseFloat(ws.paddingBottom) || 0);
    }
    if (containerCs) {
        total += (parseFloat(containerCs.paddingTop) || 0) +
            (parseFloat(containerCs.paddingBottom) || 0) +
            (parseFloat(containerCs.marginTop) || 0) +
            (parseFloat(containerCs.marginBottom) || 0);
    }
    if (shellCs) {
        total += naturalStackHeight(activeShell) +
            (parseFloat(shellCs.marginTop) || 0) +
            (parseFloat(shellCs.marginBottom) || 0);
    } else if (!total) {
        total = naturalStackHeight(document.querySelector(".app"));
    }
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
 * height (panels changing, lists re-rendering, bars showing/hiding)
 * and re-fits the panel. Text-only mutations are ignored so the
 * once-a-second countdown does not thrash the host.
 */
const initPanelAutoSize = () => {
    el.app = el.app || document.querySelector(".wrapper") ||
        document.querySelector(".container") ||
        document.querySelector(".app");
    if (!el.app || typeof window.MutationObserver !== "function") return;
    panelObserver = new MutationObserver(schedulePanelAutoSize);
    // Only watch attributes that actually change the panel's height (panels
    // opening, elements hiding). Watching "class"/"style" across the whole
    // subtree made every hover, dropdown toggle and animated width write force
    // a synchronous reflow + host resize, which made the panel feel sluggish.
    panelObserver.observe(el.app, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["open", "hidden"]
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

const mainPanelIds = [
    "timelinePanel",
    "recoveryPanel",
    "openDocumentsPanel",
    "similarityPanel"
];

const settingsPanelIds = [
    "comparisonSettingsPanel",
    "cacheHealthPanel",
    "saveIntervalPanel",
    "locationsPanel",
    "advancedPanel"
];

const isPanelVisible = (panelId) => {
    const panel = document.getElementById(panelId);
    return !!panel && !panel.hidden;
};

const activateMainPanel = (panelId) => {
    if (!mainPanelIds.includes(panelId)) return;
    const mainShell = document.getElementById("mainShell");
    const similarityShell = document.getElementById("similarityShell");
    const settingsShell = document.getElementById("settingsShell");
    const shellButtons = document.querySelectorAll("[data-shell-target]");
    const activeShellId =
        panelId === "similarityPanel" ? "similarityShell" : "mainShell";
    if (mainShell) {
        mainShell.hidden = activeShellId !== "mainShell";
    }
    if (similarityShell) {
        similarityShell.hidden = activeShellId !== "similarityShell";
    }
    if (settingsShell) {
        settingsShell.hidden = true;
    }
    Array.prototype.forEach.call(shellButtons, (btn) => {
        const active =
            btn.getAttribute("data-shell-target") === activeShellId;
        btn.classList.toggle("is-on", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    mainPanelIds.forEach((id) => {
        const panel = document.getElementById(id);
        const tab = document.querySelector(`[data-panel-tab="${id}"]`);
        const active = id === panelId;
        if (panel) {
            panel.hidden = !active;
            panel.classList.toggle("is-active", active);
        }
        if (tab) {
            tab.classList.toggle("is-active", active);
            tab.setAttribute("aria-selected", active ? "true" : "false");
        }
    });
    if (panelId === "openDocumentsPanel") refreshOpenDocuments();
    if (panelId === "timelinePanel") refreshVersions(true);
    if (panelId === "recoveryPanel") renderRecoveryCenter();
    schedulePanelAutoSize();
};

const activateSettingsPanel = (panelId) => {
    if (!settingsPanelIds.includes(panelId)) return;
    settingsPanelIds.forEach((id) => {
        const panel = document.getElementById(id);
        const tab = document.querySelector(`[data-panel-tab="${id}"]`);
        const active = id === panelId;
        if (panel) {
            panel.hidden = !active;
            panel.classList.toggle("is-active", active);
        }
        if (tab) {
            tab.classList.toggle("is-active", active);
            tab.setAttribute("aria-selected", active ? "true" : "false");
        }
    });
    schedulePanelAutoSize();
};

const openMainPanel = (panelId) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    activateMainPanel(panelId);
    panel.scrollIntoView({ block: "nearest" });
};

const bindPanelNavigation = () => {
    document.querySelectorAll("[data-panel-tab]").forEach((tab) => {
        tab.addEventListener("click", () => {
            const panelId = tab.getAttribute("data-panel-tab");
            if (settingsPanelIds.includes(panelId)) {
                activateSettingsPanel(panelId);
            } else {
                activateMainPanel(panelId);
            }
        });
    });
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
        openMainPanel("timelinePanel");
        break;
    case FLYOUT_MENU_IDS.openRecovery:
        openMainPanel("recoveryPanel");
        break;
    case FLYOUT_MENU_IDS.openDocuments:
        openMainPanel("openDocumentsPanel");
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
    el.browseFolderBtn = document.getElementById("browseFolderBtn");
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
    el.folderPerDocumentToggle = document.getElementById(
        "folderPerDocumentToggle"
    );
    el.templateEditor = document.getElementById("templateEditor");
    el.templateInput = document.getElementById("templateInput");
    el.tokensList = document.getElementById("tokensList");
    el.templatePresets = document.getElementById("templatePresets");
    el.templatePreview = document.getElementById("templatePreview");
    el.clearTemplateBtn = document.getElementById("clearTemplateBtn");
    el.recoveryCheckToggle = document.getElementById("recoveryCheckToggle");
    el.autoRecoverCrashToggle = document.getElementById(
        "autoRecoverCrashToggle"
    );
    el.checkForUpdatesToggle = document.getElementById(
        "checkForUpdatesToggle"
    );
    el.autoPinEveryToggle = document.getElementById("autoPinEveryToggle");
    el.recoveryCandidateList = document.getElementById(
        "recoveryCandidateList"
    );
    el.recoveryCandidateCount = document.getElementById(
        "recoveryCandidateCount"
    );
    el.openDocumentsPanel = document.getElementById("openDocumentsPanel");
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
    el.exportSettingsBtn = document.getElementById("exportSettingsBtn");
    el.importSettingsBtn = document.getElementById("importSettingsBtn");
    el.importSettingsInput = document.getElementById("importSettingsInput");
    el.footerHint = document.getElementById("footerHint");
    el.donationInfoBtn = document.getElementById("donationInfoBtn");
    el.donationModal = document.getElementById("donationModal");
    el.donationScrim = document.getElementById("donationScrim");
    el.donationCloseBtn = document.getElementById("donationCloseBtn");
    el.donationLaterBtn = document.getElementById("donationLaterBtn");
    el.donationBuyMeCoffeeBtn = document.getElementById(
        "donationBuyMeCoffeeBtn"
    );
    el.donationKofiBtn = document.getElementById("donationKofiBtn");
    el.donationAmountInput = document.getElementById("donationAmountInput");
    el.donationCurrencySelect = document.getElementById(
        "donationCurrencySelect"
    );
    el.donationVersion = document.getElementById("donationVersion");
    el.donationGithubUrl = document.getElementById("donationGithubUrl");

    setupFilenameTokenInput();
    setupFolderTemplateInput();
    hydrateForm();
    bindEvents();
    bindPanelNavigation();
    Tooltip.init();
    suppressBrowserContextMenu();
    initFlyoutMenu();
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
            checkRecoveryWarning();
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
        12000
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
    // the panel fits its expanded/collapsed panels from the outset.
    initPanelAutoSize();
};

document.addEventListener("DOMContentLoaded", init);
