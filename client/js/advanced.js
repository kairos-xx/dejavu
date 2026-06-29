/**
 * DejaVu — split from the original client/js/main.js.
 *
 * This file preserves the original statements and function bodies;
 * it only moves them into a responsibility-focused script file.
 */
"use strict";

const revealPath = (path) => {
    if (!isValidFolderValue(path)) {
        setHint("Nothing to reveal yet.", "warn");
        return;
    }
    // Prefer opening Finder/Explorer directly from the panel via
    // Node — UXP host's Folder.execute() is unreliable on recent
    // macOS. Falls back to the host reveal if Node isn't available.
    try {
        const cp = require("child_process");
        let resolved = String(path);
        if (resolved.charAt(0) === "~") {
            const home = require("os").homedir();
            resolved = home + resolved.slice(1);
        }
        const isWin = (navigator.platform || "")
            .toLowerCase().indexOf("win") !== -1;
        const cmd = isWin ? "explorer" : "open";
        cp.execFile(cmd, [resolved], (err) => {
            if (err) {
                revealPathViaHost(path);
            } else {
                setHint("Revealed in Finder.", "ok");
            }
        });
        return;
    } catch (e) {
        revealPathViaHost(path);
    }
};

/** Host-side reveal fallback (when Node child_process is unavailable). */
const revealPathViaHost = (path) => {
    callHost("dejavu_revealPath", [path]).then((result) => {
        setHint(result && result.ok ? "Revealed in Finder." :
            `Reveal failed: ${(result && result.error ? result.error : "unknown")}`,
            result && result.ok ? "ok" : "warn");
    });
};

const revealCurrentDejavuFolder = () => {
    let folder = state.currentDejavuFolder;
    if (!isValidFolderValue(folder)) {
        folder = state.settings.folder || "";
    }
    revealPath(folder);
};

/**
 * Copies text to the system clipboard from the UXP panel.
 * @param {string} text Text to copy.
 */
const copyTextToClipboard = (text) => {
    if (!text) {
        setHint("Nothing to copy yet.", "warn");
        return;
    }
    const done = () => {
        setHint("Copied to clipboard.", "ok");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => {
            fallbackCopyText(text);
        });
        return;
    }
    fallbackCopyText(text);
};

/**
 * Clipboard fallback for older embedded runtime builds.
 * @param {string} text Text to copy.
 */
const fallbackCopyText = (text) => {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "readonly");
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.select();
    try {
        document.execCommand("copy");
        setHint("Copied to clipboard.", "ok");
    } catch (eCopy) {
        setHint("Copy failed.", "warn");
    }
    document.body.removeChild(input);
};

/**
 * Opens the newest dejavu snapshot for the current document.
 */
const openSnapshotAndDejavu = (path, label) => {
    return callHost("dejavu_openPath", [path]).then((result) => {
        if (!result || !result.ok) {
            setHint(
                `Open failed: ${(result && result.error ? result.error : "unknown")}`,
                "warn"
            );
            return null;
        }
        state.recoveryWarningPath = "";
        setHint(`Opened ${label} · creating its dejavu…`, "ok");
        return refreshDocStatus().then(() => {
            return runDejavuCycle(true);
        });
    }).then((saveResult) => {
        if (saveResult && saveResult.ok) {
            setHint(`Opened ${label} and created its dejavu.`, "ok");
        }
        return saveResult;
    }).catch((err) => {
        setHint(
            `Opened ${label}, but dejavu failed: ${(err && err.message ? err.message : err)}`,
            "warn"
        );
    });
};

const recoverLastCrashSession = (automatic) => {
    let candidates = readLocalJson(RECOVERY_CANDIDATES_KEY, []);
    if (!Array.isArray(candidates)) candidates = [];
    candidates.sort((a, b) => {
        return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
    });
    candidates = candidates.slice(0, 5);
    if (!candidates.length) {
        setHint("No crash-recovery dejavus are available.", "warn");
        return Promise.resolve({ ok: true, opened: 0 });
    }
    let opened = 0;
    let chain = Promise.resolve();
    candidates.forEach((candidate) => {
        chain = chain.then(() => {
            return callHost("dejavu_pathExists", [candidate.path]);
        }).then((exists) => {
            if (!exists || !exists.ok || !exists.exists) return null;
            return openSnapshotAndDejavu(
                candidate.path,
                `crash recovery · ${candidate.name}`
            ).then((result) => {
                if (result && result.ok) {
                    opened++;
                    promoteRecoveredCandidate(candidate, result);
                }
                return result;
            });
        });
    });
    return chain.then(() => {
        setHint(
            opened > 0
                ? `Recovered ${opened} dejavud document${(opened === 1 ? "" : "s")}${(automatic ? " after an unexpected shutdown." : ".")}`
                : "No stored recovery files still exist.",
            opened > 0 ? "ok" : "warn"
        );
        return { ok: true, opened };
    });
};

/**
 * Runs a host-side folder/document sanity check and summarizes the result.
 */
const runHealthCheck = () => {
    callHost("dejavu_healthCheck", [
        state.settings.folder || "",
        state.settings.folderPerDocument,
        state.settings.pendingUnsavedDejavuFolder || "",
        state.settings.folderTemplate || "",
        state.settings.pendingUnsavedDocumentSessionId || ""
    ]).then((result) => {
        if (result && result.ok) {
            updateFolderStatus(result.folder || "");
            setHint(
                `Health OK · ${result.format.toUpperCase()} · ${(result.folderWritable ? "writable" : "read-only")} · ${result.folder}`,
                result.folderWritable ? "ok" : "warn"
            );
            auditCacheHealth({ quiet: true });
        } else {
            setHint(
                `Health check failed: ${(result && result.error ? result.error : "unknown")}`,
                "warn"
            );
        }
    });
};

const normalizeDiskProbePath = (path) => {
    let value = String(path || "").trim();
    if (!value) return "";
    if (value.charAt(0) === "~") {
        try {
            value = require("os").homedir() + value.slice(1);
        } catch {}
    }
    return value;
};

