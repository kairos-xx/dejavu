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

    const ui = {};
    let results = [];
    let okHideTimer = null;
    let busy = false;

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
            return;
        }
        let exists = false;
        let resolved = value;
        try {
            const fs = require("fs");
            resolved = resolveTildePath(value);
            exists = fs.existsSync(resolved) &&
                fs.statSync(resolved).isDirectory();
        } catch (e) {
            exists = false;
        }
        if (exists) {
            setValidity("folder-validity--ok", `Folder exists · ${resolved}`);
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
        }
    };

    // ---- generic settings form, built from the engine defaults -----------
    const SECTIONS = [
        { key: "engine", label: "Engine" },
        { key: "engine.weights", label: "Comparison weights" },
        { key: "index", label: "Indexing" },
        { key: "index.externalConverters", label: "External converters" },
        { key: "thresholds", label: "Thresholds" },
        { key: "ui", label: "Display" }
    ];

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
            value = String(rawValue).split(",")
                .map((s) => s.trim()).filter(Boolean);
        }
        const ov = overrides();
        setPath(ov, path, value);
        writeJson(LS_CONFIG, ov);
    };

    const fieldRow = (path, label, value) => {
        const row = document.createElement("label");
        row.className = "similar-cfg__row";
        const name = document.createElement("span");
        name.className = "similar-cfg__label";
        name.textContent = label;
        row.appendChild(name);

        let input;
        let type;
        if (typeof value === "boolean") {
            type = "boolean";
            input = document.createElement("input");
            input.type = "checkbox";
            input.checked = value;
            input.className = "similar-cfg__check";
            input.addEventListener("change",
                () => onSettingChange(path, input.checked, type));
        } else if (typeof value === "number") {
            type = "number";
            input = document.createElement("input");
            input.type = "number";
            input.value = String(value);
            input.step = "any";
            input.className = "similar-cfg__input";
            input.addEventListener("change",
                () => onSettingChange(path, input.value, type));
        } else if (Array.isArray(value)) {
            type = "array";
            input = document.createElement("input");
            input.type = "text";
            input.value = value.join(", ");
            input.className = "similar-cfg__input";
            input.addEventListener("change",
                () => onSettingChange(path, input.value, type));
        } else {
            type = "string";
            input = document.createElement("input");
            input.type = "text";
            input.value = value == null ? "" : String(value);
            input.className = "similar-cfg__input";
            input.addEventListener("change",
                () => onSettingChange(path, input.value, type));
        }
        row.appendChild(input);
        return row;
    };

    const renderSettings = () => {
        if (!ui.settings) return;
        const cfg = buildConfig();
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
            Object.keys(node).forEach((k) => {
                const v = node[k];
                if (v && typeof v === "object" && !Array.isArray(v)) return;
                if (String(k).startsWith("$") || String(k).startsWith("_")) return;
                group.appendChild(fieldRow(`${section.key}.${k}`, k, v));
            });
            ui.settings.appendChild(group);
        });
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

    const render = () => {
        if (!ui.list) return;
        const filter = ((ui.filter && ui.filter.value) || "").toLowerCase();
        const sort = (ui.sort && ui.sort.value) || "similar";
        let visible = sortResults(results, sort);
        if (filter) {
            visible = visible.filter((r) => {
                const doc = (r.report && r.report.documents &&
                    r.report.documents.b) || {};
                return String(doc.name || r.filePath || "")
                    .toLowerCase().includes(filter);
            });
        }
        ui.list.innerHTML = "";
        if (ui.count) ui.count.textContent = String(results.length);
        if (!visible.length) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = results.length
                ? "No results match the filter."
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
        if (ui.run) ui.run.disabled = true;
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
            if (ui.run) ui.run.disabled = false;
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
            if (ui.run) ui.run.disabled = false;
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
        ui.list = document.getElementById("similarityList");
        ui.count = document.getElementById("similarityCount");
        if (!ui.folder || !ui.run) return;

        // Restore persisted state.
        ui.folder.value = window.localStorage.getItem(LS_FOLDER) || "~/";
        ui.recursive.checked = readJson(LS_RECURSIVE, false) === true;
        const savedSort = window.localStorage.getItem(LS_SORT);
        if (savedSort && ui.sort) ui.sort.value = savedSort;

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
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
