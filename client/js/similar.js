/*
 * DejaVu — Similarity drawer controller.
 *
 * Wraps the bundled SVG similarity engine (../similarity/js/*) in a panel
 * drawer: pick a folder (validated like the save-folder field), optionally
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

    const ui = {};
    let results = [];
    let okHideTimer = null;
    let busy = false;
    let folderValid = false;

    // Collapse any open multi-select dropdown.
    const closeAllMultiselects = () => {
        const root = ui.settings || document;
        root.querySelectorAll(".ms.is-open").forEach((ms) => {
            ms.classList.remove("is-open");
            const menu = ms.querySelector(".ms__menu");
            const trigger = ms.querySelector(".ms__trigger");
            if (menu) menu.hidden = true;
            if (trigger) trigger.setAttribute("aria-expanded", "false");
        });
    };

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
        ui.validity.className = `folder-validity ${cls}`;
        ui.validity.title = title || "";
        if (ui.field) {
            ui.field.className =
                `folder-field ${cls.replace("folder-validity--", "folder-field--")}`;
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
            key: "index",
            label: "Scanning",
            hint: "Which files are scanned and how the scan is paced."
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
        },
        {
            key: "ui",
            label: "Engine report",
            hint: "Flags passed to the engine’s own report — this panel renders its own view."
        }
    ];

    // Settings handled elsewhere in the UI, so they are hidden from the form.
    const SKIP = new Set(["index.recursive"]);

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
        "engine.includeHidden": {
            label: "Include hidden elements",
            hint: "Also compare elements that are hidden in the artwork."
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

        "index.externalConverters.enabled": {
            label: "Use external converters",
            hint: "Let Inkscape / MuPDF / Ghostscript / Illustrator read non-SVG files."
        },
        "index.externalConverters.prefer": {
            label: "Converter order",
            hint: "Converters are tried in this order. Drag to reorder; add or remove from the fixed set."
        },
        "index.externalConverters.inkscapePath": {
            label: "Inkscape path",
            hint: "Command or full path to the Inkscape executable."
        },
        "index.externalConverters.mutoolPath": {
            label: "MuPDF (mutool) path",
            hint: "Command or full path to the mutool executable."
        },
        "index.externalConverters.ghostscriptPath": {
            label: "Ghostscript path",
            hint: "Command or full path to the Ghostscript executable."
        },
        "index.externalConverters.allowIllustratorFallback": {
            label: "Allow Illustrator fallback",
            hint: "Use Illustrator to convert when the other converters fail."
        },
        "index.externalConverters.avoidIllustrator": {
            label: "Avoid Illustrator",
            hint: "Never use Illustrator for conversion, even as a fallback."
        },
        "index.externalConverters.tryMutoolForEPS": {
            label: "Use mutool for EPS",
            hint: "Try mutool when converting EPS files."
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
            ["embeddedSVG", "mutool", "inkscape", "ghostscript", "illustrator"]
    };

    // Settings that are only meaningful while another (boolean) setting is on.
    // When the controller is off, the dependents are disabled.
    const DEPENDS = {
        "index.externalConverters.prefer":
            "index.externalConverters.enabled",
        "index.externalConverters.inkscapePath":
            "index.externalConverters.enabled",
        "index.externalConverters.mutoolPath":
            "index.externalConverters.enabled",
        "index.externalConverters.ghostscriptPath":
            "index.externalConverters.enabled",
        "index.externalConverters.allowIllustratorFallback":
            "index.externalConverters.enabled",
        "index.externalConverters.avoidIllustrator":
            "index.externalConverters.enabled",
        "index.externalConverters.tryMutoolForEPS":
            "index.externalConverters.enabled"
    };
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
        return (typeof SVGSimilarityConfig !== "undefined")
            ? SVGSimilarityConfig.fromObject(mergeDeep(base, overrides()))
            : base;
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

    const tooltipFor = (path, def) => {
        const shown = Array.isArray(def)
            ? def.join(", ")
            : def == null ? "—" : String(def);
        return `${path}  ·  default: ${shown}`;
    };

    const addHint = (section, hint) => {
        if (!hint) return;
        const p = document.createElement("p");
        p.className = "field-hint";
        p.textContent = hint;
        section.appendChild(p);
    };

    // Boolean → an Advanced-style checkbox row with a support hint.
    const makeBoolRow = (path, label, hint, value, tip) => {
        const section = document.createElement("section");
        section.className =
            "field-group field-group--embedded field-group--row similar-cfg__field";
        const lab = document.createElement("label");
        lab.className = "checkbox";
        lab.setAttribute("data-tooltip", tip);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!value;
        input.addEventListener("change",
            () => onSettingChange(path, input.checked, "boolean"));
        const span = document.createElement("span");
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
        span.textContent = label;
        lab.appendChild(span);
        return lab;
    };

    const valueRowSection = () => {
        const section = document.createElement("section");
        section.className =
            "field-group field-group--embedded similar-cfg__field";
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

    const NS_SVG = "http://www.w3.org/2000/svg";
    const spinChevron = (action) => {
        const svg = document.createElementNS(NS_SVG, "svg");
        svg.setAttribute("class", "spin-chevron");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2.5");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(NS_SVG, "path");
        path.setAttribute("d",
            action === "up" ? "M2 10l6-4 6 4" : "M2 6l6 4 6-4");
        svg.appendChild(path);
        return svg;
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

    // ---- multi-select dropdown (known option sets) ------------------------
    const summarize = (picked, options) => {
        if (!picked.length) return "None selected";
        if (picked.length === options.length) return `All (${options.length})`;
        if (picked.length <= 2) return picked.join(", ");
        return `${picked.slice(0, 2).join(", ")} +${picked.length - 2}`;
    };

    const makeMultiRow = (path, label, hint, value, tip, options) => {
        const section = valueRowSection();
        const lab = fieldLabel(label, tip);

        // Canonical options first, then any custom values already saved.
        const opts = options.slice();
        (value || []).forEach((v) => {
            if (opts.indexOf(v) < 0) opts.push(v);
        });
        const selected = new Set(value || []);

        const ms = document.createElement("div");
        ms.className = "ms";

        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "ms__trigger";
        trigger.setAttribute("aria-expanded", "false");
        const summary = document.createElement("span");
        summary.className = "ms__summary";
        const chev = document.createElement("span");
        chev.className = "ms__chev";
        chev.innerHTML = "<svg viewBox=\"0 0 16 16\" fill=\"none\" " +
            "stroke=\"currentColor\" stroke-width=\"2.5\" " +
            "stroke-linecap=\"round\" stroke-linejoin=\"round\">" +
            "<path d=\"M2 6l6 4 6-4\"/></svg>";
        trigger.appendChild(summary);
        trigger.appendChild(chev);

        const menu = document.createElement("div");
        menu.className = "ms__menu";
        menu.hidden = true;

        const refresh = () => {
            summary.textContent =
                summarize(opts.filter((o) => selected.has(o)), opts);
        };

        opts.forEach((opt) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "select-menu__item";
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(selected.has(opt)));
            const check = document.createElement("span");
            check.className = "select-menu__check";
            check.setAttribute("aria-hidden", "true");
            const label = document.createElement("span");
            label.className = "select-menu__label";
            label.textContent = opt;
            item.appendChild(check);
            item.appendChild(label);
            item.addEventListener("click", () => {
                if (selected.has(opt)) selected.delete(opt);
                else selected.add(opt);
                item.setAttribute("aria-selected", String(selected.has(opt)));
                refresh();
                onSettingChange(
                    path, opts.filter((o) => selected.has(o)), "array");
            });
            menu.appendChild(item);
        });

        trigger.addEventListener("click", () => {
            if (trigger.disabled) return;
            const open = menu.hidden;
            closeAllMultiselects();
            menu.hidden = !open;
            ms.classList.toggle("is-open", open);
            trigger.setAttribute("aria-expanded", open ? "true" : "false");
        });

        refresh();
        ms.appendChild(trigger);
        ms.appendChild(menu);
        lab.appendChild(ms);
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
    const unitById = (id) => BYTE_UNITS.filter((u) => u.id === id)[0] || null;
    const bestByteUnit = (bytes) => {
        for (let i = BYTE_UNITS.length - 1; i >= 0; i--) {
            if (bytes >= BYTE_UNITS[i].factor) return BYTE_UNITS[i];
        }
        return BYTE_UNITS[1];
    };

    const makeByteSizeRow = (path, label, hint, value, tip) => {
        const section = valueRowSection();
        const lab = fieldLabel(label, tip);
        let unit = unitById(window.localStorage.getItem(LS_SIZE_UNIT)) ||
            bestByteUnit(Number(value) || 0);

        const wrap = document.createElement("div");
        wrap.className = "bytesize";

        const built = makeSpinbox(
            trimNum((Number(value) || 0) / unit.factor), { min: 0, step: 1 });
        const input = built.input;

        const sel = document.createElement("select");
        sel.className = "unit-select";
        BYTE_UNITS.forEach((u) => {
            const o = document.createElement("option");
            o.value = u.id;
            o.textContent = u.id;
            if (u.id === unit.id) o.selected = true;
            sel.appendChild(o);
        });

        input.addEventListener("change", () => {
            const bytes = Math.round(
                (parseFloat(input.value) || 0) * unit.factor);
            onSettingChange(path, bytes, "number");
        });
        sel.addEventListener("change", () => {
            // Switching units converts the displayed number; the stored
            // byte value is unchanged.
            const bytes = (parseFloat(input.value) || 0) * unit.factor;
            unit = unitById(sel.value) || unit;
            window.localStorage.setItem(LS_SIZE_UNIT, unit.id);
            input.value = String(trimNum(bytes / unit.factor));
        });

        wrap.appendChild(built.group);
        wrap.appendChild(sel);
        lab.appendChild(wrap);
        section.appendChild(lab);
        addHint(section, hint);
        return section;
    };

    // ---- token / chip editors --------------------------------------------
    // opts: { fixed: string[]|null, reorder: bool, allowFinder: bool }
    //   fixed  → only these values (add from remaining, no free typing)
    //   null   → free text + an "Add folder…" picker
    const makeTokenRow = (path, label, hint, value, tip, opts) => {
        opts = opts || {};
        const fixed = opts.fixed || null;
        const reorder = !!opts.reorder;
        const section = valueRowSection();
        const lab = fieldLabel(label, tip);

        let tokens = (value || []).slice();
        let dragIndex = -1;
        let refreshAdd = () => {};
        const persist = () => onSettingChange(path, tokens.slice(), "array");

        const tok = document.createElement("div");
        tok.className = "tok";
        const chips = document.createElement("div");
        chips.className = "tok__chips";

        let textInput = null;
        if (!fixed) {
            textInput = document.createElement("input");
            textInput.type = "text";
            textInput.className = "tok__input";
            textInput.placeholder = "Type a name, Enter to add…";
        }

        const addToken = (raw) => {
            const v = String(raw || "").trim();
            if (!v) return;
            if (fixed && fixed.indexOf(v) < 0) return;
            if (tokens.indexOf(v) >= 0) return;
            tokens.push(v);
            renderChips();
            refreshAdd();
            persist();
        };

        function renderChips() {
            chips.innerHTML = "";
            tokens.forEach((t, i) => {
                const chip = document.createElement("span");
                chip.className = "template-token tok__chip";
                if (reorder) {
                    chip.draggable = true;
                    chip.classList.add("tok__chip--draggable");
                    chip.addEventListener("dragstart", (e) => {
                        dragIndex = i;
                        chip.classList.add("is-dragging");
                        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                    });
                    chip.addEventListener("dragend", () => {
                        dragIndex = -1;
                        chip.classList.remove("is-dragging");
                    });
                    chip.addEventListener("dragover", (e) => {
                        e.preventDefault();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                    });
                    chip.addEventListener("drop", (e) => {
                        e.preventDefault();
                        if (dragIndex < 0 || dragIndex === i) return;
                        const moved = tokens.splice(dragIndex, 1)[0];
                        tokens.splice(i, 0, moved);
                        dragIndex = -1;
                        renderChips();
                        persist();
                    });
                }
                const text = document.createElement("span");
                text.className = "template-token__label";
                text.textContent = t;
                chip.appendChild(text);
                const rm = document.createElement("button");
                rm.type = "button";
                rm.className = "template-token__remove";
                rm.textContent = "×";
                rm.title = "Remove";
                rm.addEventListener("click", () => {
                    tokens = tokens.filter((x) => x !== t);
                    renderChips();
                    refreshAdd();
                    persist();
                });
                chip.appendChild(rm);
                chips.appendChild(chip);
            });
            if (textInput) chips.appendChild(textInput);
        }

        if (textInput) {
            textInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addToken(textInput.value);
                    textInput.value = "";
                } else if (e.key === "Backspace" && !textInput.value &&
                    tokens.length) {
                    tokens.pop();
                    renderChips();
                    persist();
                    const again = chips.querySelector(".tok__input");
                    if (again) again.focus();
                }
            });
            textInput.addEventListener("blur", () => {
                if (textInput.value.trim()) {
                    addToken(textInput.value);
                    textInput.value = "";
                }
            });
        }

        const addRow = document.createElement("div");
        addRow.className = "tok__add-row";
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "btn btn--ghost btn--micro tok__add";
        let addMenu = null;

        if (fixed) {
            addBtn.textContent = "Add…";
            addMenu = document.createElement("div");
            addMenu.className = "ms__menu tok__add-menu";
            addMenu.hidden = true;
            refreshAdd = () => {
                const remaining = fixed.filter((f) => tokens.indexOf(f) < 0);
                addBtn.disabled = remaining.length === 0;
                addMenu.innerHTML = "";
                remaining.forEach((opt) => {
                    const item = document.createElement("button");
                    item.type = "button";
                    item.className = "select-menu__item";
                    item.setAttribute("role", "option");
                    const sp = document.createElement("span");
                    sp.className = "select-menu__check";
                    const lb = document.createElement("span");
                    lb.className = "select-menu__label";
                    lb.textContent = opt;
                    item.appendChild(sp);
                    item.appendChild(lb);
                    item.addEventListener("click", () => {
                        addToken(opt);
                        addMenu.hidden = true;
                    });
                    addMenu.appendChild(item);
                });
            };
            addBtn.addEventListener("click", () => {
                if (addBtn.disabled || !addMenu.children.length) return;
                addMenu.hidden = !addMenu.hidden;
            });
        } else {
            addBtn.textContent = "Add folder…";
            addBtn.addEventListener("click", () => {
                Promise.resolve(callHost("dejavu_chooseFolder", [""]))
                    .then((r) => {
                        if (r && r.ok && r.path) addToken(r.path);
                    });
            });
        }

        addRow.appendChild(addBtn);
        if (addMenu) addRow.appendChild(addMenu);

        renderChips();
        refreshAdd();
        tok.appendChild(chips);
        tok.appendChild(addRow);
        lab.appendChild(tok);
        section.appendChild(lab);
        addHint(section, hint);
        return section;
    };

    // Disable rows whose controlling checkbox is off (e.g. converter
    // options when "Use external converters" is unchecked).
    const applyDependencies = () => {
        if (!ui.settings) return;
        const cfg = buildConfig();
        ui.settings.querySelectorAll("[data-dep-on]").forEach((section) => {
            const on = !!getPath(cfg, section.getAttribute("data-dep-on"));
            section.classList.toggle("is-disabled", !on);
            section.querySelectorAll("input, button").forEach((ctl) => {
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
            group.className = "similar-cfg__group";
            const title = document.createElement("div");
            title.className = "similar-cfg__group-title";
            title.textContent = section.label;
            group.appendChild(title);
            if (section.hint) {
                const gh = document.createElement("p");
                gh.className = "similar-cfg__group-hint";
                gh.textContent = section.hint;
                group.appendChild(gh);
            }
            const isWeights = section.key === "engine.weights";
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
                    hint = `Relative weight of ${meta.label.toLowerCase()} ` +
                        `in the similarity score.`;
                }
                const tip = tooltipFor(path, getPath(defs, path));
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
                    row = makeMultiRow(
                        path, meta.label, hint, v, tip, OPTIONS[path]);
                } else {
                    row = makeValueRow(
                        path, meta.label, hint, v, tip, section.key);
                }
                row.dataset.path = path;
                if (DEPENDS[path]) row.dataset.depOn = DEPENDS[path];
                group.appendChild(row);
            });
            ui.settings.appendChild(group);
        });
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
        span.className = `sim-pill sim-pill--${cls}`;
        span.innerHTML =
            `<strong>${n}</strong> ${label}`;
        return span;
    };

    const makeRow = (result) => {
        const doc = (result.report && result.report.documents &&
            result.report.documents.b) || {};
        const counts = countsOf(result);
        const pct = Math.round((result.similarity || 0) * 100);

        const row = document.createElement("div");
        row.className = "similar-row";

        const head = document.createElement("button");
        head.type = "button";
        head.className = "similar-row__head";
        head.setAttribute("aria-expanded", "false");

        const nm = document.createElement("span");
        nm.className = "similar-row__name";
        nm.textContent = doc.name || result.filePath || "Untitled";
        nm.title = doc.path || result.filePath || "";

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

        head.appendChild(nm);
        head.appendChild(score);
        head.appendChild(date);

        const detail = document.createElement("div");
        detail.className = "similar-row__detail";

        const pills = document.createElement("div");
        pills.className = "similar-row__counts";
        pills.appendChild(pill("similar", counts.similar, "similar"));
        pills.appendChild(pill("changed", counts.changed, "changed"));
        pills.appendChild(pill("new", counts.added, "new"));
        pills.appendChild(pill("removed", counts.removed, "removed"));
        detail.appendChild(pills);

        const meta = document.createElement("div");
        meta.className = "similar-row__meta";
        const bits = [];
        if (doc.mtimeMs) bits.push(`Modified ${fullDate(doc.mtimeMs)}`);
        if (doc.sizeBytes) bits.push(fmtBytes(doc.sizeBytes));
        if (doc.elementCount != null) bits.push(`${doc.elementCount} elements`);
        meta.textContent = bits.join("  ·  ");
        detail.appendChild(meta);

        if (doc.path) {
            const actions = document.createElement("div");
            actions.className = "similar-row__actions";
            const reveal = document.createElement("button");
            reveal.type = "button";
            reveal.className = "btn btn--ghost btn--micro";
            reveal.textContent = "Reveal";
            reveal.addEventListener("click", (evt) => {
                evt.stopPropagation();
                if (typeof revealPath === "function") revealPath(doc.path);
            });
            actions.appendChild(reveal);
            detail.appendChild(actions);
        }

        head.addEventListener("click", () => {
            const open = row.classList.toggle("is-expanded");
            head.setAttribute("aria-expanded", open ? "true" : "false");
        });

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
            return;
        }
        const frag = document.createDocumentFragment();
        visible.forEach((r) => frag.appendChild(makeRow(r)));
        ui.list.appendChild(frag);
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

        let index;
        try {
            index = new SVGSimilarityIndex({
                config,
                onProgress: (p) => {
                    if (p && p.stage === "listed") {
                        setHint(`Comparing ${p.total} files…`);
                    }
                }
            });
        } catch (e) {
            busy = false;
            updateRunEnabled();
            setHint(`Similarity failed: ${e.message || e}`, "warn");
            return;
        }

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
        }).catch((err) => {
            setHint(
                `Similarity failed: ${(err && err.message) ? err.message : err}`,
                "warn"
            );
        }).then(() => {
            busy = false;
            updateRunEnabled();
        });
    };

    // ---- init -------------------------------------------------------------
    const init = () => {
        ui.folder = document.getElementById("similarityFolderInput");
        ui.field = document.getElementById("similarityFolderField");
        ui.validity = document.getElementById("similarityFolderValidity");
        ui.browse = document.getElementById("similarityBrowseBtn");
        ui.recursive = document.getElementById("similarityRecursive");
        ui.run = document.getElementById("similarityRunBtn");
        ui.settings = document.getElementById("similaritySettings");
        ui.filter = document.getElementById("similarityFilterInput");
        ui.sort = document.getElementById("similaritySortSelect");
        ui.range = document.getElementById("similarityRangeSelect");
        ui.list = document.getElementById("similarityList");
        ui.count = document.getElementById("similarityCount");
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
        if (ui.filter) ui.filter.addEventListener("input", render);
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
        // Collapse open multi-selects / token "Add" menus on outside click.
        document.addEventListener("click", (evt) => {
            if (!evt.target.closest(".ms")) closeAllMultiselects();
            if (!evt.target.closest(".tok__add-row")) {
                (ui.settings || document)
                    .querySelectorAll(".tok__add-menu").forEach((m) => {
                        m.hidden = true;
                    });
            }
        });
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
