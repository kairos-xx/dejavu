/**
 * DejaVu — split from the original client/js/main.js.
 *
 * This file preserves the original statements and function bodies;
 * it only moves them into a responsibility-focused script file.
 */
"use strict";

const SAVING_MIN_VISIBLE_MS = 1600;
const DEJAVU_RETRY_BASE_MS = 30000;
const DEJAVU_RETRY_MAX_MS = 300000;

// Circumference of the countdown ring (r = 6.5 in index.html).
const COUNTDOWN_RING_CIRCUMFERENCE = 2 * Math.PI * 6.5;

const el = {};

/**
 * Reads persisted settings from localStorage, falling back to
 * defaults for any missing keys.
 * @return {Object}
 */
const loadSettings = () => {
    return settingsStore.load();
};


/**
 * Returns a clean per-document dejavu override map.
 * @param {*} value Persisted override candidate.
 * @return {Object}
 */
const normalizeFileDejavuOverrides = (value) => {
    const out = {};
    if (!value || typeof value !== "object") return out;
    for (const key in value) {
        if (value.hasOwnProperty(key)) {
            if (value[key] === "on" || value[key] === "off") {
                out[key] = value[key];
            }
        }
    }
    return out;
};

/**
 * Returns a plain object with only boolean open/closed panel states.
 * @param {*} value Persisted panel-state candidate.
 * @return {Object}
 */
const normalizePlainObject = (value) => {
    const out = {};
    if (!value || typeof value !== "object") return out;
    for (const key in value) {
        if (value.hasOwnProperty(key)) {
            out[key] = !!value[key];
        }
    }
    return out;
};

const normalizeStringMap = (value) => {
    const out = {};
    if (!value || typeof value !== "object") return out;
    for (const key in value) {
        if (value.hasOwnProperty(key)) {
            let text = String(value[key] || "").trim();
            if (text) out[key] = text.slice(0, 160);
        }
    }
    return out;
};

/**
 * Sanitizes the persisted timeline sort value.
 * @param {*} value Candidate sort mode.
 * @return {string}
 */
const normalizeTimelineSort = (value) => {
    const allowed = ["newest", "oldest", "largest", "smallest"];
    return allowed.indexOf(value) === -1 ? "newest" : value;
};

const normalizeTimelineRange = (value) => {
    const allowed = ["all", "today", "7d", "30d"];
    return allowed.indexOf(value) === -1 ? "all" : value;
};

const saveSettings = () => {
    return settingsStore.save(state.settings);
};

const loadPersistedSnoozeUntil = () => {
    try {
        let value = Number(window.localStorage.getItem(SNOOZE_STORAGE_KEY));
        return value > Date.now() ? value : 0;
    } catch (e) {
        return 0;
    }
};

const loadPersistedSnoozeState = () => {
    const until = loadPersistedSnoozeUntil();
    if (!until) return { until: 0, startedAt: 0, totalMs: 0 };
    try {
        const raw = window.localStorage.getItem(SNOOZE_META_STORAGE_KEY);
        const meta = raw ? JSON.parse(raw) : null;
        if (
            meta &&
            Number(meta.until) === until &&
            Number(meta.startedAt) > 0 &&
            Number(meta.totalMs) > 0
        ) {
            return {
                until,
                startedAt: Number(meta.startedAt),
                totalMs: Number(meta.totalMs)
            };
        }
    } catch (e) {}
    return {
        until,
        startedAt: Date.now(),
        totalMs: Math.max(1000, until - Date.now())
    };
};

const persistSnoozeUntil = (value) => {
    try {
        if (value > Date.now()) {
            window.localStorage.setItem(SNOOZE_STORAGE_KEY, String(value));
            window.localStorage.setItem(
                SNOOZE_META_STORAGE_KEY,
                JSON.stringify({
                    until: value,
                    startedAt: state.snoozeStartedAt,
                    totalMs: state.snoozeTotalMs
                })
            );
        } else {
            window.localStorage.removeItem(SNOOZE_STORAGE_KEY);
            window.localStorage.removeItem(SNOOZE_META_STORAGE_KEY);
        }
    } catch (e) {}
};

