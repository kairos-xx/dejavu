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
 * Returns a plain object with only boolean open/closed drawer states.
 * @param {*} value Persisted drawer-state candidate.
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
    return settingsStore.save();
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

/**
 * Resolves the filename template against "now" for preview purposes,
 * using a placeholder base name since the real one is only known
 * inside Illustrator.
 * @param {string} template
 * @param {string} baseName
 * @return {string}
 */
const previewTemplate = (template, baseName, extension) => {
    const d = new Date();
    const tokens = {
        "$filename": baseName,
        "$hh": pad2(d.getHours()),
        "$mm": pad2(d.getMinutes()),
        "$ss": pad2(d.getSeconds()),
        "$dd": pad2(d.getDate()),
        "$MM": pad2(d.getMonth() + 1),
        "$YYYY": String(d.getFullYear()),
        "$YY": String(d.getFullYear()).slice(-2),
        "$date": String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()),
        "$time": pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()),
        "$counter": ""
    };
    const ext = extension || "ai";
    return `${DEJAVU.applyTokens(template, tokens)}.${ext}`;
};

/**
 * Filename-template token system for the TokenInput library: a
 * single "$" trigger with the flat, single-use filename tokens.
 * @return {Array} systems config for TokenInput.attach.
 */
const buildFilenameSystems = () => {
    return [{
        trigger: "$",
        id: "filename",
        name: "token",
        icon: "",
        items: TOKENS.map((t) => {
            return {
                key: t.token.slice(1),   // "$filename" -> "filename"
                label: t.token,          // chip + row show "$filename"
                description: t.hint,
                singleUse: true
            };
        })
    }];
};

/**
 * Parses a stored template string ("$filename_$hh…") into TokenInput
 * parts (text runs + "$" tokens), longest-match first so "$YYYY"
 * wins over its prefix "$YY".
 * @param {string} template
 * @return {Array}
 */
const templateToParts = (template) => {
    return DEJAVU.tokenizeTemplate(template, TOKENS.map((t) => t.token));
};

/**
 * Attaches the TokenInput library to the filename template editor,
 * keeping #templateInput synced as the serialized value the rest of
 * the panel reads, then builds the clickable token palette.
 */
const setupFilenameTokenInput = () => {
    if (!window.TokenInput || !el.templateEditor) {
        // If the library didn't load, fall back to leaving the
        // hidden input's persisted value intact so dejavu still
        // works; just render no palette.
        return;
    }
    state.filenameTokenInput = window.TokenInput.attach(el.templateEditor, {
        placeholder: "Filename template — type $ for tokens",
        autoTokenizeExactOnSpace: false,
        hideUsedSingleTokens: true,
        systems: buildFilenameSystems(),
        // Populate during construction so the first onChange already
        // carries the real template (no transient empty save).
        initialParts: templateToParts(state.settings.template),
        dropdown: { maxItems: 12, emptyHtml: "No matching token." },
        onChange: (parts, api) => {
            el.templateInput.value = api.getText();
            onTemplateChanged();
        }
    });
    renderFilenamePalette();
};

/**
 * Builds the clickable token palette under the editor. Clicking a
 * chip inserts that token at the caret through the library.
 */
const renderFilenamePalette = () => {
    if (!el.tokensList) return;
    el.tokensList.innerHTML = "";
    state.tokenChips = [];
    TOKENS.forEach((t) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "token";
        chip.title = t.hint;
        chip.textContent = t.token;
        chip.addEventListener("click", () => {
            if (chip.disabled || !state.filenameTokenInput) return;
            state.filenameTokenInput.insertItemAtCaret(
                "$",
                [t.token.slice(1)]
            );
        });
        state.tokenChips.push({ token: t.token, el: chip });
        el.tokensList.appendChild(chip);
    });
    syncTokenChips();
};

/**
 * Disables each token chip whose token already appears in the
 * template (so every token can be used at most once), and
 * re-enables chips whose token is no longer present. Driven from
 * the current field text, so it stays correct whether the token
 * was added via a chip or typed/removed by hand.
 */