const getDiskSpaceInfoClient = (path) => {
    return new Promise((resolve) => {
        const target = normalizeDiskProbePath(path);
        if (!target || typeof require !== "function") {
            resolve(null);
            return;
        }
        let fs = null;
        let cp = null;
        let pathMod = null;
        try {
            fs = require("fs");
            cp = require("child_process");
            pathMod = require("path");
        } catch {
            resolve(null);
            return;
        }

        const dirname = pathMod && typeof pathMod.dirname === "function"
            ? pathMod.dirname
            : (p) => {
                const lastSlash = p.replace(/\\/g, "/").lastIndexOf("/");
                return lastSlash > 0 ? p.slice(0, lastSlash) : "/";
            };

        try {
            if (fs.statfsSync) {
                const stats = fs.statfsSync(target);
                const blockSize = Number(stats.bsize || stats.frsize || 0);
                const freeBlocks = Number(stats.bavail || stats.bfree || 0);
                const totalBlocks = Number(stats.blocks || 0);
                if (blockSize > 0 && totalBlocks > 0) {
                    resolve({
                        freeBytes: freeBlocks * blockSize,
                        totalBytes: totalBlocks * blockSize
                    });
                    return;
                }
            }
        } catch {}

        const isWin = typeof process !== "undefined" &&
            process.platform === "win32";
        if (isWin) {
            const runPowerShell = (probePath) => {
                const drive = probePath.match(/^[a-z]:/i);
                if (!drive) return Promise.resolve(null);
                return new Promise((res) => {
                    cp.execFile(
                        "powershell.exe",
                        [
                            "-NoProfile",
                            "-Command",
                            `$d = Get-PSDrive ${drive[0].charAt(0)}; "$($d.Free),$($d.Free + $d.Used)"`
                        ],
                        (err, stdout) => {
                            if (err) {
                                res(null);
                                return;
                            }
                            const parts = String(stdout || "").trim().split(",");
                            res({
                                freeBytes: Number(parts[0]) || 0,
                                totalBytes: Number(parts[1]) || 0
                            });
                        }
                    );
                });
            };
            runPowerShell(target).then((disk) => {
                if (disk) return disk;
                return runPowerShell(dirname(target));
            }).then((disk) => {
                if (disk) return disk;
                return runPowerShell("C:");
            }).then(resolve);
            return;
        }

        const runDf = (probePath) => {
            return new Promise((res) => {
                cp.execFile("df", ["-k", probePath], (err, stdout) => {
                    if (err) {
                        res(null);
                        return;
                    }
                    const lines = String(stdout || "").trim().split(/\r?\n/);
                    const parts = (lines[lines.length - 1] || "").split(/\s+/);
                    const totalKb = Number(parts[1]) || 0;
                    const freeKb = Number(parts[3]) || 0;
                    res({
                        freeBytes: freeKb * 1024,
                        totalBytes: totalKb * 1024
                    });
                });
            });
        };

        runDf(target).then((disk) => {
            if (disk) return disk;
            const parent = dirname(target);
            if (parent && parent !== target) return runDf(parent);
            return null;
        }).then((disk) => {
            if (disk) return disk;
            return runDf("/");
        }).then(resolve);
    });
};

const getDiskSpaceInfo = (path) => {
    const target = normalizeDiskProbePath(path);
    // In CEP the webview has Node/child_process, so the client-side probe
    // works reliably. In UXP we must ask the host.
    const isCep = typeof window !== "undefined" &&
        typeof window.__adobe_cep__ !== "undefined";
    if (isCep) {
        return getDiskSpaceInfoClient(target);
    }
    return callHost("dejavu_getDiskSpaceInfo", [target])
        .then((result) => {
            if (
                result &&
                result.ok &&
                Number.isFinite(Number(result.freeBytes))
            ) {
                return {
                    freeBytes: Number(result.freeBytes),
                    totalBytes: Number(result.totalBytes || 0),
                };
            }
            return getDiskSpaceInfoClient(target);
        })
        .catch(() => getDiskSpaceInfoClient(target));
};

const setCacheHealthWarning = (message) => {
    if (!el.cacheHealthWarning) return;
    el.cacheHealthWarning.hidden = !message;
    el.cacheHealthWarning.textContent = message || "";
};

const summarizeCacheFiles = (files) => {
    const items = Array.isArray(files) ? files : [];
    let totalBytes = 0;
    let missing = 0;
    let latest = null;
    items.forEach((item) => {
        if (!item) return;
        if (item.exists === false) missing++;
        else totalBytes += Number(item.size) || 0;
        if (!latest || (Number(item.modified) || 0) > (Number(latest.modified) || 0)) {
            latest = item;
        }
    });
    return { count: items.length, totalBytes, missing, latest };
};

const renderCacheDiskSpace = (disk, folder) => {
    if (
        !el.cacheDiskSpaceSummary ||
        !el.cacheDiskSpacePercent ||
        !el.cacheDiskSpaceFill
    ) {
        return;
    }

    const rawFreeBytes = disk ? Number(disk.freeBytes) : NaN;
    const hasDiskMeasurement = Number.isFinite(rawFreeBytes);
    const freeBytes = hasDiskMeasurement ? Math.max(0, rawFreeBytes) : 0;
    const totalBytes = disk ? Math.max(0, Number(disk.totalBytes) || 0) : 0;
    const thresholdBytes =
        (Number(state.settings.diskSpaceWarningMb) || 0) * 1024 * 1024;
    el.cacheDiskSpaceFill.classList.remove(
        "timeline-insights__fill--warn",
        "timeline-insights__fill--over"
    );

    if (!hasDiskMeasurement) {
        el.cacheDiskSpaceSummary.textContent = "Disk space not checked.";
        el.cacheDiskSpacePercent.textContent = "—";
        el.cacheDiskSpaceFill.style.width = "0%";
        if (el.cacheDiskSpace) {
            el.cacheDiskSpace.title = folder || "No cache folder resolved yet";
        }
        return;
    }

    const freePct = totalBytes > 0
        ? Math.max(0, Math.min(100, Math.round((freeBytes / totalBytes) * 100)))
        : 0;
    const usedPct = totalBytes > 0 ? 100 - freePct : 0;
    el.cacheDiskSpaceSummary.textContent = totalBytes > 0
        ? `Available disk · ${formatBytes(freeBytes)} of ${formatBytes(totalBytes)}`
        : `Available disk · ${formatBytes(freeBytes)}`;
    el.cacheDiskSpacePercent.textContent = totalBytes > 0
        ? `${freePct}% free`
        : "Measured";
    el.cacheDiskSpaceFill.style.width = totalBytes > 0 ? `${usedPct}%` : "0%";
    el.cacheDiskSpaceFill.classList.remove(
        "timeline-insights__fill--step-1",
        "timeline-insights__fill--step-2",
        "timeline-insights__fill--step-3"
    );
    let fillColor = "var(--timeline-insights__fill-background)";
    if (usedPct >= 70) {
        el.cacheDiskSpaceFill.classList.add("timeline-insights__fill--step-3");
        fillColor = "var(--timeline-insights__fill-over-background)";
    } else if (usedPct >= 30) {
        el.cacheDiskSpaceFill.classList.add("timeline-insights__fill--step-2");
        fillColor = "var(--timeline-insights__fill-warn-background)";
    } else {
        el.cacheDiskSpaceFill.classList.add("timeline-insights__fill--step-1");
        fillColor = "var(--timeline-insights__fill-background)";
    }
    el.cacheDiskSpacePercent.style.setProperty("--cache-disk-space-percent-color", fillColor);
    if (el.cacheDiskSpace) {
        el.cacheDiskSpace.title = folder || "No cache folder resolved yet";
    }
};