/**
 * Shallow object clone helper (settings are flat).
 * @param {Object} obj
 * @return {Object}
 */
const clone = (obj) => {
    const out = {};
    for (const k in obj) {
        if (obj.hasOwnProperty(k)) out[k] = obj[k];
    }
    return out;
};

const pad2 = (n) => {
    return Fmt.pad2(n);
};

const buildTemplateReplacementMap = (baseName) => {
    const d = new Date();
    return {
        "$filename": baseName,
        "$hh": pad2(d.getHours()),
        "$mm": pad2(d.getMinutes()),
        "$ss": pad2(d.getSeconds()),
        "$dd": pad2(d.getDate()),
        "$MM": pad2(d.getMonth() + 1),
        "$YYYY": String(d.getFullYear()),
        "$YY": String(d.getFullYear()).slice(-2),
        "$date": String(d.getFullYear()) +
            pad2(d.getMonth() + 1) +
            pad2(d.getDate()),
        "$time": pad2(d.getHours()) +
            pad2(d.getMinutes()) +
            pad2(d.getSeconds()),
        "$counter": ""
    };
};

/**
 * Resolves the filename template against "now" for preview purposes,
 * using a placeholder base name since the real one is only known
 * inside Illustrator.
 * @param {string} template
 * @param {string} baseName
 * @return {string}
 */
const previewTemplate = (template, baseName, extension) => {
    const ext = extension || "ai";
    return `${DEJAVU.applyTokens(
        template,
        buildTemplateReplacementMap(baseName)
    )}.${ext}`;
};

/**
 * Parses a stored template string ("$filename_$hh…") into TokenField
 * values: text runs and "$" token keys, longest-match first so "$YYYY"
 * wins over its prefix "$YY".
 * @param {string} template
 * @return {Array}
 */
const parseTemplateParts = (template) => {
    return DEJAVU.tokenizeTemplate(template, TOKENS.map((t) => t.token))
        .map((part) => {
            if (part.type === "token") {
                return { token: `$${(part.path || [])[0] || ""}` };
            }
            return { text: part.value || "" };
        });
};

const suggestTemplateTokens = (query, tokens) => {
    const q = String(query || "");
    const m = q.match(/\$[a-z0-9]*$/i);
    if (!m) return [];
    const frag = m[0];
    const fl = frag.toLowerCase();
    return (tokens || [])
        .filter((t) => t.token.toLowerCase().indexOf(fl) === 0)
        .map((t) => ({
            value: t.token,
            label: t.token,
            hint: t.hint,
            token: true,
            replaceText: frag
        }));
};

/**
 * Attaches the TokenField library to the filename template editor,
 * keeping #templateInput synced as the serialized value the rest of
 * the panel reads. TokenField renders its own available-token palette.
 */
const setupFilenameTokenInput = () => {
    if (!window.TokenField || !el.templateEditor) {
        // If the library didn't load, fall back to leaving the
        // hidden input's persisted value intact so dejavu still
        // works; just render no palette.
        return;
    }
    el.templateEditor.innerHTML = "";
    state.filenameTokenInput = window.TokenField.attach(el.templateEditor, {
        tokens: TOKENS.map((t) => ({
            key: t.token,
            label: t.token,
            title: t.hint
        })),
        value: parseTemplateParts(state.settings.template),
        allowFreeText: true,
        allowCustomTokens: false,
        singleUse: true,
        showPalette: true,
        reorder: true,
        placeholder: "Filename template — type $ for tokens",
        suggest: (query) => suggestTemplateTokens(query, TOKENS),
        hideUsedSuggestions: true,
        onChange: (parts, api) => {
            el.templateInput.value = api.getText();
            onTemplateChanged();
        }
    });
    if (el.tokensList) {
        el.tokensList.innerHTML = "";
        el.tokensList.hidden = true;
    }
};

const normalizeFolderTemplate = (value) => {
    return DEJAVU.normalizeFolderTemplate(
        value,
        FOLDER_TOKENS,
        "$defaultFolder",
        "$filename"
    );
};

/** Extracts the middle path (between the two tokens) from a folder template. */
const folderTemplateMidValue = (template) => {
    return DEJAVU.folderTemplateMidValue(template);
};