const syncTokenChips = () => {
    if (!state.tokenChips) return;
    let value = el.templateInput.value || "";
    state.tokenChips.forEach((chip) => {
        // A token like "$YY" is a prefix of "$YYYY", so match the
        // token only when not immediately followed by an
        // alphanumeric character (its own longer sibling).
        const present = tokenIsInTemplate(value, chip.token);
        chip.el.disabled = present;
        chip.el.classList.toggle("token--used", present);
    });
};

/**
 * True if token occurs in template as a whole token (not as a
 * prefix of a longer token such as $YY inside $YYYY).
 * @param {string} template
 * @param {string} token
 * @return {boolean}
 */
const tokenIsInTemplate = (template, token) => {
    return DEJAVU.tokenIsInTemplate(template, token);
};

const renderFolderTokenPalette = () => {
    // No palette needed - both tokens are locked and always present
};

// Builds a non-editable, locked token pill (e.g. $defaultFolder / $filename)
// for the folder template editor. The visible label can be swapped for a
// friendly value (see refreshDefaultFolderTokenLabel) while data-token keeps
// the canonical token for serialization.
const createInlineTemplateToken = (token) => {
    const pill = document.createElement("span");
    pill.className = "template-token template-token--locked";
    pill.contentEditable = "false";
    pill.dataset.token = token;
    pill.dataset.locked = "true";
    pill.title = "Required token";

    const label = document.createElement("span");
    label.className = "template-token__label";
    label.textContent = token;
    pill.appendChild(label);

    return pill;
};

const normalizeFolderTemplate = (value) => {
    return DEJAVU.normalizeFolderTemplate(
        value,
        FOLDER_TOKENS,
        "$defaultFolder",
        "$filename"
    );
};

/* ----------------------------------------------------------------------
 * Folder template editor — dedicated editable middle segment.
 *
 * The folder template is always "$defaultFolder" + an optional middle path
 * + "$filename". Rather than make the whole container contenteditable (which
 * let the caret land before the fixed $defaultFolder token), only a single
 * middle element is editable; the two tokens and the slashes around them are
 * static, non-editable nodes. Editing is therefore only possible between the
 * two required tokens.
 * -------------------------------------------------------------------- */

/** The editable middle element inside the folder template editor, or null. */
const folderTemplateMidEl = () => {
    return (el.folderTemplateEditor &&
        el.folderTemplateEditor.querySelector(".folder-tpl-mid")) || null;
};

/** Extracts the middle path (between the two tokens) from a folder template. */
const folderTemplateMidValue = (template) => {
    return DEJAVU.folderTemplateMidValue(template);
};

/** Rebuilds the full folder template from the editable middle element. */
const serializeFolderTemplate = () => {
    const midEl = folderTemplateMidEl();
    const mid = midEl ? (midEl.textContent || "") : "";
    return normalizeFolderTemplate(`$defaultFolder/${mid}/$filename`);
};

/** Hides the trailing "/" separator when the middle path is empty. */
const syncFolderTrailingSep = () => {
    const editor = el.folderTemplateEditor;
    if (!editor) return;
    const midEl = folderTemplateMidEl();
    const sepR = editor.querySelector(".folder-tpl-sep--trailing");
    if (!midEl || !sepR) return;
    const hasMid = !!(midEl.textContent || "").replace(/\//g, "").trim();
    sepR.classList.toggle("is-hidden", !hasMid);
};

/** Persists the current folder template and refreshes dependent UI. */
const commitFolderTemplate = () => {
    if (!el.folderTemplateInput) return;
    const value = serializeFolderTemplate();
    el.folderTemplateInput.value = value;
    state.settings.folderTemplate = value;
    saveSettings();
    updateFolderTemplatePreview();
    syncFolderTrailingSep();
};

/** Wires input/blur/keydown/paste on the editable middle element. */
const bindFolderTemplateMid = (midEl) => {
    midEl.addEventListener("input", () => {
        commitFolderTemplate();
    });
    midEl.addEventListener("blur", () => {
        // Normalize (collapse/trim slashes) and reflect the clean value back.
        const clean = folderTemplateMidValue(serializeFolderTemplate());
        if ((midEl.textContent || "") !== clean) {
            midEl.textContent = clean;
        }
        commitFolderTemplate();
    });
    midEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
        }
    });
    midEl.addEventListener("paste", (event) => {
        event.preventDefault();
        let text = event.clipboardData
            ? event.clipboardData.getData("text/plain")
            : "";
        text = text.replace(/[\r\n]/g, "").replace(/\/+/g, "/");
        document.execCommand("insertText", false, text);
    });
};

