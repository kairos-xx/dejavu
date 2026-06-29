/**
 * DejaVu — split from the original client/js/main.js.
 *
 * This file preserves the original statements and function bodies;
 * it only moves them into a responsibility-focused script file.
 */
"use strict";

const getDocumentKey = (info) => {
    if (!info || !info.hasDoc) return "";
    if (info.hasPath && info.fullPath) {
        return `file:${String(info.fullPath)}`;
    }
    return `unsaved:${String(
        info.documentSessionId || info.docName || info.baseName || ""
    )}`;
};

/**
 * Stores the active document identity and resets per-document
 * runtime caches when the user switches Illustrator documents.
 * @param {Object} info Active document info from UXP host.
 */
const updateCurrentDocument = (info) => {
    const nextKey = getDocumentKey(info);
    const changed = state.currentDocKey !== nextKey;
    state.currentDocKey = nextKey;
    state.hasActiveDoc = !!(info && info.hasDoc);
    state.activeInfo = info || null;
    if (changed) {
        state.lastFingerprint = null;
        state.lastSavedAt = null;
        state.versions = [];
        state.selectedSnapshotPaths = {};
        state.latestSnapshot = null;
        state.currentDejavuFolder = "";
        if (el.lastSavedValue) el.lastSavedValue.textContent = "never";
        if (el.versionList) renderVersions([]);
    }
    return changed;
};

/**
 * Schedules a single dejavu check after a document switch. The delay
 * lets Illustrator finish making the new active document current before
 * the host-side script queries paths and document metadata.
 */
const scheduleDocumentSwitchDejavu = () => {
    if (!state.settings.saveOnDocumentSwitch) return;
    if (!isDejavuEnabledForCurrent()) return;
    if (state.documentSwitchSaveId !== null) {
        window.clearTimeout(state.documentSwitchSaveId);
    }
    state.documentSwitchSaveId = window.setTimeout(() => {
        state.documentSwitchSaveId = null;
        runDejavuCycle(false).catch((err) => {
            setHint(
                `Document-switch dejavu failed: ${(err && err.message ? err.message : err)}`,
                "warn"
            );
        });
    }, 650);
};

/**
 * Returns true when any document has a per-file override. Once a
 * file-specific rule exists, documents without their own override
 * show as "current" state in the header, while still inheriting the
 * global baseline behind the scenes.
 * @return {boolean}
 */
const hasFileDejavuOverrides = () => {
    const overrides = state.settings.fileDejavuOverrides || {};
    for (const key in overrides) {
        if (overrides.hasOwnProperty(key)) return true;
    }
    return false;
};

/**
 * Reads the override for the current document.
 * @return {string} "on", "off", or "".
 */
const getCurrentFileOverride = () => {
    if (!state.currentDocKey) return "";
    const overrides = state.settings.fileDejavuOverrides || {};
    return overrides[state.currentDocKey] || "";
};

/**
 * Returns the four-state mode that should be shown in the header.
 * @return {string}
 */
const getDejavuDisplayMode = () => {
    const override = getCurrentFileOverride();
    if (override === "on") return DEJAVU_MODE_ON_CURRENT;
    if (override === "off") return DEJAVU_MODE_OFF_CURRENT;
    if (hasFileDejavuOverrides()) {
        return state.settings.enabledForAll
            ? DEJAVU_MODE_ON_CURRENT
            : DEJAVU_MODE_OFF_CURRENT;
    }
    return state.settings.enabledForAll
        ? DEJAVU_MODE_ON_ALL
        : DEJAVU_MODE_OFF_ALL;
};

/**
 * Returns true when dejavu should run for the active document.
 * @return {boolean}
 */
const isDejavuEnabledForCurrent = () => {
    if (!state.hasActiveDoc || !state.currentDocKey) return false;
    const override = getCurrentFileOverride();
    if (override === "on") return true;
    if (override === "off") return false;
    return !!state.settings.enabledForAll;
};