const folderTemplateEditableTokens = () =>
    (typeof TOKENS !== "undefined" ? TOKENS : [])
        .filter((t) => FOLDER_TOKENS.indexOf(t.token) === -1);

const folderTemplateToParts = (template) => {
    const mid = folderTemplateMidValue(template);
    if (!mid) return [];
    return DEJAVU.tokenizeTemplate(
        mid,
        folderTemplateEditableTokens().map((t) => t.token)
    ).map((part) => {
        if (part.type === "token") {
            return { token: `$${(part.path || [])[0] || ""}` };
        }
        return { text: part.value || "" };
    });
};

/**
 * Autocomplete for the folder-template middle: suggests the date/time template
 * tokens ($dd, $mm, $YYYY, …) when the user is typing a "$…" fragment, so the
 * sub-path can be made date-based. Each item completes the typed text (the
 * token stays inline text; resolveFolderTemplate expands it at save time).
 */
const suggestFolderTemplateTokens = (query) => {
    const reserved = (typeof FOLDER_TOKENS !== "undefined") ? FOLDER_TOKENS : [];
    return suggestTemplateTokens(
        query,
        (typeof TOKENS !== "undefined" ? TOKENS : [])
            .filter((t) => reserved.indexOf(t.token) === -1)
    );
};

/**
 * Wires the folder template to TokenField. The required tokens are pinned
 * structurally at the start/end, so the editable flow is only the middle path.
 */
const setupFolderTemplateInput = () => {
    if (!window.TokenField || !el.folderTemplateInput) return;
    el.folderTemplateInput.innerHTML = "";
    state.folderTemplateTokenInput = window.TokenField.attach(
        el.folderTemplateInput,
        {
            tokens: [
                {
                    key: "$defaultFolder",
                    label: "$defaultFolder",
                    title: "Default dejavu folder",
                    pin: "start"
                },
                ...folderTemplateEditableTokens().map((t) => ({
                    key: t.token,
                    label: t.token,
                    title: t.hint
                })),
                {
                    key: "$filename",
                    label: "$filename",
                    title: "Document filename without extension",
                    pin: "end"
                }
            ],
            value: folderTemplateToParts(state.settings.folderTemplate),
            allowFreeText: true,
            allowCustomTokens: false,
            singleUse: true,
            showPalette: true,
            reorder: false,
            separator: "/",
            placeholder: "Folder segment",
            suggest: suggestFolderTemplateTokens,
            hideUsedSuggestions: true,
            onChange: () => commitFolderTemplate()
        }
    );
    refreshDefaultFolderTokenLabel();
};

/** Rebuilds the full folder template from the TokenField middle flow. */
const serializeFolderTemplate = () => {
    if (state.folderTemplateTokenInput) {
        return normalizeFolderTemplate(state.folderTemplateTokenInput.getText());
    }
    return normalizeFolderTemplate(state.settings.folderTemplate);
};

/** Persists the current folder template and refreshes dependent UI. */
const commitFolderTemplate = () => {
    if (!el.folderTemplateInput) return;
    const value = serializeFolderTemplate();
    // el.folderTemplateInput is the TokenField mount <div> (no .value); the
    // serialized template lives in settings instead.
    state.settings.folderTemplate = value;
    saveSettings();
    updateFolderTemplatePreview();
};

/**
 * Reflects a stored folder template into TokenField: the pinned tokens stay
 * locked while the middle text is replaced.
 */
const renderFolderTemplateEditor = (value) => {
    if (state.folderTemplateTokenInput) {
        state.folderTemplateTokenInput.setValue(folderTemplateToParts(value));
    }
    refreshDefaultFolderTokenLabel();
};

const bindFolderTemplateEditor = () => {};

/** Places the caret between the two required tokens ($defaultFolder and $filename). */
/**
 * Updates the live preview line under the template field.
 */