const getDiskRefreshThresholdBytes = () => {
    const mb = Number(state.settings.diskSpaceRefreshMb) || 256;
    if (mb <= 0) return 0;
    return mb * 1024 * 1024;
};

const rememberDiskSpaceMeasurement = (disk, folder) => {
    if (!disk || !Number.isFinite(Number(disk.freeBytes))) return false;
    const freeBytes = Math.max(0, Number(disk.freeBytes));
    const totalDiskBytes = Math.max(0, Number(disk.totalBytes) || 0);
    state.lastDiskSpaceCheckAt = Date.now();
    state.lastDiskSpaceSessionBytes = Number(state.sessionBytes) || 0;
    if (
        state.lastCacheHealth &&
        state.lastCacheHealth.folder === folder
    ) {
        state.lastCacheHealth.diskChecked = true;
        state.lastCacheHealth.freeBytes = freeBytes;
        state.lastCacheHealth.totalDiskBytes = totalDiskBytes;
        state.lastCacheHealth.checkedAt = state.lastDiskSpaceCheckAt;
    }
    return true;
};

const shouldRefreshDiskSpaceAfterSave = () => {
    const thresholdBytes = getDiskRefreshThresholdBytes();
    if (thresholdBytes <= 0) return false;
    const savedSinceCheck = Math.max(
        0,
        (Number(state.sessionBytes) || 0) -
            (Number(state.lastDiskSpaceSessionBytes) || 0)
    );
    return savedSinceCheck >= thresholdBytes;
};

const getCacheDiskProbeFolder = (folder) => {
    return String(
        folder ||
        state.currentDejavuFolder ||
        state.settings.folder ||
        ""
    ).trim();
};

const refreshCacheDiskSpace = (folder) => {
    const resolvedFolder = getCacheDiskProbeFolder(folder);
    if (!resolvedFolder) {
        renderCacheDiskSpace(null, "");
        return Promise.resolve(null);
    }
    return getDiskSpaceInfo(resolvedFolder).then((disk) => {
        if (disk && Number.isFinite(Number(disk.freeBytes))) {
            renderCacheDiskSpace(disk, resolvedFolder);
            rememberDiskSpaceMeasurement(disk, resolvedFolder);
        } else {
            renderCacheDiskSpace(null, resolvedFolder);
        }
        return disk;
    });
};

const renderCacheHealth = (files, result, disk) => {
    if (!el.cacheHealthSummary) return;
    const stats = summarizeCacheFiles(files);
    const folder = (result && (result.folder || result.folderPath)) ||
        state.currentDejavuFolder ||
        "";
    const cachedDisk = state.lastCacheHealth &&
        state.lastCacheHealth.folder === folder &&
        state.lastCacheHealth.diskChecked
        ? {
            freeBytes: state.lastCacheHealth.freeBytes,
            totalBytes: state.lastCacheHealth.totalDiskBytes || 0
        }
        : null;
    const diskInfo = disk || cachedDisk;
    renderCacheDiskSpace(diskInfo, folder);
    const latestModified = stats.latest ? Number(stats.latest.modified) || 0 : 0;
    const latestLabel = latestModified
        ? (Fmt.relative(latestModified) || "just now")
        : "none";
    const hasDiskMeasurement = diskInfo &&
        Number.isFinite(Number(diskInfo.freeBytes));
    const freeLabel = "";
    const missingLabel = stats.missing > 0
        ? ` · ${stats.missing} missing`
        : "";
    el.cacheHealthSummary.textContent =
        `${stats.count} snapshots · ${formatBytes(stats.totalBytes)}${missingLabel} · latest ${latestLabel}${freeLabel}`;
    el.cacheHealthSummary.title = folder || "No cache folder resolved yet";

    const thresholdBytes =
        (Number(state.settings.diskSpaceWarningMb) || 0) * 1024 * 1024;
    let warning = "";
    if (stats.missing > 0) {
        warning = stats.missing === 1
            ? "1 cache entry points to a file that is no longer on disk."
            : `${stats.missing} cache entries point to files that are no longer on disk.`;
    }
    if (diskInfo && thresholdBytes > 0 && diskInfo.freeBytes < thresholdBytes) {
        warning = `Low disk space: ${formatBytes(diskInfo.freeBytes)} free near the dejavu folder.`;
    }
    setCacheHealthWarning(warning);
    state.lastCacheHealth = {
        folder,
        checkedAt: Date.now(),
        count: stats.count,
        totalBytes: stats.totalBytes,
        missing: stats.missing,
        diskChecked: !!hasDiskMeasurement,
        freeBytes: hasDiskMeasurement ? Math.max(0, Number(diskInfo.freeBytes)) : 0,
        totalDiskBytes: diskInfo && diskInfo.totalBytes ? diskInfo.totalBytes : 0
    };
};

