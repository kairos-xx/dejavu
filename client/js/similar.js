/*
 * DejaVu — Similarity panel controller.
 *
 * Wraps the bundled SVG similarity engine (client/js/similarity/*) in a panel:
 * pick a folder (validated like the save-folder field), optionally
 * recurse, tune every config.json setting inline, then rank the folder's
 * vector files against the active Illustrator document. Results render in a
 * compact list that expands to the full element-matching breakdown.
 */
"use strict";

(() => {
    const LS_FOLDER = "dejavu.similarity.folder.v1";
    const LS_RECURSIVE = "dejavu.similarity.recursive.v1";
    const LS_CONFIG = "dejavu.similarity.config.v1";
    const LS_SORT = "dejavu.similarity.sort.v1";
    const LS_RANGE = "dejavu.similarity.range.v1";
    const LS_VIEW = "dejavu.similarity.view.v1";

    const ui = {};
    let results = [];
    let okHideTimer = null;
    let busy = false;
    let folderValid = false;

    const classNames = (typeof DEJAVU !== "undefined" && DEJAVU.classNames) ||
        ((...names) => names.filter(Boolean).join(" "));

    // The "Find similar" button stays disabled until a real folder is set
    // and we are not mid-scan.
    const updateRunEnabled = () => {
        if (!ui.run) return;
        const disabled = busy || !folderValid;
        ui.run.disabled = disabled;
        ui.run.setAttribute(
            "data-tooltip",
            busy
                ? "Scanning…"
                : folderValid
                    ? "Compare this folder against the active document"
                : "Pick a folder that exists first"
        );
    };

    const resetProgress = (hidden) => {
        if (!ui.progress) return;
        ui.progress.hidden = hidden !== false;
        ui.progress.classList.remove("is-active");
        if (ui.progressBar) ui.progressBar.style.width = "0%";
        if (ui.progressCount) ui.progressCount.textContent = "0 / 0";
        if (ui.progressLabel) ui.progressLabel.textContent = "Preparing scan…";
        if (ui.progressTrack) {
            ui.progressTrack.setAttribute("aria-valuenow", "0");
            ui.progressTrack.setAttribute("aria-valuetext", "Preparing scan");
        }
    };

    const progressText = (stage) => {
        switch (stage) {
        case "listing": return "Counting files…";
        case "listed": return "Files counted";
        case "cached": return "Reading cache";
        case "skipped": return "Skipping oversized files";
        case "converting": return "Converting files";
        case "ai2svg": return "Converting with AI2SVG";
        case "inkscape": return "Converting with Inkscape";
        case "fingerprinting": return "Fingerprinting files";
        case "indexed": return "Indexing files";
        case "error": return "Skipping unreadable files";
        case "done": return "Scan complete";
        default: return "Scanning files";
        }
    };

    const updateProgress = (p) => {
        if (!ui.progress || !p) return;
        const total = Math.max(0, Number(p.total) || 0);
        const done = Math.min(total, Math.max(0, Number(p.done) || 0));
        const current = Math.min(total, Math.max(done,
            Number(p.current) || done));
        const pct = total > 0
            ? Math.max(done < total ? 2 : 0,
                Math.round((current / total) * 100))
            : 0;
        const visualPct = total > 0 ? pct : 28;
        ui.progress.hidden = false;
        ui.progress.classList.toggle("is-active",
            [
                "listing",
                "cached",
                "skipped",
                "converting",
                "ai2svg",
                "inkscape",
                "fingerprinting",
                "indexed",
                "error"
            ]
                .indexOf(p.stage) >= 0);
        if (ui.progressBar) ui.progressBar.style.width = `${visualPct}%`;
        if (ui.progressCount) ui.progressCount.textContent = `${done} / ${total}`;
        if (ui.progressLabel) ui.progressLabel.textContent = progressText(p.stage);
        if (ui.progressTrack) {
            ui.progressTrack.setAttribute("aria-valuenow", String(pct));
            ui.progressTrack.setAttribute(
                "aria-valuetext",
                total > 0 ? `${done} of ${total} files` : progressText(p.stage)
            );
        }
    };

    // ---- small storage helpers --------------------------------------------
    const readJson = (key, fallback) => {
        try {
            return JSON.parse(window.localStorage.getItem(key)) || fallback;
        } catch (e) {
            return fallback;
        }
    };
    const writeJson = (key, value) => {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {}
    };

    const fmtBytes = (n) =>
        (typeof DEJAVU !== "undefined" ? DEJAVU.formatBytes(n) : `${n || 0} B`);
    const relAge = (ms) =>
        (typeof DEJAVU !== "undefined" ? DEJAVU.relativeAge(ms) : "");
    const fullDate = (ms) =>
        (typeof DEJAVU !== "undefined" ? DEJAVU.formatTimestamp(ms) : "");

    // ---- nested object path helpers (for the generic config form) ---------
    const getPath = (obj, path) =>
        path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

    const setPath = (obj, path, value) => {
        const keys = path.split(".");
        let node = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            if (typeof node[keys[i]] !== "object" || node[keys[i]] == null) {
                node[keys[i]] = {};
            }
            node = node[keys[i]];
        }
        node[keys[keys.length - 1]] = value;
    };

    // ---- folder validation (mirrors the save-folder field) ----------------
    const setValidity = (cls, title) => {
        if (!ui.validity) return;
        ui.validity.className = classNames("folder-validity", cls);
        ui.validity.title = title || "";
        if (ui.field) {
            ui.field.className = classNames(
                "folder-field",
                cls.replace("folder-validity--", "folder-field--")
            );
        }
    };

    const validateFolder = () => {
        const value = (ui.folder && ui.folder.value) || "";
        if (!value.trim()) {
            if (okHideTimer) {
                window.clearTimeout(okHideTimer);
                okHideTimer = null;
            }
            setValidity("folder-validity--empty", "No folder set");
            folderValid = false;
            updateRunEnabled();
            return;
        }
        let exists = false;
        let resolved = value;
        let canCheck = true;
        try {
            const fs = require("fs");
            resolved = resolveTildePath(value);
            exists = fs.existsSync(resolved) &&
                fs.statSync(resolved).isDirectory();
        } catch (e) {
            canCheck = false;
        }
        if (!canCheck) {
            // No Node fs (e.g. a UXP host) — can't verify the path, so stay
            // neutral and let the search run rather than blocking it.
            if (okHideTimer) {
                window.clearTimeout(okHideTimer);
                okHideTimer = null;
            }
            setValidity("", "");
            folderValid = true;
            updateRunEnabled();
            return;
        }
        if (exists) {
            setValidity("folder-validity--ok", `Folder exists · ${resolved}`);
            folderValid = true;
            if (okHideTimer) window.clearTimeout(okHideTimer);
            okHideTimer = window.setTimeout(() => {
                okHideTimer = null;
                if (ui.validity &&
                    ui.validity.classList.contains("folder-validity--ok")) {
                    ui.validity.className = "folder-validity";
                }
            }, 1200);
        } else {
            if (okHideTimer) {
                window.clearTimeout(okHideTimer);
                okHideTimer = null;
            }
            setValidity("folder-validity--missing",
                "Folder not found — nothing to search there yet");
            folderValid = false;
        }
        updateRunEnabled();
    };

    // ---- settings form, built from the engine defaults -------------------
    // Each section becomes a labeled group with a one-line description, and
    // each setting gets a friendly label + a support hint (à la Advanced).
    const SECTIONS = [
        {
            key: "index",
            label: "Scanning",
            hint: "Which files are scanned and how the scan is paced."
        },
        {
            key: "engine",
            label: "Matching",
            hint: "How shapes are sampled and matched."
        },
        {
            key: "engine.weights",
            label: "Comparison weights",
            hint: "Relative importance of each trait in the score — higher counts for more."
        },
        {
            key: "index.externalConverters",
            label: "External converters",
            hint: "Tools used to read non-SVG vector files (PDF / AI / EPS)."
        },
        {
            key: "thresholds",
            label: "Thresholds",
            hint: "Score cut-offs used to label each match."
        }
    ];

    // Settings handled elsewhere in the UI, so they are hidden from the form.
    const SKIP = new Set([
        "index.recursive",
        "engine.includeHidden",
        "index.externalConverters.enabled",
        "index.cacheFileName",
        "index.shortlistLimit",
        "index.ioConcurrency",
        "index.conversionConcurrency",
        "index.fingerprintConcurrency",
        "index.saveCacheEvery"
    ]);
    const ROW_GROUPS = [
        ["index.allowedExtensions", "index.maxFileSizeBytes", "index.limit"],
        ["engine.samplesPerElement", "engine.maxSamples"]
    ];
    const ROW_GROUP_START = new Map(
        ROW_GROUPS.map((g) => [g[0], g])
    );

    // Friendly label + support text per config path. Anything missing falls
    // back to a humanized key (and, for weights, an auto-generated hint).
    const META = {
        "engine.samplesPerElement": {
            label: "Sample points per shape",
            hint: "Points sampled along each shape. More points = finer detail, slower scans."
        },
        "engine.maxSamples": {
            label: "Max total samples",
            hint: "Hard cap on sample points per document to keep large files fast."
        },
        "engine.rotationInvariant": {
            label: "Ignore rotation",
            hint: "Treat a rotated copy of a shape as the same shape."
        },
        "engine.scaleInvariant": {
            label: "Ignore scale",
            hint: "Treat a resized copy of a shape as the same shape."
        },
        "engine.translationInvariant": {
            label: "Ignore position",
            hint: "Treat a moved copy of a shape as the same shape."
        },
        "engine.mirrorInvariant": {
            label: "Match mirrored shapes",
            hint: "Treat a flipped or mirrored copy as the same shape."
        },
        "engine.compareTextAsGeometry": {
            label: "Compare text as outlines",
            hint: "Convert text to curves before comparing instead of matching characters."
        },
        "engine.compareRasterImagesByBBox": {
            label: "Compare images by bounds",
            hint: "Match placed and raster images by their bounding box, not pixels."
        },
        "engine.colorTolerance": {
            label: "Color tolerance",
            hint: "How far two colors can differ (0–255) and still count as a match.",
            num: { min: 0, max: 255, step: 1 }
        },
        "engine.numericPrecision": {
            label: "Numeric precision",
            hint: "Decimal places used when comparing coordinates and values.",
            num: { min: 0, max: 12, step: 1 }
        },
        "engine.elementMatchThreshold": {
            label: "Element match threshold",
            hint: "Minimum similarity (0–1) for two elements to be paired up.",
            num: { min: 0, max: 1, step: 0.01 }
        },
        "engine.reportSampleLimit": {
            label: "Report sample limit",
            hint: "Maximum element pairs listed in the detailed breakdown."
        },
        "engine.pathSampleMinDistance": {
            label: "Min sample spacing",
            hint: "Smallest gap between sample points along a path.",
            num: { min: 0, step: 0.0005 }
        },
        "engine.pathSampleRoundToNearest": {
            label: "Round samples to",
            hint: "Snap sample coordinates to this grid (0 = no rounding).",
            num: { min: 0, step: 0.0005 }
        },

        "engine.weights.canvas": { label: "Canvas / artboard" },
        "engine.weights.elementTypes": { label: "Element-type mix" },
        "engine.weights.structure": { label: "Layer structure" },
        "engine.weights.geometryRaw": { label: "Raw geometry" },
        "engine.weights.geometryNormalized": { label: "Normalized geometry" },
        "engine.weights.geometryMultiRotation": { label: "Rotation-tested geometry" },
        "engine.weights.bbox": { label: "Bounding box" },
        "engine.weights.fill": { label: "Fill colors" },
        "engine.weights.stroke": { label: "Stroke colors" },
        "engine.weights.strokeWidth": { label: "Stroke width" },
        "engine.weights.opacity": { label: "Opacity" },
        "engine.weights.pathCommands": { label: "Path commands" },
        "engine.weights.curvature": { label: "Curvature" },
        "engine.weights.complexity": { label: "Complexity" },
        "engine.weights.imageUsage": { label: "Image usage" },
        "engine.weights.textUsage": { label: "Text usage" },
        "engine.weights.defsUsage": { label: "Defs / symbols" },
        "engine.weights.gradientUsage": { label: "Gradients" },

        "index.allowedExtensions": {
            label: "File types to scan",
            hint: "Only these extensions are compared (comma-separated)."
        },
        "index.maxFileSizeBytes": {
            label: "Max file size (bytes)",
            hint: "Skip files larger than this to avoid slow scans.",
            num: { min: 0, step: 1048576 }
        },
        "index.cacheFileName": {
            label: "Cache file name",
            hint: "Name of the per-folder fingerprint cache written during scans."
        },
        "index.limit": {
            label: "Max results",
            hint: "Largest number of matches returned."
        },
        "index.shortlistLimit": {
            label: "Shortlist size",
            hint: "How many fast-ranked candidates get the deep comparison."
        },
        "index.ioConcurrency": {
            label: "Read concurrency",
            hint: "How many files are read from disk in parallel."
        },
        "index.conversionConcurrency": {
            label: "Convert concurrency",
            hint: "How many files are converted to SVG in parallel."
        },
        "index.fingerprintConcurrency": {
            label: "Fingerprint concurrency",
            hint: "How many fingerprints are computed in parallel."
        },
        "index.saveCacheEvery": {
            label: "Cache save interval",
            hint: "Write the cache to disk after this many files."
        },
        "index.skipFolders": {
            label: "Folders to skip",
            hint: "Folders never scanned. Type a name and press Enter, or add one from disk."
        },

        "index.externalConverters.prefer": {
            label: "Converter order",
            hint: "Converters are tried in this order. Drag to reorder; add or remove from the fixed set."
        },

        "thresholds.nearDuplicate": {
            label: "Near-duplicate ≥",
            hint: "Score at or above this is treated as a near-duplicate (0–1)."
        },
        "thresholds.similar": {
            label: "Similar ≥",
            hint: "Score at or above this counts as similar (0–1)."
        },
        "thresholds.loose": {
            label: "Loosely similar ≥",
            hint: "Lowest score still considered a loose match (0–1)."
        },

        "ui.showBreakdown": {
            label: "Show element breakdown",
            hint: "Include the per-element matched / changed / new / removed counts."
        },
        "ui.showConvertedFormat": {
            label: "Show converted format",
            hint: "Note which converter produced each compared file."
        },
        "ui.openFileOnClick": {
            label: "Open file on click",
            hint: "Engine flag: open a result file when its row is clicked."
        },
        "ui.showElementReport": {
            label: "Build element report",
            hint: "Compute the detailed element-matching report for each result."
        },
        "ui.showFileMetadata": {
            label: "Include file metadata",
            hint: "Attach size and modified date to each result."
        },
        "ui.defaultSearchFolderFromCurrentDocument": {
            label: "Default to document’s folder",
            hint: "Engine flag: seed the search folder from the active document."
        }
    };

    const humanize = (key) =>
        String(key)
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_-]+/g, " ")
            .replace(/^./, (c) => c.toUpperCase());

    const metaFor = (path, key) => {
        const m = META[path] || {};
        return { label: m.label || humanize(key), hint: m.hint || "" };
    };

    // Array settings with a known option set render as multi-select
    // dropdowns; anything else (e.g. skipFolders) stays a free-text list.
    const OPTIONS = {
        "index.allowedExtensions":
            [".svg", ".svgz", ".pdf", ".ai", ".eps"],
        "index.externalConverters.prefer":
            ["embeddedSVG", "ai2svg", "inkscape", "illustrator"]
    };

    // Settings that are only meaningful while another (boolean) setting is on.
    // When the controller is off, the dependents are disabled.
    const DEPENDS = {};
    const CONTROLLERS = new Set(Object.values(DEPENDS));

    // Stepping for spin-box number inputs, by config path / section.
    const numAttrs = (path, sectionKey) => {
        const m = META[path];
        if (m && m.num) return m.num;
        if (sectionKey === "engine.weights") {
            return { min: 0, max: 1, step: 0.005 };
        }
        if (sectionKey === "thresholds") {
            return { min: 0, max: 1, step: 0.01 };
        }
        return { min: 0, step: 1 };
    };

    const overrides = () => readJson(LS_CONFIG, {});

    const buildConfig = () => {
        const base = (typeof SVGSimilarityConfig !== "undefined")
            ? SVGSimilarityConfig.defaults()
            : {};
        const cfg = (typeof SVGSimilarityConfig !== "undefined")
            ? SVGSimilarityConfig.fromObject(mergeDeep(base, overrides()))
            : base;
        if (cfg.engine) cfg.engine.includeHidden = true;
        if (cfg.index && cfg.index.externalConverters) {
            cfg.index.externalConverters.enabled = true;
        }
        return cfg;
    };

    const mergeDeep = (base, over) => {
        const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
        Object.keys(over || {}).forEach((k) => {
            if (over[k] && typeof over[k] === "object" &&
                !Array.isArray(over[k]) && base && typeof base[k] === "object") {
                out[k] = mergeDeep(base[k], over[k]);
            } else {
                out[k] = over[k];
            }
        });
        return out;
    };

    const onSettingChange = (path, rawValue, type) => {
        let value = rawValue;
        if (type === "boolean") value = !!rawValue;
        else if (type === "number") value = Number(rawValue);
        else if (type === "array") {
            value = Array.isArray(rawValue)
                ? rawValue.slice()
                : String(rawValue).split(",")
                    .map((s) => s.trim()).filter(Boolean);
        }
        const ov = overrides();
        setPath(ov, path, value);
        writeJson(LS_CONFIG, ov);
        // A toggled controller may enable/disable dependent rows.
        if (CONTROLLERS.has(path)) applyDependencies();
    };

    const tooltipFor = (path, def, hint) => {
        const shown = Array.isArray(def)
            ? def.join(", ")
            : def == null ? "—" : String(def);
        const parts = [];
        if (hint) parts.push(hint);
        parts.push(path);
        parts.push(`default: ${shown}`);
        return parts.join("  ·  ");
    };

    const addHint = () => {};
    const appendVisibleHint = (parent, text) => {
        if (!parent || !text) return;
        const hint = document.createElement("p");
        hint.className = "field-hint";
        hint.textContent = text;
        parent.appendChild(hint);
    };

    // Boolean → an Advanced-style checkbox row with a support hint.
    const makeBoolRow = (path, label, hint, value, tip) => {
        const section = document.createElement("section");
        section.className =
            "field-group field-group--embedded field-group--row comparison-settings__field";
        const lab = document.createElement("label");
        lab.className = "checkbox";
        lab.setAttribute("data-tooltip", tip);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!value;
        input.addEventListener("change",
            () => onSettingChange(path, input.checked, "boolean"));
        const span = document.createElement("span");
        span.className = "settings-field-title";
        span.textContent = label;
        lab.appendChild(input);
        lab.appendChild(span);
        section.appendChild(lab);
        addHint(section, hint);
        return section;
    };

    const fieldLabel = (label, tip) => {
        const lab = document.createElement("label");
        lab.className = "mini-field mini-field--wide";
        lab.setAttribute("data-tooltip", tip);
        const span = document.createElement("span");
        span.className = "settings-field-title";
        span.textContent = label;
        lab.appendChild(span);
        return lab;
    };

    const valueRowSection = () => {
        const section = document.createElement("section");
        section.className =
            "field-group field-group--embedded comparison-settings__field";
        return section;
    };

    // ---- spin-box number inputs -------------------------------------------
    // Self-wired because main.js only scans the static DOM once at init, so
    // these dynamically-built rows would otherwise have inert spin buttons.
    const stepInput = (input, action, factor) => {
        const min = parseFloat(input.getAttribute("min"));
        const max = parseFloat(input.getAttribute("max"));
        const step = (parseFloat(input.getAttribute("step")) || 1) *
            (factor || 1);
        let v = parseFloat(input.value) || 0;
        v += action === "up" ? step : -step;
        if (!isNaN(min) && v < min) v = min;
        if (!isNaN(max) && v > max) v = max;
        v = Math.round(v * 1e6) / 1e6;
        input.value = v;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const spinChevron = (action) => {
        const icon = document.createElement("span");
        icon.className = "spin-chevron svg-icon";
        icon.dataset.icon = action === "up" ? "chevron-up" : "chevron-down";
        icon.setAttribute("aria-hidden", "true");
        if (window.dejavu && window.dejavu.injectIcon) {
            window.dejavu.injectIcon(icon);
        }
        return icon;
    };

    const spinButton = (input, action) => {
        const btn = document.createElement("div");
        btn.className = "number-spin-button";
        btn.setAttribute("data-action", action);
        btn.appendChild(spinChevron(action));
        btn.addEventListener("click", (evt) => {
            evt.preventDefault();
            if (input.disabled) return;
            stepInput(input, action, 1);
        });
        return btn;
    };

    const makeSpinbox = (value, attrs) => {
        const group = document.createElement("div");
        group.className = "number-input-group";
        const input = document.createElement("input");
        input.type = "number";
        if (attrs.min != null) input.min = String(attrs.min);
        if (attrs.max != null) input.max = String(attrs.max);
        input.step = String(attrs.step != null ? attrs.step : "any");
        input.value = String(value);
        const buttons = document.createElement("div");
        buttons.className = "number-spin-buttons";
        const up = spinButton(input, "up");
        const down = spinButton(input, "down");
        buttons.appendChild(up);
        buttons.appendChild(down);
        group.appendChild(buttons);
        group.appendChild(input);
        // Keyboard arrows mirror the buttons; Shift steps 10x.
        input.addEventListener("keydown", (evt) => {
            if (evt.key !== "ArrowUp" && evt.key !== "ArrowDown") return;
            evt.preventDefault();
            const action = evt.key === "ArrowUp" ? "up" : "down";
            stepInput(input, action, evt.shiftKey ? 10 : 1);
            const flash = action === "up" ? up : down;
            flash.classList.add("is-active");
            window.setTimeout(() => flash.classList.remove("is-active"), 140);
        });
        return { group, input };
    };

    // Number → spin-box; text / free-form array → a plain text field.
    const makeValueRow = (path, label, hint, value, tip, sectionKey) => {
        const section = valueRowSection();
        const lab = fieldLabel(label, tip);

        if (typeof value === "number") {
            const built = makeSpinbox(value, numAttrs(path, sectionKey));
            built.input.addEventListener("change",
                () => onSettingChange(path, built.input.value, "number"));
            lab.appendChild(built.group);
        } else {
            const input = document.createElement("input");
            input.type = "text";
            const type = Array.isArray(value) ? "array" : "string";
            input.value = Array.isArray(value)
                ? value.join(", ")
                : value == null ? "" : String(value);
            input.addEventListener("change",
                () => onSettingChange(path, input.value, type));
            lab.appendChild(input);
        }
        section.appendChild(lab);
        addHint(section, hint);
        return section;
    };

    // ---- byte size with a KB / MB / GB unit selector ---------------------
    const BYTE_UNITS = [
        { id: "KB", factor: 1024 },
        { id: "MB", factor: 1048576 },
        { id: "GB", factor: 1073741824 }
    ];
    const LS_SIZE_UNIT = "dejavu.similarity.maxsize.unit.v1";
    const trimNum = (n) => Math.round(n * 1e6) / 1e6;
    const trimSizeNum = (n) => (Math.round(n * 100) / 100).toFixed(2);
    const byteUnitById = (id) =>
        BYTE_UNITS.filter((u) => u.id === id)[0] || null;
    const bestByteUnit = (bytes) => {
        for (let i = BYTE_UNITS.length - 1; i >= 0; i--) {
            if (bytes >= BYTE_UNITS[i].factor) return BYTE_UNITS[i];
        }
        return BYTE_UNITS[1];
    };

    const makeByteSizeRow = (path, label, hint, value, tip) => {
        const section = valueRowSection();
        const lab = fieldLabel(label, tip);
        let unit = byteUnitById(window.localStorage.getItem(LS_SIZE_UNIT)) ||
            bestByteUnit(Number(value) || 0);

        const pills = document.createElement("div");
        pills.className = "settings-row__pills bytesize";

        const built = makeSpinbox(
            trimSizeNum((Number(value) || 0) / unit.factor),
            { min: 0, step: 0.01 });
        const input = built.input;

        const selWrap = document.createElement("div");
        selWrap.className = "select-wrapper";
        const sel = document.createElement("select");
        sel.className = "unit-select";
        BYTE_UNITS.forEach((u) => {
            const o = document.createElement("option");
            o.value = u.id;
            o.textContent = u.id;
            if (u.id === unit.id) o.selected = true;
            sel.appendChild(o);
        });
        selWrap.appendChild(sel);

        input.addEventListener("change", () => {
            const bytes = Math.round(
                (parseFloat(input.value) || 0) * unit.factor);
            onSettingChange(path, bytes, "number");
        });
        sel.addEventListener("change", () => {
            const bytes = (parseFloat(input.value) || 0) * unit.factor;
            unit = byteUnitById(sel.value) || unit;
            window.localStorage.setItem(LS_SIZE_UNIT, unit.id);
            input.value = String(trimSizeNum(bytes / unit.factor));
        });

        pills.appendChild(built.group);
        pills.appendChild(selWrap);
        lab.appendChild(pills);
        section.appendChild(lab);
        addHint(section, hint);

        return section;
    };

    // True inside Illustrator (CEP or UXP host); false in a plain browser,
    // i.e. dev/testing where there is no host bridge.
    const inHostEnv = () =>
        typeof window.__adobe_cep__ !== "undefined" ||
        typeof window.DejaVuHost !== "undefined";

    // Folder picker that works in both worlds: the host's native chooser inside
    // Illustrator, or the browser's native directory <input> when testing in a
    // plain browser (Finder / File Explorer). The browser can only surface the
    // chosen folder's name (no absolute path, by design), which is enough for
    // dev/testing.
    const pickFolderPath = (start) => {
        if (inHostEnv()) {
            return Promise.resolve(
                callHost("dejavu_chooseFolder", [String(start || "")])
            ).then((r) => (r && r.ok && r.path) ? r.path : null);
        }
        // Browser dev/testing: a real OS folder picker (no file upload). The
        // browser only exposes the chosen folder's NAME, so we surface it as a
        // home-relative path "~/<name>" — enough for testing against the tree.
        if (typeof window.showDirectoryPicker === "function") {
            return window.showDirectoryPicker()
                .then((h) => (h && h.name ? "/" + h.name : null))
                .catch(() => null);
        }
        // Fallback (older browsers / file://): directory <input>, name only.
        return new Promise((resolve) => {
            const input = document.createElement("input");
            input.type = "file";
            input.setAttribute("webkitdirectory", "");
            input.setAttribute("directory", "");
            input.style.display = "none";
            let settled = false;
            const finish = (val) => {
                if (settled) return;
                settled = true;
                if (input.parentNode) input.parentNode.removeChild(input);
                window.removeEventListener("focus", onRefocus, true);
                resolve(val || null);
            };
            input.addEventListener("change", () => {
                const f = input.files && input.files[0];
                const name = f
                    ? (f.webkitRelativePath
                        ? f.webkitRelativePath.split("/")[0]
                        : f.name)
                    : "";
                finish(name ? "/" + name : null);
            }, { once: true });
            const onRefocus = () => {
                window.setTimeout(() => {
                    if (!input.files || !input.files.length) finish(null);
                }, 300);
            };
            window.addEventListener("focus", onRefocus, true);
            document.body.appendChild(input);
            input.click();
        });
    };

    // DEV ONLY: a hardcoded slice of a macOS home folder tree, used for the
    // autocomplete when running in a plain browser (where we can't read the real
    // filesystem). Inside Illustrator the suggest function reads the real dirs
    // via Node instead — see folderSuggest().
    const DEV_FS_TREE = {
        Desktop: { Screenshots: {}, Mockups: {} },
        Documents: { Invoices: {}, Contracts: {}, Personal: {} },
        Downloads: {
            AutoSaveAI_new: {
                client: { css: {}, js: { similarity: {} }, lib: {} },
                host: {}, icons: {}, scripts: {}, vendor: {}
            },
            Archives: {}
        },
        Movies: {},
        Music: {},
        Pictures: { Wallpapers: {} },
        Public: {},
        Applications: {},
        Library: {
            Fonts: {},
            Preferences: {},
            "Application Support": {},
            "Application Xxx": {}
        }
    };
    // Shared so other modules (e.g. the folder-template field in interval.js)
    // can offer the same dev-mode folder autocomplete in a plain browser.
    if (typeof window !== "undefined") window.__DEJAVU_DEV_FS_TREE__ = DEV_FS_TREE;

    // True when the path is a real, existing folder — the real filesystem when
    // a Node bridge is present (CEP/UXP), otherwise the hardcoded dev tree.
    const folderExists = (raw) => {
        const q = String(raw || "").trim();
        const lead = q.charAt(0);
        if (lead !== "/" && lead !== "~") return false;
        try {
            const fs = require("fs");
            const p = lead === "~"
                ? require("os").homedir() + q.slice(1)
                : q;
            return fs.existsSync(p) && fs.statSync(p).isDirectory();
        } catch (e) {
            const rest = (lead === "~"
                ? q.replace(/^~\/?/, "")
                : q.replace(/^\/+/, "")).replace(/\/+$/, "");
            if (!rest) return true; // "/" = root, "~" = home
            const segs = rest.split("/");
            let node = DEV_FS_TREE;
            for (let i = 0; i < segs.length; i++) {
                if (node && typeof node === "object" && node[segs[i]]) {
                    node = node[segs[i]];
                } else {
                    return false;
                }
            }
            return true;
        }
    };

    // Autocomplete for "~/…" folder paths: lists subfolders of the directory in
    // the typed path, filtered by the partial last segment. Real FS when a Node
    // bridge is present (CEP/UXP), the dev tree otherwise.
    const folderSuggest = (query) => {
        const q = String(query || "");
        const lead = q.charAt(0);
        if (lead !== "/" && lead !== "~") return [];   // "/" = root, "~" = home
        const rest = lead === "~"
            ? q.replace(/^~\/?/, "")
            : q.replace(/^\/+/, "");
        const segs = rest.split("/");
        const partial = segs.pop();
        const base = lead === "~" ? "~/" : "/";
        const prefix = base + (segs.length ? segs.join("/") + "/" : "");
        const pl = partial.toLowerCase();
        // Shown (dimmed) after each suggestion's name — the folder's parent path.
        const parentLabel = prefix.replace(/\/+$/, "") || "/";

        // Real filesystem (CEP/UXP Node): list dirs, and mark which have
        // subfolders so the menu knows whether clicking descends or commits.
        try {
            const fs = require("fs");
            const dir = lead === "~"
                ? require("os").homedir() + (segs.length ? "/" + segs.join("/") : "")
                : "/" + segs.join("/");   // "/" for root
            const join = (d, n) => (d === "/" ? "/" + n : d + "/" + n);
            const dirHasSubdir = (p) => {
                try {
                    return fs.readdirSync(p).some((c) => {
                        try { return fs.statSync(join(p, c)).isDirectory(); }
                        catch (ec) { return false; }
                    });
                } catch (ed) { return false; }
            };
            return fs.readdirSync(dir)
                .filter((name) => {
                    try { return fs.statSync(join(dir, name)).isDirectory(); }
                    catch (eStat) { return false; }
                })
                .filter((n) => n.toLowerCase().indexOf(pl) === 0)
                .sort()
                .slice(0, 50)
                // hasChildren drives the descend-vs-commit choice, so only the
                // visible rows need the (costly) per-folder readdir; the rest
                // sit behind the "…" hint.
                .map((n, i) => ({
                    value: prefix + n + "/",
                    label: n,
                    hint: parentLabel,
                    hasChildren: i < 16 ? dirHasSubdir(join(dir, n)) : true
                }));
        } catch (e) {
            // Browser dev: walk the hardcoded tree.
            let node = DEV_FS_TREE;
            for (let i = 0; i < segs.length; i++) {
                if (!segs[i]) continue;
                if (node && typeof node === "object" && node[segs[i]]) {
                    node = node[segs[i]];
                } else {
                    return [];
                }
            }
            if (!node || typeof node !== "object") return [];
            return Object.keys(node)
                .filter((n) => n.toLowerCase().indexOf(pl) === 0)
                .sort()
                .slice(0, 50)
                .map((n) => ({
                    value: prefix + n + "/",
                    label: n,
                    hint: parentLabel,
                    hasChildren: !!(node[n] && typeof node[n] === "object" &&
                        Object.keys(node[n]).length > 0)
                }));
        }
    };

    const makeFixedTokenRow = (
        path,
        label,
        hint,
        value,
        tip,
        options,
        rowOpts
    ) => {
        rowOpts = rowOpts || {};
        const section = valueRowSection();
        section.classList.add("comparison-settings__token-field");

        const labelId = `${path.replace(/[^a-z0-9]+/gi, "-")}-label`;
        const lab = document.createElement("label");
        lab.className = "field-label settings-field-title";
        lab.id = labelId;
        lab.setAttribute("data-tooltip", tip);
        lab.textContent = label;

        section.appendChild(lab);
        if (window.TokenField) {
            let syncing = false;
            const orderedValues = (values) => {
                const seen = {};
                const picked = [];
                (values || []).forEach((value) => {
                    const canonical = options.find((opt) =>
                        opt.toLowerCase() === String(value).toLowerCase());
                    if (!canonical) return;
                    const key = canonical.toLowerCase();
                    if (seen[key]) return;
                    seen[key] = true;
                    picked.push(canonical);
                });
                if (path === "index.allowedExtensions") {
                    return picked.slice().sort((a, b) =>
                        a.localeCompare(b, undefined, {
                            sensitivity: "base"
                        }));
                }
                return picked;
            };
            const tf = window.TokenField.create({
                tokens: options.map((opt) => ({
                    key: opt,
                    label: opt,
                    title: opt
                })),
                value: orderedValues(value),
                singleUse: true,
                allowFreeText: false,
                allowCustomTokens: false,
                showPalette: false,
                reorder: !!rowOpts.reorder,
                suggest: (query) => {
                    const q = String(query || "").trim().toLowerCase();
                    return options
                        .filter((opt) => !q ||
                            opt.toLowerCase().indexOf(q) >= 0)
                        .map((opt) => ({
                            value: opt,
                            label: opt,
                            token: true
                        }));
                },
                hideUsedSuggestions: true,
                placeholder: "Type to add tokens…",
                onChange: () => {
                    if (syncing) return;
                    const values = orderedValues(tf.getValues());
                    if (path === "index.allowedExtensions" &&
                            values.join("\u0000") !==
                            tf.getValues().join("\u0000")) {
                        syncing = true;
                        tf.setValue(values);
                        syncing = false;
                    }
                    onSettingChange(path, values, "array");
                }
            });
            tf.element.id = `${labelId}-editor`;
            tf.element.setAttribute("aria-labelledby", labelId);
            section.appendChild(tf.element);
        }
        addHint(section, hint);
        return section;
    };

    // ---- token / chip editors --------------------------------------------
    // opts: { fixed: string[]|null, reorder: bool, allowFinder: bool }
    //   fixed  → only these values; chosen chips (reorderable) + an available
    //            pool below; picking one moves it out of the pool.
    //   null   → free text chips + an "Add folder…" picker.
    const makeTokenRow = (path, label, hint, value, tip, opts) => {
        opts = opts || {};
        const fixed = opts.fixed || null;
        if (fixed) {
            return makeFixedTokenRow(
                path,
                label,
                hint,
                value,
                tip,
                fixed,
                opts
            );
        }

        // Free-text folder chips use TokenField for custom tokens,
        // drag-reorder, and a token-shaped "Add folder…" trailing button.
        if (window.TokenField) {
            const sectionTF = valueRowSection();
            // The editor must NOT be nested inside a <label>: a <label>
            // redirects clicks to its labelable control, and a contenteditable
            // div isn't one — so the caret never lands and typing is blocked.
            // Render the caption as a sibling field-label (as makeFixedTokenRow
            // does) and keep the TokenField as a separate element.
            const labelId = `${path.replace(/[^a-z0-9]+/gi, "-")}-tf-label`;
            const labTF = document.createElement("label");
            labTF.className = "field-label settings-field-title";
            labTF.id = labelId;
            labTF.setAttribute("data-tooltip", tip);
            labTF.textContent = label;
            const tf = window.TokenField.create({
                value: (value || []).slice(),
                allowCustomTokens: true,
                allowFreeText: false,
                singleUse: true,
                reorder: opts.reorder !== false,
                commitOnSpace: true,
                suggest: folderSuggest,
                // Suggestions open once the path starts with "/".
                suggestTrigger: "/",
                // Space (or Enter) commits the typed path — but only if the
                // folder actually exists on disk; otherwise the text is
                // discarded. Node fs in CEP, host check as a fallback.
                // Only known folders may become tokens — real FS in-host, the
                // hardcoded dev tree in a plain browser.
                validateCustom: (text) => folderExists(text),
                // Store paths without a trailing slash ("~/Desktop/" → "~/Desktop").
                normalize: (v) => String(v).replace(/\/+$/, ""),
                // Double-click a folder token to re-pick it (opens the OS picker
                // at that location in-host); the chosen folder replaces it.
                onTokenDblClick: (value) => pickFolderPath(value),
                placeholder: "Type / to browse folders…",
                trailingButton: {
                    label: "Add folder…",
                    onClick: () => pickFolderPath().then((p) => {
                        if (p) tf.addCustom(p);
                    })
                },
                onChange: () =>
                    onSettingChange(path, tf.getValues(), "array")
            });
            tf.element.setAttribute("aria-labelledby", labelId);
            sectionTF.appendChild(labTF);
            sectionTF.appendChild(tf.element);
            addHint(sectionTF, hint);
            return sectionTF;
        }

        const section = valueRowSection();
        section.appendChild(fieldLabel(label, tip));
        addHint(section, hint);
        return section;
    };

    // Disable rows whose controlling checkbox is off.
    const applyDependencies = () => {
        if (!ui.settings) return;
        const cfg = buildConfig();
        ui.settings.querySelectorAll("[data-dep-on]").forEach((section) => {
            const on = !!getPath(cfg, section.getAttribute("data-dep-on"));
            section.classList.toggle("is-disabled", !on);
            section.querySelectorAll("input, button, select").forEach((ctl) => {
                ctl.disabled = !on;
            });
            if (!on) closeAllMultiselects();
        });
    };

    const renderSettings = () => {
        if (!ui.settings) return;
        const cfg = buildConfig();
        const defs = (typeof SVGSimilarityConfig !== "undefined")
            ? SVGSimilarityConfig.defaults()
            : {};
        ui.settings.innerHTML = "";
        SECTIONS.forEach((section) => {
            const node = getPath(cfg, section.key);
            if (!node || typeof node !== "object") return;
            const group = document.createElement("div");
            group.className = "comparison-settings__group";
            group.dataset.section = section.key;
            if (section.key === "engine.weights" ||
                section.key === "engine" ||
                section.key === "index" ||
                section.key === "thresholds") {
                group.classList.add("comparison-settings__group--grid");
            }
            const title = document.createElement("div");
            title.className = "comparison-settings__group-title settings-title";
            title.textContent = section.label;
            if (section.hint) title.setAttribute("data-tooltip", section.hint);
            group.appendChild(title);
            const useGrid = group.classList.contains("comparison-settings__group--grid");
            let grid = null;
            const ensureGrid = () => {
                if (!useGrid) return group;
                if (grid) return grid;
                grid = document.createElement("div");
                grid.className = "comparison-settings__grid";
                group.appendChild(grid);
                return grid;
            };
            const appendSettingRow = (row) => {
                ensureGrid().appendChild(row);
            };
            const appendStandaloneRow = (row) => {
                group.appendChild(row);
                grid = null;
            };
            const isWeights = section.key === "engine.weights";
            let pendingRowGroup = null;
            Object.keys(node).forEach((k) => {
                const v = node[k];
                if (v && typeof v === "object" && !Array.isArray(v)) return;
                if (String(k).startsWith("$") ||
                    String(k).startsWith("_")) return;
                const path = `${section.key}.${k}`;
                if (SKIP.has(path)) return;
                const meta = metaFor(path, k);
                let hint = meta.hint;
                if (!hint && isWeights) {
                    hint = "";
                }
                const tip = tooltipFor(path, getPath(defs, path), hint);
                let row;
                if (typeof v === "boolean") {
                    row = makeBoolRow(path, meta.label, hint, v, tip);
                } else if (path === "index.maxFileSizeBytes") {
                    row = makeByteSizeRow(path, meta.label, hint, v, tip);
                } else if (path === "index.skipFolders") {
                    row = makeTokenRow(path, meta.label, hint, v, tip,
                        { allowFinder: true });
                } else if (path === "index.externalConverters.prefer") {
                    row = makeTokenRow(path, meta.label, hint, v, tip,
                        { fixed: OPTIONS[path], reorder: true });
                } else if (Array.isArray(v) && OPTIONS[path]) {
                    row = makeTokenRow(path, meta.label, hint, v, tip,
                        { fixed: OPTIONS[path], reorder: false });
                } else {
                    row = makeValueRow(
                        path, meta.label, hint, v, tip, section.key);
                }
                row.dataset.path = path;
                if (path === "index.cacheFileName" ||
                    path === "index.skipFolders" ||
                    path === "index.externalConverters.prefer") {
                    row.classList.add("comparison-settings__field--wide");
                }
                if (DEPENDS[path]) row.dataset.depOn = DEPENDS[path];
                if (ROW_GROUP_START.has(path)) {
                    const group = ROW_GROUP_START.get(path);
                    pendingRowGroup = {
                        paths: group.slice(1),
                        wrap: document.createElement("div")
                    };
                    pendingRowGroup.wrap.className = "comparison-settings__row-pair";
                    pendingRowGroup.wrap.appendChild(row);
                    appendStandaloneRow(pendingRowGroup.wrap);
                    return;
                }
                if (pendingRowGroup && pendingRowGroup.paths[0] === path) {
                    pendingRowGroup.wrap.appendChild(row);
                    pendingRowGroup.paths.shift();
                    if (pendingRowGroup.paths.length === 0) {
                        pendingRowGroup = null;
                    }
                    return;
                }
                if (path === "index.skipFolders") {
                    appendStandaloneRow(row);
                    return;
                }
                appendSettingRow(row);
                if (path === "index.externalConverters.prefer") {
                    appendVisibleHint(
                        row,
                        "Converters are tried from left to right; drag to change fallback priority."
                    );
                }
            });
            if (section.key === "thresholds" && grid) {
                appendVisibleHint(
                    grid,
                    "Higher thresholds make labels stricter; lower thresholds make more results qualify."
                );
            }
            if (section.key === "index" && ui.indexSettings) {
                ui.indexSettings.appendChild(group);
            } else {
                ui.settings.appendChild(group);
            }
        });
        if (typeof window.dejavuEnhanceSelects === "function") {
            window.dejavuEnhanceSelects(ui.settings);
            if (ui.indexSettings) {
                window.dejavuEnhanceSelects(ui.indexSettings);
            }
        }
        applyDependencies();
    };

    // ---- results rendering -------------------------------------------------
    const sortResults = (list, mode) => {
        const copy = list.slice();
        const mtime = (r) => (r.report &&
            r.report.documents && r.report.documents.b &&
            r.report.documents.b.mtimeMs) || 0;
        const name = (r) => (r.report && r.report.documents &&
            r.report.documents.b && r.report.documents.b.name) ||
            r.filePath || "";
        if (mode === "newest") copy.sort((a, b) => mtime(b) - mtime(a));
        else if (mode === "oldest") copy.sort((a, b) => mtime(a) - mtime(b));
        else if (mode === "name") {
            copy.sort((a, b) => name(a).localeCompare(name(b)));
        } else {
            // "similar" (default): most similar first = smallest delta.
            copy.sort((a, b) => a.delta - b.delta);
        }
        return copy;
    };

    const countsOf = (result) => {
        const m = (result.report && result.report.elementMatching) || {};
        return {
            similar: m.matchedSimilar || 0,
            changed: m.matchedChanged || 0,
            added: m.newInB || 0,
            removed: m.removedFromA || 0
        };
    };

    const pill = (cls, n, label) => {
        const span = document.createElement("span");
        span.className = classNames("sim-pill", `sim-pill--${cls}`);
        span.innerHTML =
            `<strong>${n}</strong> ${label}`;
        return span;
    };

    // Compact colored count for the always-visible row line.
    const miniCount = (cls, n, label, title) => {
        const span = document.createElement("span");
        span.className = classNames("similar-mini", `similar-mini--${cls}`);
        span.title = title || "";
        span.innerHTML = `<strong>${n}</strong> ${label}`;
        return span;
    };

    const detailMetric = (label, value) => {
        const item = document.createElement("span");
        item.className = "similar-metric";
        const key = document.createElement("span");
        key.className = "similar-metric__label";
        key.textContent = label;
        const val = document.createElement("strong");
        val.className = "similar-metric__value";
        val.textContent = value;
        item.appendChild(key);
        item.appendChild(val);
        return item;
    };

    const converterInfo = (doc) => {
        const key = String((doc && doc.converter) || "").toLowerCase();
        const format = String((doc && doc.format) || "").replace(/^\./, "");
        if (key === "inkscape") {
            return {
                key: "inkscape",
                label: "Inkscape",
                title: `Converted ${format || "file"} with Inkscape`,
                icon: "engine-inkscape"
            };
        }
        if (key === "ai2svg") {
            return {
                key: "ai2svg",
                label: "AI2SVG",
                title: `Converted ${format || "file"} with bundled AI2SVG`,
                icon: "engine-ai2svg"
            };
        }
        if (key === "illustrator") {
            return {
                key: "illustrator",
                label: "Illustrator",
                title: `Converted ${format || "file"} with Illustrator fallback`,
                mono: "Ai"
            };
        }
        if (key === "embeddedsvg") {
            return {
                key: "embedded",
                label: "Embedded SVG",
                title: "Read embedded SVG data",
                icon: "engine-embedded"
            };
        }
        if (key === "unknown") {
            return {
                key: "unknown",
                label: "Converted",
                title: "Converted with an older cached engine record",
                icon: "engine-unknown"
            };
        }
        if (format === "svg" || format === "svgz") {
            return {
                key: "svg",
                label: "SVG",
                title: "Read SVG directly",
                icon: "format-svg"
            };
        }
        return {
            key: "direct",
            label: format ? format.toUpperCase() : "Direct",
            title: "Read directly without conversion",
            icon: "engine-file"
        };
    };

    const makeConverterBadge = (doc) => {
        const info = converterInfo(doc);
        const badge = document.createElement("span");
        badge.className = classNames(
            "similar-engine",
            `similar-engine--${info.key}`
        );
        badge.title = info.title;
        const icon = document.createElement("span");
        if (info.mono) {
            icon.className = "similar-engine__mono";
            icon.textContent = info.mono;
        } else {
            icon.className = "svg-icon";
            icon.dataset.icon = info.icon;
        }
        icon.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.textContent = info.label;
        badge.appendChild(icon);
        badge.appendChild(label);
        if (window.dejavu && window.dejavu.injectSvgIcons) {
            window.dejavu.injectSvgIcons(badge);
        }
        return badge;
    };

    // Per-aspect contribution to the score. result.parts holds deltas
    // (0 = identical → 100% similar); we surface the most meaningful ones.
    const ASPECTS = [
        ["Shape", "geometryNormalized"],
        ["Geometry", "geometryRaw"],
        ["Structure", "structure"],
        ["Element mix", "elementTypes"],
        ["Fill colors", "fill"],
        ["Stroke colors", "stroke"],
        ["Bounds", "bbox"],
        ["Paths", "pathCommands"],
        ["Canvas", "canvas"]
    ];

    const aspectRow = (label, part) => {
        const clamped = Math.max(0, Math.min(1, Number(part) || 0));
        const sim = Math.round((1 - clamped) * 100);
        const row = document.createElement("div");
        row.className = "sim-aspect";
        const name = document.createElement("span");
        name.className = "sim-aspect__label";
        name.textContent = label;
        const track = document.createElement("span");
        track.className = "sim-aspect__track";
        const fill = document.createElement("span");
        fill.className = "sim-aspect__fill";
        fill.style.width = `${sim}%`;
        if (sim >= 80) fill.classList.add("is-high");
        else if (sim < 45) fill.classList.add("is-low");
        track.appendChild(fill);
        const val = document.createElement("span");
        val.className = "sim-aspect__val";
        val.textContent = `${sim}%`;
        row.appendChild(name);
        row.appendChild(track);
        row.appendChild(val);
        return row;
    };

    const makeRow = (result) => {
        const doc = (result.report && result.report.documents &&
            result.report.documents.b) || {};
        const counts = countsOf(result);
        const pct = Math.round((result.similarity || 0) * 100);

        const row = document.createElement("div");
        row.className = "similar-row";

        const head = document.createElement("div");
        head.className = "similar-row__head";

        const filePath = doc.path || result.filePath || "";
        const nm = document.createElement("span");
        nm.className = classNames(
            "similar-row__name",
            filePath && "similar-row__name--link",
            filePath && "file-link"
        );
        nm.textContent = doc.name || result.filePath || "Untitled";
        if (filePath) {
            nm.title =
                "Open in Illustrator  ·  Shift-click to reveal in Finder/Explorer";
            nm.addEventListener("click", (evt) => {
                evt.stopPropagation();
                if (evt.shiftKey) {
                    if (typeof revealPath === "function") revealPath(filePath);
                } else if (typeof callHost === "function") {
                    callHost("dejavu_openPath", [filePath]);
                }
            });
        } else {
            nm.title = doc.name || "";
        }

        const score = document.createElement("span");
        score.className = "similar-row__score";
        score.textContent = `${pct}%`;
        score.title = `delta ${Number(result.delta || 0).toFixed(3)}`;

        const date = document.createElement("span");
        date.className = "similar-row__date";
        if (doc.mtimeMs) {
            date.textContent = relAge(doc.mtimeMs);
            date.title = fullDate(doc.mtimeMs);
        } else {
            date.textContent = "—";
        }

        const top = document.createElement("div");
        top.className = "similar-row__top";
        top.appendChild(nm);
        top.appendChild(makeConverterBadge(doc));
        top.appendChild(date);
        top.appendChild(score);
        head.appendChild(top);

        // Always-visible match summary: common / changed / added / removed.
        const common = counts.similar + counts.changed;
        const mini = document.createElement("div");
        mini.className = "similar-row__mini";
        mini.appendChild(miniCount("similar", common, "common",
            "Elements present in both documents"));
        mini.appendChild(miniCount("changed", counts.changed, "changed",
            "Common elements that were modified"));
        mini.appendChild(miniCount("new", counts.added, "added",
            "Elements only in this file"));
        mini.appendChild(miniCount("removed", counts.removed, "removed",
            "Elements only in your document"));
        head.appendChild(mini);

        const detail = document.createElement("div");
        detail.className = "similar-row__detail";

        const em = (result.report && result.report.elementMatching) || {};
        const matched = counts.similar + counts.changed;
        const avgSim = em.avgMatchedSimilarity != null
            ? Math.round(em.avgMatchedSimilarity * 100)
            : null;

        // Quick element-count comparison + average match quality.
        const stats = document.createElement("div");
        stats.className = "similar-row__stats";
        if (em.totalA != null) {
            stats.appendChild(detailMetric("Source", `${em.totalA} elements`));
        }
        if (em.totalB != null) {
            stats.appendChild(detailMetric("Candidate", `${em.totalB} elements`));
        }
        if (matched) {
            stats.appendChild(detailMetric("Matched", `${matched} elements`));
        }
        if (avgSim != null && matched) {
            stats.appendChild(detailMetric("Match quality", `${avgSim}%`));
        }
        if (stats.children.length) {
            detail.appendChild(stats);
        }

        // Per-aspect similarity breakdown.
        if (result.parts) {
            const breakdown = document.createElement("div");
            breakdown.className = "sim-breakdown";
            ASPECTS.forEach((aspect) => {
                if (result.parts[aspect[1]] == null) return;
                breakdown.appendChild(
                    aspectRow(aspect[0], result.parts[aspect[1]]));
            });
            if (breakdown.children.length) detail.appendChild(breakdown);
        }

        const meta = document.createElement("div");
        meta.className = "similar-row__meta";
        const bits = [];
        if (doc.mtimeMs) bits.push(`Modified ${fullDate(doc.mtimeMs)}`);
        if (doc.sizeBytes) bits.push(fmtBytes(doc.sizeBytes));
        if (doc.converter && doc.converter !== "direct") {
            bits.push(`Converted by ${converterInfo(doc).label}`);
        }
        if (doc.conversionPlan && doc.conversionPlan.length > 1) {
            bits.push(`Tried ${doc.conversionPlan.join(" → ")}`);
        }
        if (doc.elementCount != null) bits.push(`${doc.elementCount} elements`);
        meta.textContent = bits.join("  ·  ");
        detail.appendChild(meta);

        row.appendChild(head);
        row.appendChild(detail);
        return row;
    };

    // Modified-date window for the results filter.
    const rangeMatches = (ms, range) => {
        range = String(range || "all");
        if (range === "all") return true;
        if (!ms) return false;
        const now = Date.now();
        if (range === "today") {
            const start = new Date(now);
            start.setHours(0, 0, 0, 0);
            return ms >= start.getTime();
        }
        const days = parseInt(range, 10) || 0;
        if (!days) return true;
        return ms >= now - days * 86400000;
    };

    const render = () => {
        if (!ui.list) return;
        const filter = ((ui.filter && ui.filter.value) || "").toLowerCase();
        const sort = (ui.sort && ui.sort.value) || "similar";
        const range = (ui.range && ui.range.value) || "all";
        const docOf = (r) => (r.report && r.report.documents &&
            r.report.documents.b) || {};
        const visible = sortResults(results, sort).filter((r) => {
            const doc = docOf(r);
            if (filter) {
                const nm = String(doc.name || r.filePath || "").toLowerCase();
                if (!nm.includes(filter)) return false;
            }
            return rangeMatches(doc.mtimeMs, range);
        });
        ui.list.innerHTML = "";
        if (ui.count) ui.count.textContent = String(results.length);
        if (!visible.length) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = results.length
                ? "No results match the current filters."
                : "Pick a folder and click “Find similar”.";
            ui.list.appendChild(empty);
            if (window.DejaVuTable) {
                window.DejaVuTable.syncEmptyToggles(
                    ui.list,
                    document.getElementById("similarityToggles")
                );
            }
            return;
        }
        const frag = document.createDocumentFragment();
        visible.forEach((r) => frag.appendChild(makeRow(r)));
        ui.list.appendChild(frag);
        if (window.DejaVuTable) {
            window.DejaVuTable.syncEmptyToggles(
                ui.list,
                document.getElementById("similarityToggles")
            );
        }
    };

    // ---- run --------------------------------------------------------------
    const run = () => {
        if (busy) return;
        if (typeof SVGSimilarityIndex === "undefined") {
            setHint("Similarity engine not loaded.", "warn");
            return;
        }
        const value = (ui.folder && ui.folder.value) || "";
        if (!value.trim()) {
            setHint("Choose a folder to search.", "warn");
            return;
        }
        let folder = value;
        try {
            folder = resolveTildePath(value);
        } catch (e) {}

        const recursive = !!(ui.recursive && ui.recursive.checked);
        const config = buildConfig();
        config.index = config.index || {};
        config.index.recursive = recursive;

        busy = true;
        updateRunEnabled();
        setHint("Scanning for similar files…");
        resetProgress(false);
        updateProgress({ stage: "listing", done: 0, total: 0 });

        let index;
        try {
            index = new SVGSimilarityIndex({
                config,
                onProgress: (p) => {
                    if (p && p.stage === "listed") {
                        setHint(`Comparing ${p.total} files…`);
                    }
                    updateProgress(p);
                }
            });
        } catch (e) {
            busy = false;
            updateRunEnabled();
            setHint(`Similarity failed: ${e.message || e}`, "warn");
            return;
        }

        const startScan = () => {
            Promise.resolve(
                index.findSimilarToCurrentIllustratorDocument(folder, { recursive })
            ).then((list) => {
                results = Array.isArray(list) ? list : [];
                render();
                setHint(
                    results.length
                        ? `Found ${results.length} candidate${results.length === 1 ? "" : "s"}.`
                        : "No comparable files found in that folder.",
                    "ok"
                );
                updateProgress({ stage: "done", done: 1, total: 1 });
            }).catch((err) => {
                setHint(
                    `Similarity failed: ${(err && err.message) ? err.message : err}`,
                    "warn"
                );
            }).then(() => {
                busy = false;
                window.setTimeout(() => resetProgress(true), 450);
                updateRunEnabled();
            });
        };

        if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(() => window.setTimeout(startScan, 0));
        } else {
            window.setTimeout(startScan, 0);
        }
    };

    // Compact (graphs hidden) vs extended (graphs shown for every row).
    const setView = (extended) => {
        if (ui.list) ui.list.classList.toggle("is-extended", !!extended);
        if (ui.compact) {
            const label = extended ? "Hide match graphs" : "Show match graphs";
            if (typeof setToggleIcon === "function") {
                setToggleIcon(ui.compact, !!extended);
            } else {
                ui.compact.setAttribute(
                    "aria-pressed", extended ? "true" : "false");
                ui.compact.classList.toggle("is-on", !!extended);
            }
            ui.compact.title = label;
            ui.compact.setAttribute("aria-label", label);
            ui.compact.setAttribute("data-tooltip", label);
        }
        if (typeof schedulePanelAutoSize === "function") {
            schedulePanelAutoSize();
        }
    };

    // ---- init -------------------------------------------------------------
    const init = () => {
        ui.folder = document.getElementById("similarityFolderInput");
        ui.field = document.getElementById("similarityFolderField");
        ui.validity = document.getElementById("similarityFolderValidity");
        ui.browse = document.getElementById("similarityBrowseBtn");
        ui.recursive = document.getElementById("similarityRecursive");
        ui.run = document.getElementById("similarityRunBtn");
        ui.settings = document.getElementById("comparisonSettings");
        ui.indexSettings = document.getElementById("similarityIndexControls");
        ui.filter = document.getElementById("similarityFilterInput");
        ui.sort = document.getElementById("similaritySortSelect");
        ui.range = document.getElementById("similarityRangeSelect");
        ui.list = document.getElementById("similarityList");
        ui.count = document.getElementById("similarityCount");
        ui.compact = document.getElementById("similarityCompactToggle");
        ui.progress = document.getElementById("similarityProgress");
        ui.progressLabel = document.getElementById("similarityProgressLabel");
        ui.progressCount = document.getElementById("similarityProgressCount");
        ui.progressBar = document.getElementById("similarityProgressBar");
        ui.progressTrack = ui.progress
            ? ui.progress.querySelector(".similar-progress__track")
            : null;
        if (!ui.folder || !ui.run) return;

        // Restore persisted state.
        ui.folder.value = window.localStorage.getItem(LS_FOLDER) || "~/";
        ui.recursive.checked = readJson(LS_RECURSIVE, false) === true;
        const savedSort = window.localStorage.getItem(LS_SORT);
        if (savedSort && ui.sort) ui.sort.value = savedSort;
        const savedRange = window.localStorage.getItem(LS_RANGE);
        if (savedRange && ui.range) ui.range.value = savedRange;

        validateFolder();
        renderSettings();
        if (typeof window.dejavuEnhanceSelects === "function" && ui.indexSettings) {
            window.dejavuEnhanceSelects(ui.indexSettings);
        }
        setView(window.localStorage.getItem(LS_VIEW) === "extended");
        if (window.DejaVuTable) {
            window.DejaVuTable.syncEmptyToggles(
                ui.list,
                document.getElementById("similarityToggles")
            );
        }

        ui.folder.addEventListener("input", () => {
            window.localStorage.setItem(LS_FOLDER, ui.folder.value);
            validateFolder();
        });
        ui.recursive.addEventListener("change", () => {
            writeJson(LS_RECURSIVE, !!ui.recursive.checked);
        });
        if (ui.browse) {
            ui.browse.addEventListener("click", () => {
                const current = (ui.folder && ui.folder.value) || "";
                Promise.resolve(callHost("dejavu_chooseFolder", [current]))
                    .then((r) => {
                        if (r && r.ok && isValidFolderValue(r.path)) {
                            ui.folder.value = r.path;
                            window.localStorage.setItem(LS_FOLDER, r.path);
                            validateFolder();
                        }
                    });
            });
        }
        ui.run.addEventListener("click", run);
        if (ui.filter) {
            let filterTimer = null;
            ui.filter.addEventListener("input", () => {
                if (filterTimer) window.clearTimeout(filterTimer);
                filterTimer = window.setTimeout(render, 140);
            });
        }
        if (ui.compact) {
            ui.compact.addEventListener("click", () => {
                const next = !(ui.list &&
                    ui.list.classList.contains("is-extended"));
                window.localStorage.setItem(
                    LS_VIEW, next ? "extended" : "compact");
                setView(next);
            });
        }
        if (ui.sort) {
            ui.sort.addEventListener("change", () => {
                window.localStorage.setItem(LS_SORT, ui.sort.value);
                render();
            });
        }
        if (ui.range) {
            ui.range.addEventListener("change", () => {
                window.localStorage.setItem(LS_RANGE, ui.range.value);
                render();
            });
        }
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