const updatePreview = () => {
    // The filename-template preview UI was removed in the settings refactor;
    // only refresh it when those elements are still present.
    if (el.templatePreview && el.templateInput) {
        const baseName = el.docNameValue.dataset.baseName || "Untitled-1";
        const extension = el.docNameValue.dataset.dejavuFormat || "ai";
        el.templatePreview.textContent = previewTemplate(
            el.templateInput.value,
            baseName,
            extension
        );
        // Collision check: without overwrite, a template that has no
        // second-resolution or counter token can produce the same name
        // on consecutive saves, so flag it amber with a how-to-fix tip.
        const risky = !state.settings.overwriteExisting &&
            !/\$ss|\$time|\$counter/.test(el.templateInput.value || "");
        el.templatePreview.classList.toggle("preview__value--warn", risky);
        el.templatePreview.title = risky
            ? `These names can repeat on quick saves. Add $ss, $time or $counter, or enable overwrite, to keep them unique.`
            : "";
    }
    updateFolderTemplatePreview();
};

/** Expands a leading "~" to the absolute home path (matches host). */
const resolveTildePath = (p) => {
    const s = String(p || "");
    if (s.charAt(0) === "~") {
        try {
            return require("os").homedir() + s.slice(1);
        } catch (e) {
            return s;
        }
    }
    return s;
};

/** Returns the on-state of an icon toggle button. */
const toggleIconIsOn = (btn) => {
    return !!btn && btn.getAttribute("aria-pressed") === "true";
};

/** Returns the mixed/indeterminate state of an icon toggle button. */
const toggleIconIsMixed = (btn) => {
    return !!btn && btn.classList.contains("is-mixed");
};

/** Sets the on-state (aria-pressed + .is-on) of an icon toggle button. */
const setToggleIcon = (btn, on) => {
    if (!btn) return;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("is-on", !!on);
    btn.classList.remove("is-mixed");
};

/** Sets the mixed/indeterminate state for tristate toggles (N16, N17, N19). */
const setToggleIconMixed = (btn, mixed) => {
    if (!btn) return;
    btn.setAttribute("aria-pressed", "mixed");
    btn.classList.remove("is-on");
    btn.classList.toggle("is-mixed", !!mixed);
};

/**
 * Returns the folder of the active saved document, or null when the active
 * document is unsaved / there is none.
 */
const activeDocumentFolder = () => {
    const info = state.activeInfo || {};
    if (!info.hasPath || !info.fullPath) return null;
    const np = String(info.fullPath).replace(/\\/g, "/");
    const slash = np.lastIndexOf("/");
    return slash > 0 ? np.slice(0, slash) : np;
};

/**
 * Resolves the root folder that $defaultFolder maps to for the DEJAVU
 * FOLDER status, or null when there is no trusted value yet (so the caller
 * keeps the previously shown value rather than flickering to a placeholder).
 *   - Saved document → its own folder.
 *   - Otherwise → the chosen DEFAULT folder, once validated on disk.
 *
 * It must resolve to the *default* folder, not state.currentDejavuFolder:
 * the latter is the host's already-resolved per-document dejavu folder
 * (e.g. ".../Untitled-6"), and feeding it back through the "$defaultFolder/
 * $filename" template doubled the leaf (".../Untitled-6/Untitled-6").
 */
const resolveDejavuRootFolder = () => {
    const docFolder = activeDocumentFolder();
    if (docFolder) return docFolder;
    if (state.settings.folderValidated &&
        isValidFolderValue(state.settings.folder)) {
        return resolveTildePath(state.settings.folder);
    }
    return null;
};

/**
 * Builds the full resolved dejavu path (root folder + filename via the
 * folder template) shown in the DEJAVU FOLDER status row.
 * @param {string} rootFolder Absolute folder that $defaultFolder maps to.
 */
const buildResolvedDejavuPath = (rootFolder) => {
    const baseName = (el.docNameValue && el.docNameValue.dataset.baseName) ||
        "Untitled-1";
    const template = state.settings.folderTemplate ||
        "$defaultFolder/$filename";
    const tokens = buildTemplateReplacementMap(baseName);
    tokens.$defaultFolder = rootFolder;
    return DEJAVU.resolveFolderTemplate(template, tokens);
};