const auditCacheHealth = (options) => {
    const opts = options || {};
    if (!opts.quiet) setHint("Auditing dejavu cache…");
    return Promise.resolve(refreshVersions(true)).then((result) => {
        const files = result && result.ok ? (result.files || []) : state.versions;
        const folder = (result && (result.folder || result.folderPath)) ||
            state.currentDejavuFolder ||
            state.settings.folder ||
            "";
        return refreshCacheDiskSpace(folder).then((disk) => {
            renderCacheHealth(files, result, disk);
            if (!opts.quiet) {
                setHint("Cache audit complete.", "ok");
            }
            return { ok: true, disk, files };
        });
    });
};

const maybeWarnLowDiskSpace = (folder, options) => {
    const opts = options || {};
    const thresholdMb = Number(state.settings.diskSpaceWarningMb) || 0;
    const now = Date.now();
    const dueForWarning = thresholdMb > 0 &&
        now - state.lastDiskSpaceCheckAt >= 10 * 60000;
    const dueForSavedBytes = shouldRefreshDiskSpaceAfterSave();
    if (!opts.force && !dueForWarning && !dueForSavedBytes) {
        return Promise.resolve(null);
    }
    const resolvedFolder = folder || state.currentDejavuFolder || "";
    return getDiskSpaceInfo(resolvedFolder).then((disk) => {
        if (!disk || !Number.isFinite(Number(disk.freeBytes))) return null;
        renderCacheDiskSpace(disk, resolvedFolder);
        rememberDiskSpaceMeasurement(disk, resolvedFolder);
        const thresholdBytes = thresholdMb * 1024 * 1024;
        if (disk.freeBytes < thresholdBytes) {
            const message = `Low disk space: ${formatBytes(disk.freeBytes)} free near the dejavu folder.`;
            setHint(message, "warn");
            setCacheHealthWarning(message);
        }
        return disk;
    });
};

const openLatestRecoverableSnapshot = () => {
    setHint("Opening latest recoverable snapshot…");
    return Promise.resolve(refreshVersions(true)).then(() => {
        const candidates = getRecoveryCandidates()
            .concat((state.versions || []).map((item) => {
                return {
                    path: item.path,
                    name: item.name,
                    timestamp: Number(item.modified) || 0,
                    size: Number(item.size) || 0,
                    fromTimeline: true
                };
            }))
            .filter((item) => item && item.path)
            .sort((a, b) => {
                return (Number(b.timestamp || b.modified) || 0) -
                    (Number(a.timestamp || a.modified) || 0);
            });
        if (!candidates.length) {
            setHint("No recoverable snapshots found.", "warn");
            return null;
        }

        let index = 0;
        const tryNext = () => {
            const candidate = candidates[index++];
            if (!candidate) {
                setHint("No existing recovery files were found on disk.", "warn");
                return Promise.resolve(null);
            }
            return callHost("dejavu_pathExists", [candidate.path]).then((exists) => {
                if (!exists || !exists.ok || !exists.exists) {
                    return tryNext();
                }
                return openSnapshotAndDejavu(
                    candidate.path,
                    candidate.fromTimeline ? "latest snapshot" : "latest recovery"
                );
            });
        };
        return tryNext();
    });
};

/**
 * Reads the loaded UXP host version and warns if it does not match
 * what this panel expects.
 */
const verifyHostVersion = (attemptedReload) => {
    callHost("dejavu_getHostVersion", []).then((result) => {
        const version = result && result.ok ? result.version : null;
        if (version === EXPECTED_UXP_HOST_VERSION) return;
        if (!attemptedReload) {
            // Re-check once after the UXP host bridge has had a chance
            // to initialize.
            ensureHostLoaded(true).then(() => {
                verifyHostVersion(true);
                validateFolderInput();
                refreshDocStatus();
            });
            return;
        }
        setHint(
            `Unexpected UXP host version (${(version || "unknown")} ≠ ${EXPECTED_UXP_HOST_VERSION}). Fully quit & relaunch Illustrator to apply fixes.`,
            "warn"
        );
        // eslint-disable-next-line no-console
        console.warn(
            `[DejaVu] host version mismatch: expected ${EXPECTED_UXP_HOST_VERSION}, got ${version}`
        );
    });
};

const getHostOptions = (info) => {
    const pending = getPendingUnsavedRecordForInfo(info);
    return {
        keepCount: state.settings.keepCount,
        keepDays: state.settings.keepDays,
        maxFolderSizeMb: state.settings.maxFolderSizeMb,
        folderTemplate: state.settings.folderTemplate,
        backupOriginalBeforeDejavu: state.settings.backupOriginalBeforeDejavu,
        pendingDocumentSessionId: pending.documentSessionId || "",
        documentSessionId: info && info.documentSessionId
            ? info.documentSessionId
            : ""
    };
};

const refreshVersions = (force) => {
    if (!force && state.settings.autoRefreshTimeline === false) {
        return Promise.resolve({ ok: true, skipped: true });
    }
    if (state.refreshVersionsPromise) return state.refreshVersionsPromise;
    state.refreshVersionsPromise = callHost("dejavu_listDejavus", [
        state.settings.folder || "",
        state.settings.folderPerDocument,
        state.settings.pendingUnsavedDejavuFolder || "",
        state.settings.folderTemplate || "",
        state.settings.pendingUnsavedDocumentSessionId || ""
    ]).then((result) => {
        if (result && result.ok) {
            state.currentDejavuFolder = result.folder || "";
            updateFolderStatus(state.currentDejavuFolder);
            renderVersions(result.files || []);
            renderCacheHealth(result.files || [], result, null);
        } else {
            updateFolderStatus("");
            renderVersions([]);
            renderCacheHealth([], result, null);
        }
        return result;
    }).then((result) => {
        state.refreshVersionsPromise = null;
        return result;
    }, (err) => {
        state.refreshVersionsPromise = null;
        throw err;
    });
    return state.refreshVersionsPromise;
};

