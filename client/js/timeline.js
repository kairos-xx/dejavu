/**
 * DejaVu — split from the original client/js/main.js.
 *
 * This file preserves the original statements and function bodies;
 * it only moves them into a responsibility-focused script file.
 */
"use strict";

let timelineTable = null;
let recoveryTable = null;

/** Returns the shared table controller for the Timeline drawer. */
const getTimelineTable = () => {
    if (!timelineTable && window.DejaVuTable) {
        timelineTable = window.DejaVuTable.create({
            keyForItem: (item) => String((item && item.path) || ""),
            getItems: () => state.versions || [],
            getSelectionStore: () => state.selectedSnapshotPaths,
            setSelectionStore: (store) => {
                state.selectedSnapshotPaths = store || {};
            },
            getBulkBar: () => el.timelineBulkBar,
            getSelectionCountEl: () => el.timelineSelectionCount,
            getSelectAllToggle: () => el.timelineSelectAllToggle,
            getQuery: () => state.settings.timelineFilter,
            getRange: () => normalizeTimelineRange(state.settings.timelineRange),
            getSort: () => normalizeTimelineSort(state.settings.timelineSort),
            textForItem: (item) => [
                item.name || "",
                item.path || "",
                getSnapshotNote(item.path),
                formatBytes(item.size || 0),
                formatTimestamp(item.modified || 0)
            ].join(" "),
            matchesRange: (item, range) => {
                if (range === "all") return true;
                const modified = Number(item.modified) || 0;
                const now = Date.now();
                if (range === "today") {
                    const start = new Date(now);
                    start.setHours(0, 0, 0, 0);
                    return modified >= start.getTime();
                }
                const days = range === "7d" ? 7 : 30;
                return modified >= now - days * 86400000;
            },
            matchesFilters: (item) => {
                return !state.settings.timelinePinnedOnly ||
                    isSnapshotProtected(item.path);
            },
            sorter: (a, b, sort) => {
                if (sort === "oldest") return (a.modified || 0) - (b.modified || 0);
                if (sort === "largest") return (b.size || 0) - (a.size || 0);
                if (sort === "smallest") return (a.size || 0) - (b.size || 0);
                return (b.modified || 0) - (a.modified || 0);
            },
            render: () => rerenderTimeline()
        });
    }
    return timelineTable;
};

/** Returns the shared table controller for the Recovery Center drawer. */
const getRecoveryTable = () => {
    if (!recoveryTable && window.DejaVuTable) {
        recoveryTable = window.DejaVuTable.create({
            keyForItem: (item) => String((item && item.path) || ""),
            getItems: () => getRecoveryCandidates() || [],
            getSelectionStore: () => state.selectedRecoveryPaths,
            setSelectionStore: (store) => {
                state.selectedRecoveryPaths = store || {};
            },
            getBulkBar: () => el.recoveryBulkBar,
            getSelectionCountEl: () => el.recoverySelectionCount,
            getSelectAllToggle: () => el.recoverySelectAllToggle,
            getQuery: () => state.settings.recoveryFilter,
            getRange: () => state.settings.recoveryRange || "all",
            getSort: () => state.settings.recoverySort || "newest",
            textForItem: (candidate) => [
                candidate.name || "",
                candidate.path || "",
                getSnapshotNote(candidate.path),
                formatTimestamp(candidate.timestamp || 0)
            ].join(" "),
            matchesRange: (candidate, range) => {
                if (range === "all") return true;
                const age = Date.now() - (candidate.timestamp || 0);
                if (range === "today") return age <= 86400000;
                if (range === "7d") return age <= 604800000;
                if (range === "30d") return age <= 2592000000;
                return true;
            },
            matchesFilters: (candidate) => {
                return !state.settings.recoveryPinnedOnly ||
                    !!(state.settings.protectedSnapshots || {})[candidate.path];
            },
            sorter: (a, b, sort) => {
                if (sort === "newest") return (b.timestamp || 0) - (a.timestamp || 0);
                if (sort === "oldest") return (a.timestamp || 0) - (b.timestamp || 0);
                if (sort === "name") {
                    const nameA = (a.name || "").toLowerCase();
                    const nameB = (b.name || "").toLowerCase();
                    if (nameA < nameB) return -1;
                    if (nameA > nameB) return 1;
                }
                return 0;
            },
            render: () => rerenderRecoveryCenter()
        });
    }
    return recoveryTable;
};

const readNumberInput = (input, fallback) => {
    const value = parseInt(input.value, 10);
    if (isNaN(value) || value < 0) return fallback;
    return value;
};

const formatBytes = (bytes) => {
    return Fmt.bytes(bytes);
};

const formatTimestamp = (ms) => {
    return Fmt.timestamp(ms);
};

/**
 * Human, compact relative time ("just now", "5 min ago",
 * "3 hr ago", "2 days ago") for a past timestamp. Used on the
 * timeline so each snapshot's recency is readable at a glance.
 * @param {number} ms Epoch milliseconds in the past.
 * @return {string}
 */
const formatRelativeTime = (ms) => {
    return Fmt.relative(ms);
};

