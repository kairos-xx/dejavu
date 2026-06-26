/**
 * DejaVu — split from the original client/js/main.js.
 *
 * This file preserves the original statements and function bodies;
 * it only moves them into a responsibility-focused script file.
 */
"use strict";

const isValidFolderValue = (value) => {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    return CANCELLED_FOLDER_VALUES.indexOf(trimmed) === -1;
};


/**
 * Returns true when childPath is inside parentPath, or is the same path.
 * @param {string} childPath Candidate child path.
 * @param {string} parentPath Candidate parent path.
 * @return {boolean}
 */
const pathIsInside = (childPath, parentPath) => {
    if (!childPath || !parentPath) return false;
    const child = String(childPath).replace(/\\/g, "/");
    let parent = String(parentPath).replace(/\\/g, "/");
    if (child === parent) return true;
    if (parent.charAt(parent.length - 1) !== "/") parent += "/";
    return child.indexOf(parent) === 0;
};

const getPendingUnsavedFoldersBySession = () => {
    if (
        !state.settings.pendingUnsavedFoldersBySession ||
        typeof state.settings.pendingUnsavedFoldersBySession !== "object" ||
        Array.isArray(state.settings.pendingUnsavedFoldersBySession)
    ) {
        state.settings.pendingUnsavedFoldersBySession = {};
    }
    return state.settings.pendingUnsavedFoldersBySession;
};

const getPendingUnsavedRecordForInfo = (info) => {
    const sessionId = info && info.documentSessionId
        ? String(info.documentSessionId)
        : "";
    const baseName = info && (info.baseName || info.docName)
        ? String(info.baseName || info.docName)
        : "";
    const foldersBySession = getPendingUnsavedFoldersBySession();
    const record = sessionId ? foldersBySession[sessionId] : null;
    if (record && isValidFolderValue(record.folder)) {
        return {
            documentSessionId: sessionId,
            folder: record.folder,
            baseName: record.baseName || baseName
        };
    }
    if (
        sessionId &&
        state.settings.pendingUnsavedDocumentSessionId === sessionId &&
        isValidFolderValue(state.settings.pendingUnsavedDejavuFolder)
    ) {
        return {
            documentSessionId: sessionId,
            folder: state.settings.pendingUnsavedDejavuFolder,
            baseName: state.settings.pendingUnsavedBaseName || baseName
        };
    }
    return {
        documentSessionId: sessionId,
        folder: "",
        baseName
    };
};

const rememberPendingUnsavedFolderForInfo = (info, folder) => {
    const sessionId = info && info.documentSessionId
        ? String(info.documentSessionId)
        : "";
    const baseName = info && (info.baseName || info.docName)
        ? String(info.baseName || info.docName)
        : "";
    if (!isValidFolderValue(folder)) return;
    if (sessionId) {
        const foldersBySession = getPendingUnsavedFoldersBySession();
        foldersBySession[sessionId] = {
            folder,
            baseName,
            updated: Date.now()
        };
    }
    state.settings.pendingUnsavedDejavuFolder = folder;
    state.settings.pendingUnsavedBaseName = baseName;
    state.settings.pendingUnsavedDocumentSessionId = sessionId;
    saveSettings();
};

const clearPendingUnsavedFolderForInfo = (info) => {
    const sessionId = info && info.documentSessionId
        ? String(info.documentSessionId)
        : "";
    let changed = false;
    if (sessionId) {
        const foldersBySession = getPendingUnsavedFoldersBySession();
        if (foldersBySession[sessionId]) {
            delete foldersBySession[sessionId];
            changed = true;
        }
    }
    if (
        !sessionId ||
        state.settings.pendingUnsavedDocumentSessionId === sessionId
    ) {
        if (
            state.settings.pendingUnsavedDejavuFolder ||
            state.settings.pendingUnsavedBaseName ||
            state.settings.pendingUnsavedDocumentSessionId
        ) {
            state.settings.pendingUnsavedDejavuFolder = "";
            state.settings.pendingUnsavedBaseName = "";
            state.settings.pendingUnsavedDocumentSessionId = "";
            changed = true;
        }
    }
    if (changed) saveSettings();
};

const clearAllPendingUnsavedFolders = () => {
    state.settings.pendingUnsavedDejavuFolder = "";
    state.settings.pendingUnsavedBaseName = "";
    state.settings.pendingUnsavedDocumentSessionId = "";
    state.settings.pendingUnsavedFoldersBySession = {};
};

/**
 * If a document began as unsaved, its temporary dejavu folder lives
 * under the default folder. Once the user saves the document somewhere
 * else, move and rename that dejavu folder beside the final document.
 * @param {Object} info Active document info from the host.
 * @return {Promise<Object>} Resolves back to the same info object.
 */
const finalizePendingFolderIfNeeded = (info) => {
    if (!info || !info.hasDoc || !info.hasPath) return Promise.resolve(info);
    if (!state.settings.folderPerDocument) return Promise.resolve(info);
    if (state.finalizingFolder) return Promise.resolve(info);

    const pending = getPendingUnsavedRecordForInfo(info);
    const pendingFolder = pending.folder || "";
    if (!isValidFolderValue(pendingFolder)) return Promise.resolve(info);
    if (pathIsInside(info.fullPath, pendingFolder)) return Promise.resolve(info);

    state.finalizingFolder = true;
    return callHost("dejavu_finalizeDejavuFolder", [
        pendingFolder,
        info.fullPath,
        pending.baseName || info.baseName
    ]).then((result) => {
        state.finalizingFolder = false;
        if (result && result.ok) {
            clearPendingUnsavedFolderForInfo(info);
            setHint(`Dejavu folder moved: ${result.path}`, "ok");
        } else if (result && result.error) {
            setHint(`Dejavu folder move failed: ${result.error}`, "warn");
        }
        return info;
    });
};