const cleanupDejavus = (manual) => {
    manual = !!manual;
    const keep = Number(state.settings.keepCount) || 0;
    const days = Number(state.settings.keepDays) || 0;
    const maxMb = Number(state.settings.maxFolderSizeMb) || 0;
    const hasConfiguredRule = keep > 0 || days > 0 || maxMb > 0;
    // Automatic cleanup must honor "0 disables this rule" exactly.
    // Only an explicit click on Clean with every rule disabled falls
    // back to a one-snapshot purge, so the button still does something
    // useful without turning that behavior into a hidden retention rule.
    if (!manual && !hasConfiguredRule) {
        return Promise.resolve({ ok: true, deleted: 0, skipped: true });
    }
    const effectiveKeep = keep > 0
        ? keep
        : (manual && !hasConfiguredRule ? 1 : 0);
    // Resolve the live dejavu folder first so cleanup can never
    // target a stale or empty path (which silently deleted nothing).
    return refreshVersions(true).then(() => {
        if (!isValidFolderValue(state.currentDejavuFolder)) {
            if (manual) setHint("No dejavu folder to clean yet.", "warn");
            return { ok: true, deleted: 0 };
        }
        
        // For manual cleanup, always call host to remove missing files from manifest
        // even if no files need to be deleted based on retention rules
        if (manual) {
            return callHost("dejavu_cleanupDejavus", [
                state.currentDejavuFolder,
                effectiveKeep,
                days,
                maxMb,
                getProtectedSnapshotPaths()
            ]).then((result) => {
                if (result && result.ok) {
                    const protectedLabel = result.protected > 0
                        ? ` · ${result.protected} pinned preserved`
                        : "";
                    const missingLabel = result.missingRemoved > 0
                        ? ` · ${result.missingRemoved} missing removed`
                        : "";
                    setHint(
                        (result.deleted > 0 || result.missingRemoved > 0)
                            ? `Cleaned ${result.deleted} snapshot(s)${protectedLabel}${missingLabel}.`
                            : `Nothing to clean — snapshots are within the limits${protectedLabel}.`,
                        "ok"
                    );
                    // Refresh timeline to show removed missing files
                    if (result.missingRemoved > 0) {
                        refreshVersions(true);
                    }
                } else {
                    setHint(
                        `Cleanup failed: ${(result && result.error ? result.error : "unknown")}`,
                        "warn"
                    );
                }
                return result;
            });
        }
        
        if (!state.versions || state.versions.length <= 1) {
            return { ok: true, deleted: 0 };
        }
        
        return callHost("dejavu_cleanupDejavus", [
            state.currentDejavuFolder,
            effectiveKeep,
            days,
            maxMb,
            getProtectedSnapshotPaths()
        ]).then((result) => {
            return result;
        });
    });
};

const checkRecoveryWarning = () => {
    if (!state.settings.recoveryCheck) return Promise.resolve(null);
    if (state.activeInfo && state.activeInfo.openedDejavu) {
        state.recoveryWarningPath = "";
        return Promise.resolve({
            ok: true,
            hasNewerDejavu: false,
            openedDejavu: true
        });
    }
    return callHost("dejavu_getRecoveryWarning", [
        state.settings.folder || "",
        state.settings.folderPerDocument,
        state.settings.pendingUnsavedDejavuFolder || "",
        state.settings.folderTemplate || "",
        state.settings.pendingUnsavedDocumentSessionId || ""
    ]).then((result) => {
        if (result && result.ok && result.hasNewerDejavu) {
            state.recoveryWarningPath = result.latestPath;
            setHint(`Newer dejavu exists: ${result.latestName}`, "warn");
        }
        return result;
    });
};

const clearDejavuRetry = () => {
    if (state.retryTimerId !== null) {
        window.clearTimeout(state.retryTimerId);
        state.retryTimerId = null;
    }
    state.retryAt = 0;
    state.retryDelayMs = 0;
};

const resetDejavuFailureState = () => {
    state.consecutiveSaveFailures = 0;
    clearDejavuRetry();
};

const scheduleDejavuRetry = (message) => {
    if (!isDejavuEnabledForCurrent() || isSnoozed()) return;
    clearDejavuRetry();
    state.consecutiveSaveFailures++;
    const delay = Math.min(
        DEJAVU_RETRY_MAX_MS,
        DEJAVU_RETRY_BASE_MS * Math.pow(
            2,
            Math.max(0, state.consecutiveSaveFailures - 1)
        )
    );
    state.retryAt = Date.now() + delay;
    state.retryDelayMs = delay;
    state.retryTimerId = window.setTimeout(() => {
        state.retryTimerId = null;
        state.retryAt = 0;
        state.retryDelayMs = 0;
        runDejavuCycle(false).catch((err) => {
            setHint(
                `Retry failed: ${(err && err.message ? err.message : err)}`,
                "warn"
            );
        });
    }, delay);
    setHint(
        `Save failed: ${message} · retrying in ${Math.ceil(delay / 1000)}s`,
        "warn"
    );
};

const runQueuedSaveIfNeeded = () => {
    if (!state.saveRequestedWhileBusy) return;
    state.saveRequestedWhileBusy = false;
    window.setTimeout(() => {
        setHint("Running queued save…");
        runDejavuCycle(true).catch((err) => {
            setHint(
                `Queued save failed: ${(err && err.message ? err.message : err)}`,
                "warn"
            );
        });
    }, 0);
};

const updateSessionStats = () => {
    if (!el.sessionStatsValue) return;
    let text = state.sessionSaveCount +
        (state.sessionSaveCount === 1 ? " save" : " saves");
    if (state.sessionFailureCount > 0) {
        text += ` · ${state.sessionFailureCount} failed`;
    }
    if (state.sessionBytes > 0) {
        text += ` · ${formatBytes(state.sessionBytes)}`;
    }
    if (state.sessionLastDurationMs > 0) {
        text += ` · ${(state.sessionLastDurationMs / 1000).toFixed(1)}s`;
    }
    el.sessionStatsValue.textContent = text;
    el.sessionStatsValue.title = "Dejavus completed during this panel session";
};

/**
 * A themed, promise-based text-input dialog that replaces window.prompt
 * (whose native chrome leaks the "JavaScript Prompt — file:///…" header).
 * Resolves to the typed string, or null when cancelled.
 * @param {Object} options title, message, value, placeholder, confirmText,
 *     cancelText, maxLength.
 * @return {Promise<string|null>}
 */