/**
 * Label used by the header control and the Mode status row.
 * @param {string} mode Four-state dejavu mode.
 * @return {string}
 */
const getDejavuModeLabel = (mode) => {
    if (mode === DEJAVU_MODE_ON_ALL) return "On all";
    if (mode === DEJAVU_MODE_ON_CURRENT) return "On current";
    if (mode === DEJAVU_MODE_OFF_CURRENT) return "Off current";
    return "Off all";
};

// ---- Multi-document overview -------------------------------------

/** Document key for a doc from the open-documents list. */
const getNextDejavuMode = (mode) => {
    if (mode === DEJAVU_MODE_OFF_ALL) return DEJAVU_MODE_ON_CURRENT;
    if (mode === DEJAVU_MODE_ON_CURRENT) return DEJAVU_MODE_ON_ALL;
    if (mode === DEJAVU_MODE_ON_ALL) return DEJAVU_MODE_OFF_CURRENT;
    return DEJAVU_MODE_OFF_ALL;
};

/**
 * Applies one of the four dejavu modes to settings.
 * @param {string} mode Requested dejavu mode.
 */
const applyDejavuMode = (mode) => {
    const overrides = state.settings.fileDejavuOverrides || {};
    if (mode === DEJAVU_MODE_ON_ALL) {
        state.settings.enabledForAll = true;
        state.settings.fileDejavuOverrides = {};
    } else if (mode === DEJAVU_MODE_OFF_ALL) {
        state.settings.enabledForAll = false;
        state.settings.fileDejavuOverrides = {};
    } else if (state.currentDocKey) {
        if (mode === DEJAVU_MODE_ON_CURRENT) {
            overrides[state.currentDocKey] = "on";
        } else if (mode === DEJAVU_MODE_OFF_CURRENT) {
            overrides[state.currentDocKey] = "off";
        }
        state.settings.fileDejavuOverrides = overrides;
    } else {
        state.settings.enabledForAll = mode === DEJAVU_MODE_ON_CURRENT;
        state.settings.fileDejavuOverrides = {};
    }
    state.settings.enabled = isDejavuEnabledForCurrent();
    saveSettings();
    syncDejavuModeUi();
    syncDejavuLoop();
};

/**
 * Paints the four-state mode switch.
 */
const syncDejavuModeUi = () => {
    if (!el.modeSeg) return;
    const mode = getDejavuDisplayMode();
    const label = getDejavuModeLabel(mode);
    const hasDoc = !!state.hasActiveDoc;

    el.modeSegButtons.forEach((btn) => {
        const btnMode = btn.dataset.mode;
        const isActive = btnMode === mode;
        const isOn =
            btnMode === DEJAVU_MODE_ON_ALL ||
            btnMode === DEJAVU_MODE_ON_CURRENT;
        // A per-document ("current") rule needs an open document to
        // attach to, so disable those two segments when none is open.
        const needsDoc =
            btnMode === DEJAVU_MODE_ON_CURRENT ||
            btnMode === DEJAVU_MODE_OFF_CURRENT;
        btn.classList.toggle("mode-seg__btn--active", isActive);
        btn.classList.toggle("mode-seg__btn--on", isActive && isOn);
        btn.disabled = needsDoc && !hasDoc;
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
        btn.title = needsDoc && !hasDoc
            ? "Open a document to set a per-document rule"
            : `Set dejavu: ${getDejavuModeLabel(btnMode)}`;
    });

    state.settings.enabled = isDejavuEnabledForCurrent();
    updateModeIndicator();
};

/**
 * Starts or stops the dejavu interval for the active document.
 */
const syncDejavuLoop = () => {
    const enabled = isDejavuEnabledForCurrent();
    if (enabled) {
        if (state.timerId === null) startLoop();
        setStatusDot(!isSnoozed());
    } else {
        stopLoop();
        setStatusDot(false);
    }
    // The pause bar is only meaningful while dejavu is running (or
    // already paused), so hide it otherwise to keep the panel tidy.
    if (el.snoozeBar) {
        el.snoozeBar.style.display =
            (enabled || isSnoozed()) ? "" : "none";
    }
};