/**
 * Keeps the fixed $defaultFolder pill label resolved to a real path while
 * leaving the pill's data-token intact so the serialized template is
 * unchanged:
 *   - Saved document → the document's own folder (dejavus beside it) (3.4).
 *   - Unsaved document → the chosen default folder, shown expanded
 *     ("~/" → "/Users/joaolopes"). This only updates once the typed folder
 *     has validated on disk, so it holds the last valid value rather than
 *     tracking keystrokes (mirrors the DEJAVU FOLDER status row).
 */
const refreshDefaultFolderTokenLabel = () => {
    const editor = el.folderTemplateInput;
    if (!editor) return;
    const docFolder = activeDocumentFolder();
    let display;
    let title;
    if (docFolder) {
        display = docFolder;
        title = `Document folder: ${docFolder}`;
    } else if (state.settings.folderValidated) {
        const raw = (el.folderInput && el.folderInput.value.trim()) ||
            state.settings.folder || "~/";
        display = resolveTildePath(raw);
        title = `Default folder: ${display}`;
        state.lastValidFolderLabel = display;
    } else if (state.lastValidFolderLabel) {
        // Typed folder not validated yet — keep the last valid value.
        display = state.lastValidFolderLabel;
        title = `Default folder: ${display}`;
    } else {
        // No valid folder seen yet (e.g. first paint): best-effort expand
        // the current value so the pill never shows the raw token.
        const raw = (el.folderInput && el.folderInput.value.trim()) ||
            state.settings.folder || "~/";
        display = resolveTildePath(raw);
        title = `Default folder: ${display}`;
    }
    // Drop any trailing "/" — TokenField inserts separators while serializing,
    // so the visible label should not double them.
    display = display.replace(/\/+$/, "") || "/";
    const pill = editor.querySelector(
        ".tf__chip[data-key=\"$defaultFolder\"]"
    );
    if (!pill) return;
    const label = pill.querySelector(".tf__chip-label");
    if (label && label.textContent !== display) {
        label.textContent = display;
    }
    pill.title = title;
};

/**
 * Refreshes the DEJAVU FOLDER status row (and the $defaultFolder pill).
 * Replaces the old separate folder-preview element — the status row is now
 * the single resolved-path display (3.1a/3.1b).
 */
const updateFolderTemplatePreview = () => {
    refreshDefaultFolderTokenLabel();
    updateFolderStatus();
};

const onTemplateChanged = () => {
    state.settings.template = el.templateInput.value;
    saveSettings();
    updatePreview();
    syncTemplatePresets();
};

/**
 * Applies a full filename-template string to the editor (used by the
 * template preset chips). The library's onChange then syncs the
 * hidden input, settings, preview, palette and preset highlight.
 * @param {string} template
 */
const applyTemplateString = (template) => {
    if (state.filenameTokenInput) {
        state.filenameTokenInput.setValue(parseTemplateParts(template));
        el.templateInput.value = state.filenameTokenInput.getText();
        onTemplateChanged();
    } else {
        el.templateInput.value = template;
        onTemplateChanged();
    }
};

/**
 * Highlights the template preset chip that exactly matches the
 * current template, if any.
 */
const syncTemplatePresets = () => {
    if (!el.templatePresets) return;
    const current = el.templateInput.value || "";
    const chips = el.templatePresets.querySelectorAll("[data-template]");
    Array.prototype.forEach.call(chips, (chip) => {
        chip.classList.toggle(
            "preset-chip--active",
            chip.getAttribute("data-template") === current
        );
    });
};

/**
 * Converts the interval inputs into milliseconds.
 * @return {number}
 */
const getIntervalMs = () => {
    const unit = el.intervalUnit
        ? el.intervalUnit.value
        : state.settings.intervalUnit || 60;
    return DEJAVU.intervalToMs(el.intervalInput.value, unit);
};

/**
 * Converts the visible interval value between seconds/minutes/hours
 * while preserving the same approximate duration.
 * @param {number} oldUnit Previous unit in seconds.
 * @param {number} newUnit New unit in seconds.
 */
const convertIntervalUnit = (oldUnit, newUnit) => {
    const currentValue = Math.max(
        1,
        parseInt(el.intervalInput.value, 10) || 1
    );
    const totalSeconds = currentValue * oldUnit;
    const convertedValue = Math.max(1, Math.round(totalSeconds / newUnit));
    el.intervalInput.value = convertedValue;
    state.settings.intervalValue = convertedValue;
    state.settings.intervalUnit = newUnit;
    syncIntervalPresets();
    syncSafetyProfiles();
};