const showInputDialog = (options) => {
    const opts = options || {};
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";

        const modal = document.createElement("div");
        modal.className = "modal";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");

        if (opts.title) {
            const title = document.createElement("div");
            title.className = "modal__title";
            title.textContent = opts.title;
            modal.appendChild(title);
        }
        if (opts.message) {
            const message = document.createElement("p");
            message.className = "modal__message";
            message.textContent = opts.message;
            modal.appendChild(message);
        }

        const input = document.createElement("input");
        input.type = "text";
        input.className = "modal__input";
        input.value = opts.value || "";
        if (opts.placeholder) input.placeholder = opts.placeholder;
        if (opts.maxLength) input.maxLength = opts.maxLength;
        input.autocomplete = "off";
        input.spellcheck = false;
        modal.appendChild(input);

        const actions = document.createElement("div");
        actions.className = "modal__actions";
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn btn--ghost";
        cancelBtn.textContent = opts.cancelText || "Cancel";
        const okBtn = document.createElement("button");
        okBtn.type = "button";
        okBtn.className = "btn btn--primary";
        okBtn.textContent = opts.confirmText || "OK";
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        modal.appendChild(actions);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        let closed = false;
        const close = (value) => {
            if (closed) return;
            closed = true;
            document.removeEventListener("keydown", onKey, true);
            overlay.classList.remove("is-open");
            window.setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 160);
            resolve(value);
        };
        const onKey = (evt) => {
            if (evt.key === "Escape") {
                evt.preventDefault();
                close(null);
            } else if (evt.key === "Enter") {
                evt.preventDefault();
                close(input.value);
            }
        };
        cancelBtn.addEventListener("click", () => close(null));
        okBtn.addEventListener("click", () => close(input.value));
        overlay.addEventListener("mousedown", (evt) => {
            if (evt.target === overlay) close(null);
        });
        document.addEventListener("keydown", onKey, true);

        window.requestAnimationFrame(() => {
            overlay.classList.add("is-open");
            input.focus();
            input.select();
        });
    });
};

const createNamedCheckpoint = () => {
    if (state.isSaving) {
        setHint("Wait for the current save before creating a checkpoint.", "warn");
        return;
    }
    showInputDialog({
        title: "Name this checkpoint",
        message: "Creates a pinned dejavu that cleanup won't remove.",
        value: "Milestone",
        placeholder: "Checkpoint name",
        confirmText: "Create",
        maxLength: 160
    }).then((entered) => {
        if (entered === null) return null;
        const label = String(entered).trim().slice(0, 160) || "Checkpoint";
        setHint("Creating checkpoint…");
        return runDejavuCycle(true).then((result) => {
            if (!result || !result.ok || !result.path) return null;
            const protectedSnapshots = state.settings.protectedSnapshots || {};
            const notes = state.settings.snapshotNotes || {};
            protectedSnapshots[result.path] = true;
            notes[result.path] = label;
            state.settings.protectedSnapshots = protectedSnapshots;
            state.settings.snapshotNotes = notes;
            saveSettings();
            return refreshVersions(true).then(() => {
                setHint(`Pinned checkpoint created: ${label}`, "ok");
            });
        });
    }).catch((err) => {
        setHint(`Checkpoint failed: ${(err && err.message ? err.message : err)}`, "warn");
    });
};

/**
 * Core dejavu cycle: checks doc state, compares fingerprint, and
 * only writes to disk if content actually changed since the last
 * successful save/dejavu.
 *
 * Dejavu always writes a templated copy, never overwriting the
 * document's own file directly. Where that copy goes depends on
 * whether the document has been saved before: an already-saved
 * document gets its copy saved alongside it, in that document's
 * own folder (the configured default folder is ignored in this
 * case); a never-saved document has no folder of its own, so the
 * configured default folder is required and used instead.
 * "Overwrite previous dejavu copy" only controls whether
 * repeated cycles reuse the same resolved filename (overwriting
 * that dejavu copy) or always create a new uniquely-suffixed
 * one — it has no effect on which folder is used.
 *
 * @param {boolean} force If true, bypasses the fingerprint check.
 */