/**
 * True while dejavu is temporarily paused (snoozed). The deadline is
 * persisted so closing/reopening or live-reloading the panel cannot
 * silently cancel a pause the user intentionally set.
 * @return {boolean}
 */
const isSnoozed = () => {
    return !!(state.snoozeUntil && Date.now() < state.snoozeUntil);
};

/**
 * Pauses dejavu for the given number of seconds. The polling loop
 * keeps running but skips actual saves until the snooze elapses.
 * @param {number} seconds
 */
const snoozeFor = (seconds) => {
    state.snoozeStartedAt = Date.now();
    state.snoozeTotalMs = Math.max(1, seconds) * 1000;
    state.snoozeUntil = state.snoozeStartedAt + state.snoozeTotalMs;
    persistSnoozeUntil(state.snoozeUntil);
    clearDejavuRetry();
    if (state.snoozeTickId === null) {
        state.snoozeTickId = window.setInterval(tickSnooze, 1000);
    }
    updateSnoozeUi();
    setStatusDot(false);
    setHint("Dejavu paused.", "warn");
};

const snoozeUntilTomorrow = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const seconds = Math.max(60, Math.round(
        (tomorrow.getTime() - Date.now()) / 1000
    ));
    snoozeFor(seconds);
    setHint("Dejavu paused until tomorrow at 09:00.", "warn");
};

/** Ends a snooze early and resumes normal dejavu behaviour. */
const resumeFromSnooze = () => {
    state.snoozeUntil = 0;
    state.snoozeStartedAt = 0;
    state.snoozeTotalMs = 0;
    persistSnoozeUntil(0);
    if (state.snoozeTickId !== null) {
        window.clearInterval(state.snoozeTickId);
        state.snoozeTickId = null;
    }
    updateSnoozeUi();
    syncDejavuLoop();
    setHint("Dejavu resumed.", "ok");
};

/** Per-second snooze tick: refresh the countdown, auto-resume at end. */
const tickSnooze = () => {
    if (!isSnoozed()) {
        resumeFromSnooze();
        return;
    }
    updateSnoozeUi();
};

/**
 * Reflects snooze state in the pause bar: countdown + Resume while
 * paused, the duration chips otherwise.
 */
const updateSnoozeUi = () => {
    if (!el.snoozeBar) return;
    const snoozed = isSnoozed();
    if (snoozed && state.snoozeTotalMs <= 0) {
        state.snoozeStartedAt = Date.now();
        state.snoozeTotalMs = Math.max(
            1000,
            state.snoozeUntil - state.snoozeStartedAt
        );
    }
    el.snoozeBar.classList.toggle("snooze-bar--active", snoozed);
    if (el.countdownPie) {
        el.countdownPie.classList.toggle("is-snoozed", snoozed);
    }
    if (el.nextCheckValue) {
        el.nextCheckValue.classList.toggle("is-snoozed", snoozed);
    }
    if (el.nextCheckLabel) {
        el.nextCheckLabel.textContent = snoozed ? "Paused" : "Next check";
        el.nextCheckLabel.classList.toggle("status__label--paused", snoozed);
    }
    if (el.snoozeChips) el.snoozeChips.hidden = snoozed;
    if (el.snoozeResumeBtn) el.snoozeResumeBtn.hidden = !snoozed;
    if (el.snoozeLabel) {
        el.snoozeLabel.textContent = "Pause";
    }
    updateCountdown();
    updateCountdownPie();
};

/**
 * Calls into UXP host, parsing the JSON string result. Waits for
 * the explicit UXP host load (ensureHostLoaded) first, so this
 * never races a not-yet-loaded JSX file.
 * @param {string} fnName
 * @param {Array} args
 * @return {Promise<Object>}
 */