/**
 * A short, signed size-difference label between two snapshots
 * (e.g. "+12 KB", "−480 B", "same"). Lets the timeline show how
 * the document grew or shrank between consecutive saves.
 * @param {number} bytes Current snapshot size.
 * @param {number} prevBytes Previous (older) snapshot size.
 * @return {{text: string, dir: string}} dir is "up"/"down"/"flat".
 */
const formatSizeDelta = (bytes, prevBytes) => {
    return Fmt.sizeDelta(bytes, prevBytes);
};

/**
 * Groups snapshots (assumed newest-first) into day buckets with a
 * friendly label ("Today", "Yesterday", or "Mon 3 Jun"). Returns
 * an ordered array of { label, items } preserving newest-first
 * order both across and within groups.
 * @param {Array} items Items with a modified or timestamp epoch field.
 * @return {Array<{label: string, items: Array}>}
 */
const groupSnapshotsByDay = (items) => {
    const startOfDay = (ms) => {
        const d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    };
    const todayStart = startOfDay(Date.now());
    const dayMs = 86400000;
    const months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];
    const weekdays = [
        "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"
    ];
    const nowMs = Date.now();
    const labelFor = (ms) => {
        // Anything within the last 60 minutes gets its own section at
        // the very top (items are newest-first, so this group sorts
        // first). Such items are not also repeated under "Today".
        if (nowMs - ms < 3600000) return "Last hour";
        const dayStart = startOfDay(ms);
        const diffDays = Math.round((todayStart - dayStart) / dayMs);
        if (diffDays === 0) return "Today";
        if (diffDays === 1) return "Yesterday";
        const d = new Date(ms);
        return `${weekdays[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
    };
    const groups = [];
    const index = {};
    items.forEach((item) => {
        const label = labelFor(item.modified || item.timestamp);
        if (!index[label]) {
            index[label] = { label, items: [] };
            groups.push(index[label]);
        }
        index[label].items.push(item);
    });
    return groups;
};

/**
 * Builds the remaining action cluster for a single snapshot.
 * Currently empty as actions have been moved to bulk bar.
 * @param {Object} item Snapshot { name, path, size, modified }.
 * @return {HTMLElement} The actions container.
 */
const buildSnapshotActions = (item) => {
    const actions = document.createElement("div");
    actions.className = "snapshot__actions";
    return actions;
};

/**
 * Returns true when the snapshot should be shown under the current
 * timeline filter.
 * @param {Object} item Snapshot object.
 * @param {string} query Lowercase query.
 * @return {boolean}
 */
const snapshotMatchesFilter = (item, query) => {
    if (
        state.settings.timelinePinnedOnly &&
        !isSnapshotProtected(item.path)
    ) {
        return false;
    }
    if (!query) return true;
    const haystack = [
        item.name || "",
        item.path || "",
        getSnapshotNote(item.path),
        formatBytes(item.size || 0),
        formatTimestamp(item.modified || 0)
    ].join(" ").toLowerCase();
    return haystack.indexOf(query) !== -1;
};

const snapshotMatchesRange = (item) => {
    const range = normalizeTimelineRange(state.settings.timelineRange);
    if (range === "all") return true;
    const modified = Number(item.modified) || 0;
    const now = Date.now();
    if (range === "today") {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        return modified >= start.getTime();
    }
    const days = range === "7d" ? 7 : 30;
    return modified >= now - days * 86400000;
};

/**
 * Applies current filter and sort settings to the stored snapshot list.
 * @return {Array}
 */
const getVisibleSnapshots = () => {
    const table = getTimelineTable();
    if (table) return table.visibleItems();
    const query = String(state.settings.timelineFilter || "")
        .toLowerCase()
        .trim();
    const out = (state.versions || []).filter((item) => {
        return snapshotMatchesRange(item) &&
            snapshotMatchesFilter(item, query);
    });
    const sort = normalizeTimelineSort(state.settings.timelineSort);
    out.sort((a, b) => {
        if (sort === "oldest") return (a.modified || 0) - (b.modified || 0);
        if (sort === "largest") return (b.size || 0) - (a.size || 0);
        if (sort === "smallest") return (a.size || 0) - (b.size || 0);
        return (b.modified || 0) - (a.modified || 0);
    });
    return out;
};

const isSnapshotProtected = (path) => {
    const protectedSnapshots = state.settings.protectedSnapshots || {};
    return !!protectedSnapshots[String(path || "")];
};

const getSnapshotNote = (path) => {
    const notes = state.settings.snapshotNotes || {};
    return String(notes[String(path || "")] || "");
};

const isEditingSnapshotNoteIn = (container) => {
    const active = document.activeElement;
    return !state.isFinishingNoteEdit &&
        !!container &&
        !!active &&
        active.classList &&
        active.classList.contains("snapshot__note-input") &&
        container.contains(active);
};

const renderAfterNoteEdit = (renderFn) => {
    state.isFinishingNoteEdit = true;
    try {
        renderFn();
    } finally {
        state.isFinishingNoteEdit = false;
    }
};

const editSnapshotNote = (item, noteEl) => {
    let path = String(item.path || "");
    if (!path || !noteEl || noteEl.dataset.editing === "true") return;
    const current = getSnapshotNote(path);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "snapshot__note-input";
    input.maxLength = 160;
    input.value = current;
    input.placeholder = "Note";
    noteEl.dataset.editing = "true";
    noteEl.textContent = "";
    noteEl.appendChild(input);
    let finished = false;
    const finish = (save) => {
        if (finished) return;
        finished = true;
        if (save) {
            const next = String(input.value || "").trim().slice(0, 160);
            const notes = state.settings.snapshotNotes || {};
            if (next) notes[path] = next;
            else delete notes[path];
            state.settings.snapshotNotes = notes;
            saveSettings();
            setHint(
                next ? "Snapshot note saved." : "Snapshot note removed.",
                "ok"
            );
        }
        renderAfterNoteEdit(rerenderTimeline);
    };
    input.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
            evt.preventDefault();
            finish(true);
        } else if (evt.key === "Escape") {
            evt.preventDefault();
            finish(false);
        }
    });
    input.addEventListener("blur", () => { finish(true); });
    input.focus();
    input.select();
};

const editSnapshotNoteForRecovery = (item, noteEl) => {
    let path = String(item.path || "");
    if (!path || !noteEl || noteEl.dataset.editing === "true") return;
    const current = getSnapshotNote(path);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "snapshot__note-input";
    input.maxLength = 160;
    input.value = current;
    input.placeholder = "Note";
    noteEl.dataset.editing = "true";
    noteEl.textContent = "";
    noteEl.appendChild(input);
    let finished = false;
    const finish = (save) => {
        if (finished) return;
        finished = true;
        if (save) {
            const next = String(input.value || "").trim().slice(0, 160);
            const notes = state.settings.snapshotNotes || {};
            if (next) notes[path] = next;
            else delete notes[path];
            state.settings.snapshotNotes = notes;
            saveSettings();
            setHint(
                next ? "Snapshot note saved." : "Snapshot note removed.",
                "ok"
            );
        }
        renderAfterNoteEdit(renderRecoveryCenter);
    };
    input.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
            evt.preventDefault();
            finish(true);
        } else if (evt.key === "Escape") {
            evt.preventDefault();
            finish(false);
        }
    });
    input.addEventListener("blur", () => { finish(true); });
    input.focus();
    input.select();
};

const isSnapshotSelected = (path) => {
    const table = getTimelineTable();
    if (table) return table.isSelected(String(path || ""));
    return !!state.selectedSnapshotPaths[String(path || "")];
};

const setSnapshotSelected = (path, selected) => {
    path = String(path || "");
    if (!path) return;
    const table = getTimelineTable();
    if (table) table.setSelected(path, selected);
    else if (selected) state.selectedSnapshotPaths[path] = true;
    else delete state.selectedSnapshotPaths[path];
    // Don't rerender during painting to avoid triggering unwanted selections
    if (!state.isPainting) {
        rerenderTimeline();
    } else {
        updateTimelineBulkBar();
    }
};

const getSelectedSnapshotPaths = () => {
    const table = getTimelineTable();
    if (table) return table.selectedKeys();
    const paths = [];
    for (const path in state.selectedSnapshotPaths) {
        if (
            state.selectedSnapshotPaths.hasOwnProperty(path) &&
            state.selectedSnapshotPaths[path]
        ) paths.push(path);
    }
    return paths;
};

const getSelectedRecoveryPaths = () => {
    const table = getRecoveryTable();
    if (table) return table.selectedKeys();
    const paths = [];
    for (const path in state.selectedRecoveryPaths) {
        if (
            state.selectedRecoveryPaths.hasOwnProperty(path) &&
            state.selectedRecoveryPaths[path]
        ) paths.push(path);
    }
    return paths;
};

const isRecoverySelected = (path) => {
    const table = getRecoveryTable();
    if (table) return table.isSelected(String(path || ""));
    return !!(state.selectedRecoveryPaths && state.selectedRecoveryPaths[path]);
};

const setRecoverySelected = (path, selected) => {
    path = String(path || "");
    if (!path) return;
    const table = getRecoveryTable();
    if (table) table.setSelected(path, selected);
    else {
        if (!state.selectedRecoveryPaths) state.selectedRecoveryPaths = {};
        if (selected) state.selectedRecoveryPaths[path] = true;
        else delete state.selectedRecoveryPaths[path];
    }
    if (!state.isPainting) {
        rerenderRecoveryCenter();
    } else {
        updateRecoveryBulkBar();
    }
};

const bulkDeleteRecoveryEntries = (paths) => {
    if (!paths || paths.length === 0) return;
    
    let deleteCount = 0;
    let chain = Promise.resolve();
    paths.forEach((path) => {
        chain = chain.then(() => {
            return callHost("dejavu_deletePath", [path]).then((result) => {
                if (result && result.ok) {
                    const notes = state.settings.snapshotNotes || {};
                    delete notes[path];
                    const protectedSnapshots = state.settings.protectedSnapshots || {};
                    delete protectedSnapshots[path];
                    state.settings.snapshotNotes = notes;
                    state.settings.protectedSnapshots = protectedSnapshots;
                    saveSettings();
                    deleteCount++;
                }
            });
        });
    });
    chain.then(() => {
        setHint(`Deleted ${deleteCount} recovery entr${(deleteCount === 1 ? "y" : "ies")}.`, "ok");
        clearRecoverySelection();
        renderRecoveryCenter();
    }).catch((err) => {
        setHint(`Delete failed: ${(err && err.message ? err.message : "unknown")}`, "warn");
    });
};

const clearRecoverySelection = () => {
    const table = getRecoveryTable();
    if (table) table.clearSelection();
    else state.selectedRecoveryPaths = {};
    updateRecoveryBulkBar();
    rerenderRecoveryCenter();
};

const getVisibleRecoveryCandidates = () => {
    const table = getRecoveryTable();
    if (table) return table.visibleItems();
    const candidates = getRecoveryCandidates();
    if (!candidates || candidates.length === 0) return [];
    
    const filter = (state.settings.recoveryFilter || "").toLowerCase();
    const pinnedOnly = !!state.settings.recoveryPinnedOnly;
    const protectedSnapshots = state.settings.protectedSnapshots || {};
    const range = state.settings.recoveryRange || "all";
    
    const now = Date.now();
    const filtered = candidates.filter((candidate) => {
        if (filter && candidate.name.toLowerCase().indexOf(filter) === -1) {
            return false;
        }
        if (pinnedOnly && !protectedSnapshots[candidate.path]) {
            return false;
        }
        if (range === "today") {
            const age = now - (candidate.timestamp || 0);
            if (age > 86400000) return false;
        } else if (range === "7d") {
            const age = now - (candidate.timestamp || 0);
            if (age > 604800000) return false;
        } else if (range === "30d") {
            const age = now - (candidate.timestamp || 0);
            if (age > 2592000000) return false;
        }
        return true;
    });
    
    const sort = state.settings.recoverySort || "newest";
    return [...filtered].sort((a, b) => {
        if (sort === "newest") return (b.timestamp || 0) - (a.timestamp || 0);
        if (sort === "oldest") return (a.timestamp || 0) - (b.timestamp || 0);
        if (sort === "name") {
            const nameA = (a.name || "").toLowerCase();
            const nameB = (b.name || "").toLowerCase();
            if (nameA < nameB) return -1;
            if (nameA > nameB) return 1;
            return 0;
        }
        return 0;
    });
};

const updateTimelineBulkBar = () => {
    const table = getTimelineTable();
    if (table) {
        table.syncBulkBar();
        return;
    }
    if (!el.timelineBulkBar) return;
    const count = getSelectedSnapshotPaths().length;
    el.timelineBulkBar.hidden = count === 0;
    el.timelineSelectionCount.textContent = count +
        (count === 1 ? " selected" : " selected");
};

const updateRecoveryBulkBar = () => {
    const table = getRecoveryTable();
    if (table) {
        table.syncBulkBar();
        return;
    }
    if (!el.recoveryBulkBar) return;
    const count = getSelectedRecoveryPaths().length;
    el.recoveryBulkBar.hidden = count === 0;
    el.recoverySelectionCount.textContent = count +
        (count === 1 ? " selected" : " selected");
};

const estimateRetentionCleanup = (items) => {
    const sorted = [...(items || [])].sort((a, b) => {
        return (b.modified || 0) - (a.modified || 0);
    });
    const keep = Number(state.settings.keepCount) || 0;
    const days = Number(state.settings.keepDays) || 0;
    const maxBytes = (Number(state.settings.maxFolderSizeMb) || 0) *
        1024 * 1024;
    const now = Date.now();
    const removed = {};
    const remaining = [];
    sorted.forEach((item, index) => {
        if (isSnapshotProtected(item.path)) {
            remaining.push(item);
            return;
        }
        const byCount = keep > 0 && index >= keep;
        const byAge = days > 0 &&
            now - Number(item.modified || 0) > days * 86400000;
        if (byCount || byAge) removed[item.path] = true;
        else remaining.push(item);
    });
    if (maxBytes > 0) {
        let total = remaining.reduce((sum, item) => {
            return sum + (Number(item.size) || 0);
        }, 0);
        for (let i = remaining.length - 1; i >= 0 && total > maxBytes; i--) {
            if (isSnapshotProtected(remaining[i].path)) continue;
            removed[remaining[i].path] = true;
            total -= Number(remaining[i].size) || 0;
        }
    }
    return Object.keys(removed).length;
};

const clearSnapshotSelection = () => {
    const table = getTimelineTable();
    if (table) table.clearSelection();
    else state.selectedSnapshotPaths = {};
    updateTimelineBulkBar();
    rerenderTimeline();
};

let clearArmed = false;
let clearDisarmTimer = null;

const disarmClear = () => {
    clearArmed = false;
    el.bulkClearBtn.textContent = "Clear";
    el.bulkClearBtn.classList.remove("btn--danger-armed");
    if (clearDisarmTimer) {
        window.clearTimeout(clearDisarmTimer);
        clearDisarmTimer = null;
    }
};

const bulkProtectSelected = (protect) => {
    const protectedSnapshots = state.settings.protectedSnapshots || {};
    getSelectedSnapshotPaths().forEach((path) => {
        if (protect) protectedSnapshots[path] = true;
        else delete protectedSnapshots[path];
    });
    state.settings.protectedSnapshots = protectedSnapshots;
    saveSettings();
    setHint(protect ? "Selected snapshots pinned." :
        "Selected snapshots unpinned.", "ok");
    rerenderTimeline();
};

const copySelectedSnapshotPaths = () => {
    const paths = getSelectedSnapshotPaths();
    if (!paths.length) {
        setHint("Select snapshots first.", "warn");
        return;
    }
    copyTextToClipboard(paths.join("\n"));
};

const bulkDeleteSelected = () => {
    const paths = getSelectedSnapshotPaths();
    if (!paths.length) {
        setHint("Select snapshots first.", "warn");
        return;
    }
    const protectedPaths = paths.filter((path) => {
        return isSnapshotProtected(path);
    });
    if (protectedPaths.length > 0) {
        setHint("Unpin protected snapshots before deleting.", "warn");
        return;
    }
    
    // Confirmation stage
    if (state.deleteConfirming) {
        // User confirmed - proceed with deletion
        state.deleteConfirming = false;
        el.bulkDelBtn.textContent = "Remove";
        el.bulkDelBtn.classList.remove("btn--danger-confirm");
        
        let deleteCount = 0;
        let chain = Promise.resolve();
        paths.forEach((path) => {
            chain = chain.then(() => {
                return callHost("dejavu_deletePath", [path]).then((result) => {
                    if (result && result.ok) {
                        const notes = state.settings.snapshotNotes || {};
                        delete notes[path];
                        state.settings.snapshotNotes = notes;
                        saveSettings();
                        deleteCount++;
                    }
                });
            });
        });
        chain.then(() => {
            setHint(`Deleted ${deleteCount} snapshot(s).`, "ok");
            clearSnapshotSelection();
            refreshVersions(true);
        }).catch((err) => {
            setHint(`Delete failed: ${(err && err.message ? err.message : "unknown")}`, "warn");
        });
    } else {
        // First click - show confirmation
        state.deleteConfirming = true;
        el.bulkDelBtn.textContent = "Confirm";
        el.bulkDelBtn.classList.add("btn--danger-confirm");
        setHint("Click Remove again to confirm deletion.", "warn");
        
        // Auto-reset after 5 seconds if not confirmed
        if (state.deleteConfirmTimer) {
            window.clearTimeout(state.deleteConfirmTimer);
        }
        state.deleteConfirmTimer = window.setTimeout(() => {
            state.deleteConfirming = false;
            if (el.bulkDelBtn) {
                el.bulkDelBtn.textContent = "Remove";
                el.bulkDelBtn.classList.remove("btn--danger-confirm");
            }
        }, 5000);
    }
};

const csvCell = (value) => {
    return `"${String(value === undefined ? "" : value)
        .replace(/"/g, '""')}"`;
};

const exportTimelineCsv = () => {
    if (!state.versions.length) {
        setHint("No timeline snapshots to export.", "warn");
        return;
    }
    const rows = [["Timestamp", "Name", "Size bytes", "Pinned", "Note", "Path"]];
    [...state.versions].sort((a, b) => {
        return (b.modified || 0) - (a.modified || 0);
    }).forEach((item) => {
        rows.push([
            new Date(item.modified).toISOString(),
            item.name,
            item.size,
            isSnapshotProtected(item.path) ? "yes" : "no",
            getSnapshotNote(item.path),
            item.path
        ]);
    });
    const csv = rows.map((row) => {
        return row.map(csvCell).join(",");
    }).join("\r\n");
    const baseName = el.docNameValue.dataset.baseName || "dejavu";
    callHost("dejavu_saveTextFile", [
        `${baseName}-dejavu-history.csv`,
        csv
    ]).then((result) => {
        if (result && result.ok) {
            setHint(`Timeline CSV exported: ${result.path}`, "ok");
        } else if (result && result.cancelled) {
            setHint("Timeline export cancelled.");
        } else {
            setHint(`Timeline export failed: ${(result && result.error ? result.error : "unknown")}`, "warn");
        }
    });
};

const getProtectedSnapshotPaths = () => {
    const protectedSnapshots = state.settings.protectedSnapshots || {};
    const paths = [];
    for (const path in protectedSnapshots) {
        if (
            protectedSnapshots.hasOwnProperty(path) &&
            protectedSnapshots[path]
        ) {
            paths.push(path);
        }
    }
    return paths;
};

const toggleSnapshotProtection = (item) => {
    const protectedSnapshots = state.settings.protectedSnapshots || {};
    const path = String(item.path || "");
    if (!path) return;
    if (protectedSnapshots[path]) {
        delete protectedSnapshots[path];
        setHint("Snapshot unpinned — retention can clean it.", "ok");
    } else {
        protectedSnapshots[path] = true;
        setHint("Snapshot pinned — retention will preserve it.", "ok");
    }
    state.settings.protectedSnapshots = protectedSnapshots;
    saveSettings();
    rerenderTimeline();
};

const toggleSnapshotProtectionForRecovery = (item) => {
    const protectedSnapshots = state.settings.protectedSnapshots || {};
    const path = String(item.path || "");
    if (!path) return;
    if (protectedSnapshots[path]) {
        delete protectedSnapshots[path];
        setHint("Snapshot unpinned — retention can clean it.", "ok");
    } else {
        protectedSnapshots[path] = true;
        setHint("Snapshot pinned — retention will preserve it.", "ok");
    }
    state.settings.protectedSnapshots = protectedSnapshots;
    saveSettings();
    renderRecoveryCenter();
};

/**
 * Refreshes the visible timeline from already-loaded snapshot data.
 */
const rerenderTimeline = () => {
    renderVersions(state.versions || []);
};

const updateTimelineInsights = () => {
    if (!el.timelineStorageSummary || !el.timelineUsageFill) return;
    const items = state.versions || [];
    let totalBytes = 0;
    let pinnedCount = 0;
    items.forEach((item) => {
        totalBytes += Number(item.size) || 0;
        if (isSnapshotProtected(item.path)) pinnedCount++;
    });
    el.timelineStorageSummary.textContent = `${items.length}${(items.length === 1 ? " file" : " files")} · ${formatBytes(totalBytes)}`;
    if (pinnedCount > 0) {
        el.timelineStorageSummary.textContent +=
            ` · ${pinnedCount} pinned`;
    }

    const keep = Number(state.settings.keepCount) || 0;
    const maxBytes = (Number(state.settings.maxFolderSizeMb) || 0) *
        1024 * 1024;
    const countRatio = keep > 0 ? items.length / keep : 0;
    const sizeRatio = maxBytes > 0 ? totalBytes / maxBytes : 0;
    const ratio = Math.max(countRatio, sizeRatio);
    const hasMeasurableLimit = keep > 0 || maxBytes > 0;
    el.timelineRetentionSummary.textContent = hasMeasurableLimit
        ? `${Math.round(ratio * 100)}% of limit`
        : "No count/size limit";
    const cleanupEstimate = estimateRetentionCleanup(items);
    if (cleanupEstimate > 0) {
        el.timelineRetentionSummary.textContent +=
            ` · ${cleanupEstimate} next`;
    }
    el.timelineUsageFill.style.width = hasMeasurableLimit
        ? `${Math.min(100, Math.round(ratio * 100))}%`
        : "0%";
    el.timelineUsageFill.classList.toggle(
        "timeline-insights__fill--warn",
        ratio >= 0.8 && ratio < 1
    );
    el.timelineUsageFill.classList.toggle(
        "timeline-insights__fill--over",
        ratio >= 1
    );
    el.timelineInsights.title = state.settings.keepDays > 0
        ? `Age cleanup is also enabled: ${state.settings.keepDays} day(s).`
        : "Retention usage uses the stricter of Keep and Max MB.";
};

/**
 * Renders the snapshot timeline: a vertical rail grouped by day,
 * newest first, where each node shows the save time, relative
 * recency, file size, and the size delta from the previous
 * (older) snapshot. The most recent snapshot is marked as the
 * current state. Actions for each node live in a row that the
 * node reveals when hovered or focused.
 * @param {Array} items Snapshots, expected newest-first.
 */
const renderVersions = (items) => {
    // Version list is transient runtime data, not a user setting —
    // keep it on state so it is never serialized to localStorage.
    state.versions = items || [];
    if (isEditingSnapshotNoteIn(el.versionList)) return;
    const existingPaths = {};
    state.versions.forEach((item) => { existingPaths[item.path] = true; });
    const timelineCtrl = getTimelineTable();
    if (timelineCtrl) timelineCtrl.pruneSelection(state.versions);
    else getSelectedSnapshotPaths().forEach((path) => {
        if (!existingPaths[path]) delete state.selectedSnapshotPaths[path];
    });
    const visibleItems = getVisibleSnapshots();
    updateTimelineInsights();
    updateTimelineBulkBar();
    state.latestSnapshot = (state.versions || []).length > 0
        ? [...(state.versions || [])].sort((a, b) => {
            return (b.modified || 0) - (a.modified || 0);
        })[0]
        : null;
    el.versionList.innerHTML = "";
    el.versionList.classList.toggle(
        "version-list--compact",
        !!state.settings.timelineCompact
    );

    if (!state.versions || state.versions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent =
            "No snapshots yet. They'll appear here as dejavu runs.";
        el.versionList.appendChild(empty);
        if (el.versionCount) el.versionCount.textContent = "0";
        return;
    }

    if (visibleItems.length === 0) {
        const noMatch = document.createElement("div");
        noMatch.className = "empty-state";
        noMatch.textContent = "No snapshots match the current filter.";
        el.versionList.appendChild(noMatch);
        if (el.versionCount) {
            el.versionCount.textContent = String(state.versions.length);
        }
        return;
    }

    if (el.versionCount) {
        el.versionCount.textContent = String(state.versions.length);
        el.versionCount.classList.remove("drawer__meta--warn");
        el.versionCount.title = state.versions.length +
            (state.versions.length === 1 ? " snapshot" : " snapshots");
    }

    const fragment = document.createDocumentFragment();
    const groups = groupSnapshotsByDay(visibleItems);

    // Map each snapshot to its actual chronological predecessor. This
    // remains correct when the timeline is filtered or sorted oldest-first
    // and lets us identify the one true initial dejavu.
    const chronologicalItems = [...(state.versions || [])].sort(
        (a, b) => {
            return (a.modified || 0) - (b.modified || 0);
        }
    );
    const olderSnapshotByPath = Object.create(null);
    const oldestSnapshotPath = chronologicalItems.length > 0
        ? chronologicalItems[0].path
        : null;
    for (let iChronological = 1;
        iChronological < chronologicalItems.length;
        iChronological++) {
        olderSnapshotByPath[chronologicalItems[iChronological].path] =
            chronologicalItems[iChronological - 1];
    }

    groups.forEach((group) => {
        const section = document.createElement("div");
        section.className = "timeline-day";

        const header = document.createElement("div");
        header.className = "timeline-day__header";
        const dayLabel = document.createElement("span");
        dayLabel.className = "timeline-day__label";
        dayLabel.textContent = group.label;
        const dayCount = document.createElement("span");
        dayCount.className = "timeline-day__count";
        dayCount.textContent = group.items.length;
        header.appendChild(dayLabel);
        header.appendChild(dayCount);
        section.appendChild(header);

        const rail = document.createElement("div");
        rail.className = "timeline-rail";

        group.items.forEach((item) => {
            const isLatest = !!(state.latestSnapshot &&
                item.path === state.latestSnapshot.path);
            const isFirst = !!(oldestSnapshotPath &&
                item.path === oldestSnapshotPath);
            const isProtected = isSnapshotProtected(item.path);
            const olderItem = olderSnapshotByPath[item.path] || null;

            const node = document.createElement("div");
            const noteText = getSnapshotNote(item.path);
            node.className = `snapshot${(isLatest ? " snapshot--latest" : "")}${(isProtected ? " snapshot--pinned" : "")}${(noteText ? " snapshot--comment" : "")}${(isSnapshotSelected(item.path) ? " snapshot--selected" : "")}`;
            node.tabIndex = 0;
            node.dataset.path = item.path;
            node.addEventListener("mouseenter", () => {
                if (state.isPainting) {
                    setSnapshotSelected(item.path, state.paintState);
                    const checkbox = node.querySelector(".snapshot__select input");
                    if (checkbox) checkbox.checked = state.paintState;
                }
                if (state.isPaintingPin) {
                    const currentlyProtected = isSnapshotProtected(item.path);
                    if (state.paintPinState !== currentlyProtected) {
                        toggleSnapshotProtection(item);
                    }
                }
            });

            const dot = document.createElement("button");
            dot.type = "button";
            dot.className = "snapshot__dot";
            dot.title = isProtected ? "Unpin snapshot" : "Pin snapshot";
            dot.setAttribute(
                "aria-label",
                isProtected ? "Unpin snapshot" : "Pin snapshot"
            );
            dot.dataset.path = item.path;
            
            // Disable pinning for missing files
            if (item.exists === false) {
                dot.disabled = true;
                dot.title = "File no longer exists - cannot pin";
            }
            
            dot.addEventListener("mousedown", (evt) => {
                if (evt.button !== 0) return;
                const currentlyProtected = isSnapshotProtected(item.path);
                state.isPaintingPin = true;
                state.paintPinState = !currentlyProtected;
                toggleSnapshotProtection(item);
                evt.preventDefault();
            });
            node.appendChild(dot);

            const body = document.createElement("div");
            body.className = "snapshot__body";

            // Top line: time, relative time, badges, size/delta and selection.
            const topLine = document.createElement("div");
            topLine.className = "snapshot__top";

            const time = document.createElement("span");
            time.className = "snapshot__time";
            time.textContent = formatTime(new Date(item.modified));
            topLine.appendChild(time);

            if (isLatest) {
                const badge = document.createElement("span");
                badge.className = "snapshot__badge snapshot__badge--after-time";
                badge.textContent = "Latest";
                topLine.appendChild(badge);
            }

            if (isFirst) {
                const firstBadge = document.createElement("span");
                firstBadge.className = "snapshot__badge snapshot__badge--after-time snapshot__badge--first";
                firstBadge.textContent = "First";
                topLine.appendChild(firstBadge);
            }

            const timeContainer = document.createElement("div");
            timeContainer.className = "snapshot__time-container";
            
            const rel = document.createElement("span");
            rel.className = "snapshot__rel snapshot__rel--after-time";
            rel.textContent = item.exists === false ? "File not found" : formatRelativeTime(item.modified);
            timeContainer.appendChild(rel);
            
            topLine.appendChild(timeContainer);

            const rightGroup = document.createElement("div");
            rightGroup.className = "snapshot__right-group";

            if (olderItem) {
                const sizeEl = document.createElement("span");
                sizeEl.className = "snapshot__size";
                sizeEl.textContent = formatBytes(item.size);
                rightGroup.appendChild(sizeEl);

                const delta = formatSizeDelta(item.size, olderItem.size);
                const deltaEl = document.createElement("span");
                deltaEl.className =
                    `snapshot__delta snapshot__delta--${delta.dir}`;
                deltaEl.textContent = delta.text;
                rightGroup.appendChild(deltaEl);
            } else {
                // First item: empty spacer where size would be, then size pill where delta would be
                const sizeSpacer = document.createElement("span");
                sizeSpacer.className = "snapshot__size";
                sizeSpacer.innerHTML = "&nbsp;";
                sizeSpacer.style.visibility = "hidden";
                rightGroup.appendChild(sizeSpacer);
                
                const initialSize = document.createElement("span");
                initialSize.className =
                    "snapshot__delta snapshot__delta--initial";
                initialSize.textContent = formatBytes(item.size);
                initialSize.title = "Initial dejavu size";
                rightGroup.appendChild(initialSize);
            }

            const selectLabel = document.createElement("label");
            selectLabel.className = "snapshot__select";
            selectLabel.title = "Select snapshot for bulk actions";
            const selectInput = document.createElement("input");
            selectInput.type = "checkbox";
            selectInput.checked = isSnapshotSelected(item.path);
            selectInput.setAttribute("aria-label", `Select ${item.name}`);
            selectInput.dataset.path = item.path;
            let handledByMousedown = false;
            selectInput.addEventListener("click", (evt) => {
                if (handledByMousedown) {
                    handledByMousedown = false;
                    evt.preventDefault();
                    evt.stopPropagation();
                    return;
                }
                setSnapshotSelected(item.path, selectInput.checked);
            });
            selectInput.addEventListener("mousedown", (evt) => {
                if (evt.button !== 0) return;
                state.isPainting = true;
                state.paintState = !selectInput.checked;
                state.paintStartPath = item.path;
                setSnapshotSelected(item.path, state.paintState);
                selectInput.checked = state.paintState;
                handledByMousedown = true;
                evt.preventDefault();
            });
            selectLabel.appendChild(selectInput);
            rightGroup.appendChild(selectLabel);

            topLine.appendChild(rightGroup);

            body.appendChild(topLine);

            // Second line: clickable filename.
            const metaLine = document.createElement("div");
            metaLine.className = "snapshot__meta";

            const nameEl = document.createElement("button");
            nameEl.type = "button";
            nameEl.className = "snapshot__name";
            nameEl.textContent = item.name;
            nameEl.title = `Open ${item.name}  ·  Shift-click to reveal in Finder`;
            
            // Check if file exists from manifest data
            if (item.exists === false) {
                node.classList.add("snapshot--missing");
                nameEl.disabled = true;
                nameEl.title = "File no longer exists";
                // Remove pin if file is missing
                if (isProtected) {
                    const _protected = state.settings.protectedSnapshots || {};
                    delete _protected[item.path];
                    state.settings.protectedSnapshots = _protected;
                    saveSettings();
                }
            }
            
            nameEl.addEventListener("click", (evt) => {
                if (!nameEl.disabled) {
                    if (evt.metaKey || evt.ctrlKey) {
                        revealPath(item.path);
                        return;
                    }
                    openSnapshotAndDejavu(item.path, "snapshot");
                }
            });
            metaLine.appendChild(nameEl);

            body.appendChild(metaLine);

            const inlineNoteText = getSnapshotNote(item.path);
            const noteEl = document.createElement("div");
            noteEl.className = `snapshot__note${(inlineNoteText ? "" : " snapshot__note--empty")}`;
            noteEl.textContent = inlineNoteText || "Note";
            noteEl.title = "Double-click to edit note";
            
            // Disable note editing for missing files
            if (item.exists === false) {
                noteEl.title = "File no longer exists - cannot edit note";
            } else {
                noteEl.tabIndex = 0;
                noteEl.setAttribute("role", "button");
                noteEl.setAttribute("aria-label", "Edit snapshot note");
                noteEl.addEventListener("dblclick", (evt) => {
                    evt.stopPropagation();
                    editSnapshotNote(item, noteEl);
                });
                noteEl.addEventListener("keydown", (evt) => {
                    if (evt.key === "Enter" || evt.key === "F2") {
                        evt.preventDefault();
                        editSnapshotNote(item, noteEl);
                    }
                });
            }
            
            body.appendChild(noteEl);
            // body.appendChild(buildSnapshotActions(item));

            node.appendChild(body);
            rail.appendChild(node);
        });

        section.appendChild(rail);
        fragment.appendChild(section);
    });

    el.versionList.appendChild(fragment);
};

const removeMissingFromManifest = (path) => {
    if (!isValidFolderValue(state.currentDejavuFolder)) {
        setHint("No dejavu folder to remove from.", "warn");
        return;
    }
    callHost("dejavu_removeManifestEntry", [
        state.currentDejavuFolder,
        path
    ]).then((result) => {
        if (result && result.ok) {
            if (result.removed) {
                setHint("Removed from list.", "ok");
                refreshVersions(true);
            } else {
                setHint("Entry not found in manifest.", "warn");
            }
        } else {
            setHint(
                `Remove failed: ${(result && result.error ? result.error : "unknown")}`,
                "warn"
            );
        }
    });
};