const runDejavuCycle = (force) => {
    if (state.isSaving) {
        if (force) {
            state.saveRequestedWhileBusy = true;
            setHint("Save queued — it will run after the current save.", "ok");
            return Promise.resolve({ ok: true, queued: true });
        }
        return Promise.resolve(null);
    }
    // While snoozed, scheduled cycles are skipped; an explicit
    // "Save now" (force) still goes through and ends the snooze.
    if (isSnoozed()) {
        if (!force) return Promise.resolve(null);
        resumeFromSnooze();
    }
    state.isSaving = true;
    state.currentSaveStartedAt = Date.now();
    setSaving(true);
    return waitForSavingVisualPaint().then(() => {
        return callHost("dejavu_getActiveDocInfo", [true]);
    }).then((info) => {
        if (!info || info.ok === false) {
            updateCurrentDocument(null);
            syncDejavuModeUi();
            syncDejavuLoop();
            setDotState("error");
            setHint(
                `Host error: ${(info && info.error ? info.error : "unknown")}`,
                "warn"
            );
            return null;
        }
        if (!info.hasDoc) {
            updateCurrentDocument(info);
            syncDejavuModeUi();
            syncDejavuLoop();
            setStatusDot(false);
            setHint("No document open.", "warn");
            return null;
        }
        updateCurrentDocument(info);
        syncDejavuModeUi();
        if (!force && !isDejavuEnabledForCurrent()) {
            syncDejavuLoop();
            setHint("Dejavu is off for this document.");
            return null;
        }
        setStatusDot(true);
        el.docNameValue.textContent = info.docName;
        el.docNameValue.dataset.baseName = info.baseName;
        el.docNameValue.dataset.dejavuFormat = info.dejavuFormat || "ai";
        updateFormatIndicator(info.dejavuFormat);
        updatePreview();

        const unchanged =
            state.lastFingerprint !== null &&
            state.lastFingerprint === info.fingerprint;

        if (
            unchanged &&
            !force &&
            state.settings.onlySaveWhenChanged
        ) {
            setHint("No changes since last save — skipped.", "ok");
            syncDejavuLoop();
            return null;
        }

        // Dejavu saves into the document's own folder when it
        // has one (already-saved documents) — the configured
        // default folder is only needed as a fallback for
        // documents that have never been saved, since there's no
        // "document's own folder" to use in that case.
        // Always use the configured folder (defaults to "~/"), even
        // if not yet validated — the host will create it if needed.
        const folder = isValidFolderValue(state.settings.folder)
            ? state.settings.folder
            : "~/";
        const useFolderPerDocument = state.settings.folderPerDocument ||
            !info.hasPath;
        return finalizePendingFolderIfNeeded(info).then(() => {
            const pending = getPendingUnsavedRecordForInfo(info);
            return callHost("dejavu_dejavu", [
                folder,
                state.settings.template,
                state.settings.overwriteExisting,
                useFolderPerDocument,
                pending.folder || "",
                pending.baseName || info.baseName,
                state.settings.folderTemplate || "",
                getHostOptions(info)
            ]);
        }).then((result) => {
            if (result && result.ok) {
                resetDejavuFailureState();
                recordRecoveryCandidate(result, info);
                state.sessionSaveCount++;
                state.sessionBytes += Number(result.size) || 0;
                state.sessionLastDurationMs = Math.max(
                    1,
                    Date.now() - state.currentSaveStartedAt
                );
                state.settings.dejavuSuccessCount =
                    (Number(state.settings.dejavuSuccessCount) || 0) + 1;
                const autoPinEvery = Number(state.settings.autoPinEvery) || 0;
                if (
                    autoPinEvery > 0 &&
                    state.settings.dejavuSuccessCount % autoPinEvery === 0
                ) {
                    state.settings.protectedSnapshots =
                        state.settings.protectedSnapshots || {};
                    state.settings.protectedSnapshots[result.path] = true;
                }
                saveSettings();
                updateSessionStats();
                state.lastFingerprint = result.fingerprint;
                const savedAt = Number(result.timestamp || result.savedAt) ||
                    Date.now();
                state.lastSavedAt = new Date(savedAt);
                // Remember the per-document last-save time for the
                // multi-document overview.
                if (state.currentDocKey) {
                    state.docLastSaved[state.currentDocKey] = savedAt;
                }
                el.lastSavedValue.textContent = formatTime(
                    state.lastSavedAt
                );
                if (result.pendingUnsavedFolder) {
                    rememberPendingUnsavedFolderForInfo(
                        info,
                        result.pendingUnsavedFolder
                    );
                } else if (
                    info.hasPath ||
                    !useFolderPerDocument
                ) {
                    clearPendingUnsavedFolderForInfo(info);
                }
                state.currentDejavuFolder = result.dejavuFolder || "";
                setHint(`Saved: ${result.path}`, "ok");
                cleanupDejavus(false);
                maybeWarnLowDiskSpace(state.currentDejavuFolder);
            } else {
                state.sessionFailureCount++;
                updateSessionStats();
                const message =
                    result && result.error
                        ? result.error
                        : "Could not save document.";
                scheduleDejavuRetry(message);
                setDotState("error");
            }
            return result;
        });
    }).then((result) => {
        state.isSaving = false;
        setSaving(false);
        runQueuedSaveIfNeeded();
        return result;
    }, (err) => {
        state.isSaving = false;
        state.sessionFailureCount++;
        updateSessionStats();
        setDotState("error");
        setSaving(false);
        scheduleDejavuRetry(err && err.message ? err.message : err);
        runQueuedSaveIfNeeded();
        throw err;
    });
};

/**
 * Lets Chromium paint the saving class before Illustrator begins a
 * synchronous host operation. Without this yield, fast call dispatch can
 * block the first frame and make the LED animation appear not to run.
 * Hidden panels skip the frame wait because requestAnimationFrame may be
 * heavily throttled while dejavu must continue normally.
 * @return {Promise<void>}
 */
const waitForSavingVisualPaint = () => {
    if (document.hidden || typeof window.requestAnimationFrame !== "function") {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        window.requestAnimationFrame(() => {
            window.setTimeout(resolve, 0);
        });
    });
};

/**
 * Starts the polling loop driving dejavu + the visible countdown.
 */
const startLoop = () => {
    stopLoop();
    const intervalMs = getIntervalMs();
    state.intervalTotalMs = intervalMs;
    state.nextTickAt = Date.now() + intervalMs;

    // Initialize the ring's dash geometry once; the offset is then
    // animated each frame by updateCountdownPie.
    if (el.countdownPieSweep) {
        el.countdownPieSweep.style.strokeDasharray = String(
            COUNTDOWN_RING_CIRCUMFERENCE
        );
    }

    state.timerId = window.setInterval(() => {
        runDejavuCycle(false).catch((err) => {
            setHint(
                `Save failed: ${(err && err.message ? err.message : err)}`,
                "warn"
            );
        });
        state.intervalTotalMs = getIntervalMs();
        state.nextTickAt = Date.now() + state.intervalTotalMs;
    }, intervalMs);

    state.countdownId = window.setInterval(updateCountdown, 1000);
    updateCountdown();
    startPieAnimation();
};

/**
 * Stops the polling loop and countdown display.
 */
const stopLoop = () => {
    if (state.timerId !== null) {
        window.clearInterval(state.timerId);
        state.timerId = null;
    }
    if (state.countdownId !== null) {
        window.clearInterval(state.countdownId);
        state.countdownId = null;
    }
    stopPieAnimation();
    clearDejavuRetry();
    state.consecutiveSaveFailures = 0;
    state.nextTickAt = null;
    state.intervalTotalMs = 0;
    updateCountdownPie();
    el.nextCheckValue.textContent = "—";
};

/**
 * Exports current settings as a JSON file.
 */
const exportSettings = () => {
    const payload = {
        exportedBy: "DejaVu",
        exportedAt: new Date().toISOString(),
        settings: state.settings
    };
    const content = JSON.stringify(payload, null, 2);
    // Route through the host so the user gets a native Save dialog
    // and can pick both the folder and the file name, instead of a
    // silent download to a fixed location.
    callHost("dejavu_saveTextFile", [
        "dejavuai-settings.json",
        content
    ]).then((result) => {
        if (result && result.ok) {
            setHint(`Settings exported: ${result.path}`, "ok");
        } else if (result && result.cancelled) {
            setHint("Export cancelled.");
        } else {
            setHint(
                `Export failed: ${(result && result.error ? result.error : "unknown")}`,
                "warn"
            );
        }
    });
};