/**
 * Applies a newly-chosen folder path to both the settings object
 * and the visible input field, persists it immediately, and
 * marks the input as holding a real value (not placeholder text)
 * so the readonly-dim styling no longer applies to it.
 * @param {string} folderPath
 */
const applyFolderSelection = (folderPath) => {
    if (!folderPath || !isValidFolderValue(folderPath)) {
        folderPath = "~/";
    }
    state.settings.folder = folderPath;
    state.settings.folderValidated = true;
    el.folderInput.value = folderPath;
    el.folderInput.classList.add("has-value");
    // A remembered per-document dejavu folder only makes sense
    // relative to the default folder it was created under. Choosing
    // a new default folder invalidates it, so clear it here rather
    // than letting a stale path (e.g. one on an unmounted volume)
    // keep being retried for unsaved documents.
    clearAllPendingUnsavedFolders();
    saveSettings();
    updateFolderStatus(folderPath);
    updateFolderTemplatePreview();
    validateFolderInput();
};

/**
 * Live-validates the typed default-folder path against the host and
 * paints the inline validity indicator (green = exists, amber =
 * doesn't exist yet, neutral = empty). Debounced by the caller.
 */
const validateFolderInput = () => {
    if (!el.folderValidity) return;
    const value = (el.folderInput ? el.folderInput.value : "") || "";
    const setState = (cls, title) => {
        el.folderValidity.className = `folder-validity ${cls}`;
        el.folderValidity.title = title;
        if (el.folderField) {
            el.folderField.className = `folder-field ${cls.replace("folder-validity--", "folder-field--")}`;
        }
    };
    if (!value.trim()) {
        if (state.folderOkHideTimer) {
            window.clearTimeout(state.folderOkHideTimer);
            state.folderOkHideTimer = null;
        }
        setState("folder-validity--empty", "No folder set");
        state.settings.folderValidated = false;
        saveSettings();
        updateFolderTemplatePreview();
        return;
    }
    const applyResult = (exists, resolved) => {
        if (exists) {
            setState("folder-validity--ok",
                `Folder exists${resolved ? ` · ${resolved}` : ""}`);
            // 3.2: the green "ok" dot is only a brief confirmation — fade it
            // out shortly after. (The "missing" indicator stays put below.)
            if (state.folderOkHideTimer) {
                window.clearTimeout(state.folderOkHideTimer);
            }
            state.folderOkHideTimer = window.setTimeout(() => {
                state.folderOkHideTimer = null;
                if (el.folderValidity &&
                    el.folderValidity.classList.contains("folder-validity--ok")) {
                    el.folderValidity.className = "folder-validity";
                }
            }, 1200);
        } else {
            // 3.2: keep the amber "missing" indicator visible indefinitely.
            if (state.folderOkHideTimer) {
                window.clearTimeout(state.folderOkHideTimer);
                state.folderOkHideTimer = null;
            }
            setState("folder-validity--missing",
                "Folder does not exist yet — it will be created on save");
        }
        state.settings.folderValidated = !!exists;
        saveSettings();
        // Only update DEJAVU FOLDER status after validation succeeds
        if (exists) {
            updateFolderStatus(value);
        }
        // Always update Folder Preview to show the validated path
        updateFolderTemplatePreview();
    };
    // Check existence directly via Node — it resolves "~/" reliably
    // (UXP host's Folder("~/").exists is flaky), so the validity
    // dot and the folder-template preview update the moment a real
    // folder is typed. Falls back to the host check if Node is absent.
    try {
        const fs = require("fs");
        const resolved = resolveTildePath(value);
        let ok = false;
        try {
            ok = fs.existsSync(resolved) &&
                fs.statSync(resolved).isDirectory();
        } catch (eStat) {
            ok = false;
        }
        applyResult(ok, resolved);
        return;
    } catch (eNode) {
        // Node unavailable — fall back to the host existence check.
    }
    setState("folder-validity--checking", "Checking…");
    callHost("dejavu_checkFolder", [value]).then((result) => {
        if (!el.folderInput || el.folderInput.value !== value) return;
        applyResult(
            !!(result && result.ok && result.exists),
            result && result.resolved
        );
    });
};

/**
 * Debounced handler for typing in the default-folder field: persists
 * the value and re-validates.
 */
const onFolderInputTyped = () => {
    const value = el.folderInput.value || "";
    el.folderInput.classList.toggle("has-value", value.trim().length > 0);
    state.settings.folder = value;
    state.settings.folderValidated = false;
    clearAllPendingUnsavedFolders();
    saveSettings();
    updateFolderTemplatePreview();
    if (state.folderValidateTimer) {
        window.clearTimeout(state.folderValidateTimer);
    }
    state.folderValidateTimer = window.setTimeout(validateFolderInput, 280);
};


/**
 * Builds a stable key for the active document. Saved documents use
 * their full path; unsaved documents fall back to the visible name.
 * @param {Object} info Active document info from UXP host.
 * @return {string}
 */