/**
 * Applies an interval duration in seconds using the most readable
 * unit for that value. Presets intentionally prefer exact units so
 * the field stays clean (60s → 1m, 3600s → 1h).
 * @param {number} totalSeconds Duration in seconds.
 */
const applyIntervalSeconds = (totalSeconds) => {
    const seconds = Math.max(1, parseInt(totalSeconds, 10) || 1);
    let unit = 1;
    if (seconds % 3600 === 0) {
        unit = 3600;
    } else if (seconds % 60 === 0) {
        unit = 60;
    }
    if (el.intervalUnit) {
        el.intervalUnit.value = String(unit);
    }
    el.intervalInput.value = Math.max(1, Math.round(seconds / unit));
    state.settings.intervalUnit = unit;
    state.settings.intervalValue = parseInt(el.intervalInput.value, 10);
    saveSettings();
    syncIntervalPresets();
    syncSafetyProfiles();
    if (isDejavuEnabledForCurrent()) startLoop();
};

/**
 * Highlights the active interval preset when the current value
 * exactly matches one of the chips.
 */
const syncIntervalPresets = () => {
    if (!el.intervalPresets) return;
    const unit = el.intervalUnit
        ? parseInt(el.intervalUnit.value, 10) || 60
        : Number(state.settings.intervalUnit) || 60;
    const seconds = (parseInt(el.intervalInput.value, 10) || 1) *
        unit;
    const chips = el.intervalPresets.querySelectorAll("[data-seconds]");
    Array.prototype.forEach.call(chips, (chip) => {
        chip.classList.toggle(
            "preset-chip--active",
            parseInt(chip.getAttribute("data-seconds"), 10) === seconds
        );
    });
};

const applySafetyProfile = (profile) => {
    if (profile === "maximum") {
        applyIntervalSeconds(30);
        state.settings.keepCount = 100;
        state.settings.overwriteExisting = false;
        state.settings.onlySaveWhenChanged = true;
        setHint("Maximum safety · 30s · 100 versions.", "ok");
    } else if (profile === "light") {
        applyIntervalSeconds(300);
        state.settings.keepCount = 10;
        state.settings.overwriteExisting = true;
        state.settings.onlySaveWhenChanged = true;
        setHint("Light profile · 5m · 10 versions.", "ok");
    } else {
        applyIntervalSeconds(120);
        state.settings.keepCount = 20;
        state.settings.overwriteExisting = true;
        state.settings.onlySaveWhenChanged = true;
        setHint("Balanced profile · 2m · 20 versions.", "ok");
    }
    el.keepCountInput.value = state.settings.keepCount;
    el.overwriteToggle.checked = state.settings.overwriteExisting;
    el.onlyIfChangedToggle.checked = true;
    saveSettings();
    syncSafetyProfiles();
    updatePreview();
    updateTimelineInsights();
};

const syncSafetyProfiles = () => {
    if (!el.safetyProfiles) return;
    const seconds = (Number(state.settings.intervalValue) || 1) *
        (Number(state.settings.intervalUnit) || 60);
    let profile = "";
    if (seconds === 30 && Number(state.settings.keepCount) === 100 &&
        state.settings.overwriteExisting === false) profile = "maximum";
    if (seconds === 120 && Number(state.settings.keepCount) === 20 &&
        state.settings.overwriteExisting !== false) profile = "balanced";
    if (seconds === 300 && Number(state.settings.keepCount) === 10 &&
        state.settings.overwriteExisting !== false) profile = "light";
    const chips = el.safetyProfiles.querySelectorAll("[data-profile]");
    Array.prototype.forEach.call(chips, (chip) => {
        chip.classList.toggle(
            "preset-chip--active",
            chip.getAttribute("data-profile") === profile
        );
    });
};

/**
 * Returns true if a folder-path string is a real, usable path —
 * false for cancelled-dialog sentinels or empty/missing values.
 * @param {string} value
 * @return {boolean}
 */