/**
 * Applies a raw parsed settings object safely.
 * @param {Object} incoming Parsed import payload.
 */
const importSettingsObject = (incoming) => {
    const source = incoming && incoming.settings ? incoming.settings : incoming;
    if (!source || typeof source !== "object") {
        setHint("Import failed: invalid settings file.", "warn");
        return;
    }
    const merged = clone(DEFAULT_SETTINGS);
    for (const key in merged) {
        if (source.hasOwnProperty(key)) merged[key] = source[key];
    }
    merged.fileDejavuOverrides = normalizeFileDejavuOverrides(
        merged.fileDejavuOverrides
    );
    merged.protectedSnapshots = normalizePlainObject(
        merged.protectedSnapshots
    );
    merged.timelineSort = normalizeTimelineSort(merged.timelineSort);
    merged.timelineRange = normalizeTimelineRange(merged.timelineRange);
    merged.snapshotNotes = normalizeStringMap(merged.snapshotNotes);
    state.settings = merged;
    saveSettings();
    hydrateForm();
    syncDejavuModeUi();
    syncDejavuLoop();
    refreshVersions(true);
    setHint("Settings imported.", "ok");
};

/**
 * Resets all settings while keeping no stale per-file overrides.
 */
const resetSettings = () => {
    state.settings = clone(DEFAULT_SETTINGS);
    state.settings.fileDejavuOverrides = {};
    state.settings.protectedSnapshots = {};
    state.settings.snapshotNotes = {};
    saveSettings();
    // Persist a one-shot flag so the "Settings reset." confirmation can be
    // shown after the reload below re-runs init().
    try {
        window.sessionStorage.setItem("dejavu:settingsResetHint", "1");
    } catch (e) {
        // sessionStorage may be unavailable; the reload still proceeds.
    }
    // Full reload so the panel re-reads index.html, CSS and JS from disk
    // (all cache-busted by index.html's loader) and re-hydrates from the
    // defaults we just persisted. settingsStore.save() writes localStorage
    // synchronously, so those defaults are durable before we reload.
    window.location.reload(true);
};

/**
 * Applies loaded settings into the form controls.
 */
const hydrateForm = () => {
    const s = state.settings;
    syncDejavuModeUi();
    el.intervalInput.value = s.intervalValue;
    if (el.intervalUnit) {
        el.intervalUnit.value = String(parseInt(s.intervalUnit, 10) || 60);
    }
    if (state.filenameTokenInput) {
        state.filenameTokenInput.setValue(parseTemplateParts(s.template));
        el.templateInput.value = state.filenameTokenInput.getText();
    } else if (el.templateInput) {
        el.templateInput.value = s.template;
    }
    el.overwriteToggle.checked = !!s.overwriteExisting;
    el.onlyIfChangedToggle.checked = !!s.onlySaveWhenChanged;
    el.keepCountInput.value = s.keepCount;
    el.keepDaysInput.value = s.keepDays;
    el.maxFolderSizeInput.value = s.maxFolderSizeMb;
    if (el.diskSpaceWarningInput) {
        el.diskSpaceWarningInput.value = s.diskSpaceWarningMb;
    }
    if (el.diskSpaceRefreshInput) {
        el.diskSpaceRefreshInput.value = Math.max(
            1,
            parseInt(s.diskSpaceRefreshMb, 10) || 256
        );
    }
    if (el.recoveryVersionsInput) {
        el.recoveryVersionsInput.value = Math.max(
            1,
            parseInt(s.recoveryVersionsPerUnsavedDoc, 10) || 5
        );
    }
    if (el.recoveryMaxEntriesInput) {
        el.recoveryMaxEntriesInput.value = Math.max(
            10,
            parseInt(s.recoveryMaxCandidates, 10) || 80
        );
    }
    s.folderTemplate = normalizeFolderTemplate(s.folderTemplate);
    renderFolderTemplateEditor(s.folderTemplate);
    if (el.folderPerDocumentToggle) {
        el.folderPerDocumentToggle.checked = !!s.folderPerDocument;
    }
    el.recoveryCheckToggle.checked = !!s.recoveryCheck;
    el.autoRecoverCrashToggle.checked = s.autoRecoverAfterCrash !== false;
    el.autoPinEveryToggle.checked = (parseInt(s.autoPinEvery, 10) || 0) > 0;
    el.backupOriginalToggle.checked = !!s.backupOriginalBeforeDejavu;
    el.saveOnEnableToggle.checked = s.saveImmediatelyOnEnable !== false;
    el.saveOnDocumentSwitchToggle.checked = !!s.saveOnDocumentSwitch;
    if (el.checkForUpdatesToggle) {
        el.checkForUpdatesToggle.checked = s.checkForUpdates !== false;
    }
    setToggleIcon(el.autoRefreshTimelineToggle, s.autoRefreshTimeline !== false);
    setToggleIcon(el.timelineCompactToggle, !!s.timelineCompact);
    setToggleIcon(el.timelinePinnedOnlyToggle, !!s.timelinePinnedOnly);
    setToggleIcon(el.recoveryCompactToggle, !!s.recoveryCompact);
    setToggleIcon(el.recoveryPinnedOnlyToggle, !!s.recoveryPinnedOnly);
    el.timelineFilterInput.value = s.timelineFilter || "";
    el.recoveryFilterInput.value = s.recoveryFilter || "";
    el.timelineSortSelect.value = normalizeTimelineSort(s.timelineSort);
    el.recoverySortSelect.value = s.recoverySort || "newest";
    el.timelineRangeSelect.value = normalizeTimelineRange(s.timelineRange);
    el.recoveryRangeSelect.value = s.recoveryRange || "all";
    syncIntervalPresets();
    syncSafetyProfiles();

    if (isValidFolderValue(s.folder)) {
        el.folderInput.value = s.folder;
        el.folderInput.classList.add("has-value");
    } else {
        state.settings.folder = "~/";
        el.folderInput.value = "~/";
        el.folderInput.classList.add("has-value");
    }

    updatePreview();
    updateModeIndicator();
    updateFolderStatus(state.currentDejavuFolder || "");
};