/** Renders the folder template editor as [token] / [editable] / [token]. */
const renderFolderTemplateEditor = (value) => {
    const editor = el.folderTemplateEditor;
    if (!editor) return;
    const mid = folderTemplateMidValue(value);
    editor.innerHTML = "";

    editor.appendChild(createInlineTemplateToken("$defaultFolder"));

    const sepL = document.createElement("span");
    sepL.className = "folder-tpl-sep";
    sepL.contentEditable = "false";
    sepL.textContent = "/";
    editor.appendChild(sepL);

    const midEl = document.createElement("span");
    midEl.className = "folder-tpl-mid";
    midEl.contentEditable = "true";
    midEl.spellcheck = false;
    midEl.setAttribute("role", "textbox");
    midEl.setAttribute("aria-label", "Subfolder path (optional)");
    midEl.textContent = mid;
    editor.appendChild(midEl);

    const sepR = document.createElement("span");
    sepR.className = "folder-tpl-sep folder-tpl-sep--trailing";
    sepR.contentEditable = "false";
    sepR.textContent = "/";
    if (!mid) sepR.classList.add("is-hidden");
    editor.appendChild(sepR);

    editor.appendChild(createInlineTemplateToken("$filename"));

    refreshDefaultFolderTokenLabel();
    bindFolderTemplateMid(midEl);
};

/** One-time wiring on the folder editor container. */
const bindFolderTemplateEditor = () => {
    const editor = el.folderTemplateEditor;
    if (!editor) return;
    // Clicking anywhere that isn't the editable middle focuses the middle
    // (caret at end), so the user can never land a caret before the tokens.
    editor.addEventListener("mousedown", (event) => {
        if (!event.target.closest(".folder-tpl-mid")) {
            event.preventDefault();
            const midEl = folderTemplateMidEl();
            if (midEl) {
                midEl.focus();
                placeCaretAtEnd(midEl);
            }
        }
    });
};

/** Places the caret at the end of a contenteditable element. */
const placeCaretAtEnd = (editor) => {
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
};

/** Places the caret between the two required tokens ($defaultFolder and $filename). */
/**
 * Updates the live preview line under the template field.
 */
const updatePreview = () => {
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
    const template = (el.folderTemplateInput && el.folderTemplateInput.value) ||
        "$defaultFolder/$filename";
    return DEJAVU.resolveFolderTemplate(template, {
        "$defaultFolder": rootFolder,
        "$filename": baseName
    });
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
    const editor = el.folderTemplateEditor;
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
    // Drop any trailing "/" — the following .folder-tpl-sep already renders
    // the separator, so the pill shouldn't double it up.
    display = display.replace(/\/+$/, "") || "/";
    const pill = editor.querySelector(
        ".template-token[data-token=\"$defaultFolder\"]"
    );
    if (!pill) return;
    const label = pill.querySelector(".template-token__label");
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
    syncTokenChips();
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
        state.filenameTokenInput.setParts(templateToParts(template));
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
    return DEJAVU.intervalToMs(el.intervalInput.value, el.intervalUnit.value);
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
    el.intervalUnit.value = String(unit);
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
    const seconds = (parseInt(el.intervalInput.value, 10) || 1) *
        (parseInt(el.intervalUnit.value, 10) || 60);
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
