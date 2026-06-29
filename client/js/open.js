/**
 * DejaVu — split from the original client/js/main.js.
 *
 * This file preserves the original statements and function bodies;
 * it only moves them into a responsibility-focused script file.
 */
"use strict";

let openDocsTable = null;

/** Returns the shared table controller for the Open Documents panel. */
const getOpenDocsTable = () => {
    if (!openDocsTable && window.DejaVuTable) {
        openDocsTable = window.DejaVuTable.create({
            keyForItem: docKeyForListedDoc,
            getItems: () => state.openDocsCache,
            getSelectionStore: () => state.openDocsSelection,
            setSelectionStore: (store) => {
                state.openDocsSelection = store || {};
            },
            getBulkBar: () => el.openDocsBulkBar,
            getSelectionCountEl: () => el.openDocsSelectionCount,
            getSelectAllToggle: () => el.openDocsSelectAllToggle,
            getQuery: () => state.openDocsFilter || "",
            getRange: () => state.openDocsRange || "all",
            getSort: () => state.openDocsSort || "newest",
            textForItem: (doc) => [
                doc.name || "",
                doc.fullPath || ""
            ].join(" "),
            matchesRange: (doc, range) => {
                return openDocMatchesRange(doc, range);
            },
            matchesFilters: (doc) => {
                return !state.openDocsUnsavedOnly || doc.saved === false;
            },
            sorter: (a, b, sort) => {
                if (sort === "newest") return openDocOpenedAt(b) - openDocOpenedAt(a);
                if (sort === "oldest") return openDocOpenedAt(a) - openDocOpenedAt(b);
                if (sort === "name") {
                    const nameA = (a.name || "").toLowerCase();
                    const nameB = (b.name || "").toLowerCase();
                    if (nameA < nameB) return -1;
                    if (nameA > nameB) return 1;
                }
                return 0;
            },
            render: () => {
                renderOpenDocuments(state.openDocsCache);
            }
        });
    }
    return openDocsTable;
};

const docKeyForListedDoc = (doc) => {
    if (doc.hasPath && doc.fullPath) return `file:${String(doc.fullPath)}`;
    return `unsaved:${String(
        doc.documentSessionId || doc.name || doc.baseName || ""
    )}`;
};

const openDocSessionTimestamp = (doc) => {
    const match = String(doc && doc.documentSessionId || "").match(
        /^doc-(\d+)/
    );
    return match ? Number(match[1]) || 0 : 0;
};

const rememberOpenDocSeenTimes = (docs) => {
    if (!state.openDocsFirstSeen) state.openDocsFirstSeen = {};
    const now = Date.now();
    const openKeys = {};
    (docs || []).forEach((doc) => {
        const key = docKeyForListedDoc(doc);
        openKeys[key] = true;
        if (!state.openDocsFirstSeen[key]) {
            state.openDocsFirstSeen[key] =
                Number(doc.openedAt || doc.createdAt) ||
                openDocSessionTimestamp(doc) ||
                now;
        }
    });
    Object.keys(state.openDocsFirstSeen).forEach((key) => {
        if (!openKeys[key]) delete state.openDocsFirstSeen[key];
    });
};

const openDocOpenedAt = (doc) => {
    const key = docKeyForListedDoc(doc || {});
    return Number(
        (doc && (doc.openedAt || doc.createdAt)) ||
        (state.openDocsFirstSeen && state.openDocsFirstSeen[key]) ||
        openDocSessionTimestamp(doc) ||
        0
    ) || 0;
};

const openDocTimestamp = (...values) => {
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value == null || value === "" || value === true || value === false) {
            continue;
        }
        const direct = Number(value);
        if (direct > 100000000000) return direct;
        const parsed = Number(new Date(value).getTime()) || 0;
        if (parsed > 100000000000) return parsed;
    }
    return 0;
};

const openDocLastSavedAt = (doc) => {
    const key = docKeyForListedDoc(doc || {});
    const activeSavedAt = doc && doc.isActive && state.lastSavedAt
        ? Number(new Date(state.lastSavedAt).getTime()) || 0
        : 0;
    return openDocTimestamp(
        doc && (doc.diskModified || doc.fileModified || doc.modifiedOnDisk),
        doc && (doc.lastSaved || doc.savedAt || doc.modified),
        state.docLastSaved[key],
        activeSavedAt
    );
};

const openDocUnsavedStatusAt = (doc) => {
    const savedAt = openDocLastSavedAt(doc);
    if (savedAt) return savedAt;
    if (doc && (doc.hasPath || doc.fullPath)) return openDocOpenedAt(doc);
    return 0;
};

const openDocMatchesRange = (doc, range) => {
    range = String(range || "all");
    if (range === "all") return true;
    const openedAt = openDocOpenedAt(doc);
    if (!openedAt) return false;
    const now = Date.now();
    if (range === "today") {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        return openedAt >= start.getTime();
    }
    const days = range === "7d" ? 7 : 30;
    return openedAt >= now - days * 86400000;
};

/** True when dejavu is on for the given document key. */
const isDejavuOnForKey = (key) => {
    if (!key) return false;
    const overrides = state.settings.fileDejavuOverrides || {};
    const override = overrides[key] || "";
    if (override === "on") return true;
    if (override === "off") return false;
    return !!state.settings.enabledForAll;
};

/** Sets the per-document dejavu override (on/off) for a key. */
const setDejavuForKey = (key, on) => {
    if (!key) return;
    const overrides = state.settings.fileDejavuOverrides || {};
    overrides[key] = on ? "on" : "off";
    state.settings.fileDejavuOverrides = overrides;
    saveSettings();
    if (key === state.currentDocKey) {
        state.settings.enabled = isDejavuEnabledForCurrent();
        syncDejavuModeUi();
        syncDejavuLoop();
    }
};

/** True when the document for the given key is checked for bulk edit. */
const isOpenDocSelected = (key) => {
    const table = getOpenDocsTable();
    if (table) return table.isSelected(key);
    return !!(key && state.openDocsSelection[key]);
};

/** Marks/unmarks a document key in the bulk-edit selection. */
const setOpenDocSelected = (key, on) => {
    const table = getOpenDocsTable();
    if (table) {
        table.setSelected(key, on);
        return;
    }
    if (!key) return;
    if (on) state.openDocsSelection[key] = true;
    else delete state.openDocsSelection[key];
};

/** Clears the whole bulk-edit selection. */
const clearOpenDocsSelection = () => {
    const table = getOpenDocsTable();
    if (table) table.clearSelection();
    else state.openDocsSelection = {};
};

/** Document keys currently checked AND still open, in list order. */
const openDocsSelectedKeys = () => {
    const table = getOpenDocsTable();
    if (table) return table.selectedKeys();
    const keys = [];
    state.openDocsCache.forEach((doc) => {
        const key = docKeyForListedDoc(doc);
        if (isOpenDocSelected(key)) keys.push(key);
    });
    return keys;
};

/**
 * Selects/deselects every visible document between the previous
 * anchor and the given key (inclusive), for shift-click range edit.
 * @param {string} key Key of the just-clicked document.
 * @param {boolean} on Resulting checked state to apply across the range.
 * @return {boolean} True when a range was applied.
 */
const selectOpenDocRange = (key, on) => {
    const table = getOpenDocsTable();
    if (table) {
        const applied = table.selectRange(key, on, visibleOpenDocs());
        if (applied) {
            state.openDocsLastClickedKey = key;
            table.lastClickedKey = key;
            renderOpenDocuments(state.openDocsCache);
        }
        return applied;
    }
    const anchor = state.openDocsLastClickedKey;
    if (!anchor || anchor === key) return false;
    const visible = visibleOpenDocs();
    let lastIndex = -1;
    let curIndex = -1;
    visible.forEach((doc, i) => {
        const k = docKeyForListedDoc(doc);
        if (k === anchor) lastIndex = i;
        if (k === key) curIndex = i;
    });
    if (lastIndex === -1 || curIndex === -1) return false;
    const a = Math.min(lastIndex, curIndex);
    const b = Math.max(lastIndex, curIndex);
    for (let i = a; i <= b; i++) {
        setOpenDocSelected(docKeyForListedDoc(visible[i]), on);
    }
    state.openDocsLastClickedKey = key;
    renderOpenDocuments(state.openDocsCache);
    return true;
};

/** The cached documents matching the active filter, in list order. */
const visibleOpenDocs = () => {
    const table = getOpenDocsTable();
    if (table) return table.visibleItems();
    return state.openDocsCache.filter((doc) => {
        return (!state.openDocsUnsavedOnly || doc.saved === false) &&
            openDocMatchesRange(doc, state.openDocsRange || "all");
    });
};

const groupOpenDocsByOpenedTime = (items) => {
    return groupSnapshotsByDay((items || []).map((doc) => {
        return Object.assign({}, doc, {
            timestamp: openDocOpenedAt(doc)
        });
    }));
};

/** Sets a per-document dejavu override for several keys at once. */
const setDejavuForKeys = (keys, on) => {
    if (!keys || !keys.length) return;
    const overrides = state.settings.fileDejavuOverrides || {};
    keys.forEach((key) => {
        if (key) overrides[key] = on ? "on" : "off";
    });
    state.settings.fileDejavuOverrides = overrides;
    saveSettings();
    if (keys.indexOf(state.currentDocKey) !== -1) {
        state.settings.enabled = isDejavuEnabledForCurrent();
        syncDejavuModeUi();
        syncDejavuLoop();
    }
};

/** Refreshes the multi-document overview from the host. */
const refreshOpenDocuments = () => {
    if (!el.openDocsList) return Promise.resolve();
    return callHost("dejavu_listOpenDocuments", []).then((result) => {
        renderOpenDocuments(result && result.ok ? result.documents || [] : []);
    });
};

/** Shows/hides the bulk-edit bar and syncs its count + select-all icon. */
const syncOpenDocsBulkUi = () => {
    const table = getOpenDocsTable();
    if (table) {
        table.syncBulkBar();
        return;
    }
    const visible = visibleOpenDocs();
    const selectedCount = openDocsSelectedKeys().length;
    if (el.openDocsBulkBar) {
        el.openDocsBulkBar.hidden = selectedCount === 0;
    }
    if (el.openDocsSelectionCount) {
        el.openDocsSelectionCount.textContent = `${selectedCount} selected`;
    }
    if (el.openDocsSelectAllToggle) {
        const visibleSelectedCount = visible.filter((doc) => {
            return isOpenDocSelected(docKeyForListedDoc(doc));
        }).length;
        const allSelected = visible.length > 0 && visible.every((doc) => {
            return isOpenDocSelected(docKeyForListedDoc(doc));
        });
        const someSelected = visibleSelectedCount > 0 && !allSelected;
        if (someSelected && typeof setToggleIconMixed === "function") {
            setToggleIconMixed(el.openDocsSelectAllToggle, true);
        } else {
            setToggleIcon(el.openDocsSelectAllToggle, allSelected);
        }
    }
};

/** Renders one row per open document with its dejavu state + actions. */
const renderOpenDocuments = (docs) => {
    if (!el.openDocsList) return;
    document.querySelectorAll(".open-doc-menu[data-open-doc-menu='row']").forEach((menu) => {
        menu.remove();
    });
    state.openDocsCache = docs || [];
    rememberOpenDocSeenTimes(state.openDocsCache);
    state.openDocsCache.forEach((doc) => {
        pruneRecoveryCandidatesForSavedDocument(doc);
    });

    // Drop selection entries for documents that are no longer open.
    const openKeys = {};
    state.openDocsCache.forEach((doc) => {
        openKeys[docKeyForListedDoc(doc)] = true;
    });
    const table = getOpenDocsTable();
    if (table) table.pruneSelection(state.openDocsCache);
    else Object.keys(state.openDocsSelection).forEach((key) => {
        if (!openKeys[key]) delete state.openDocsSelection[key];
    });

    if (el.openDocsCount) {
        el.openDocsCount.textContent = String(state.openDocsCache.length);
    }

    const rows = visibleOpenDocs();
    el.openDocsList.innerHTML = "";
    if (!state.openDocsCache.length || !rows.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = state.openDocsCache.length
            ? "No documents with unsaved changes."
            : "No documents open.";
        el.openDocsList.appendChild(empty);
        syncOpenDocsBulkUi();
        return;
    }

    const fragment = document.createDocumentFragment();
    const groups = groupOpenDocsByOpenedTime(rows);
    groups.forEach((group) => {
        const section = document.createElement("div");
        section.className = "timeline-day open-docs__day";

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

        group.items.forEach((doc) => {
            section.appendChild(buildOpenDocRow(doc));
        });
        fragment.appendChild(section);
    });
    el.openDocsList.appendChild(fragment);
    syncOpenDocsBulkUi();
};

// External SVG icon classes for the per-row actions, in the same visual
// language as the toolbar icons.
const OPEN_DOC_ICONS = {
    power: "icon-power",
    save: "icon-save",
    unsaved: "icon-unsaved"
};

/** Creates a reusable inline SVG icon span. */
const makeSvgIcon = (iconClass) => {
    const icon = document.createElement("span");
    icon.className = DEJAVU.classNames("svg-icon", iconClass);
    icon.dataset.icon = iconClass.replace(/^icon-/, "");
    icon.setAttribute("aria-hidden", "true");
    if (window.dejavu && window.dejavu.injectIcon) {
        window.dejavu.injectIcon(icon);
    }
    return icon;
};

/**
 * Creates an icon action button for a document row.
 * @param {string} iconClass External SVG icon class for the glyph.
 * @param {string} title Tooltip + accessible label.
 * @param {string} extraClass Optional modifier class.
 * @return {HTMLButtonElement}
 */
const makeOpenDocAction = (iconClass, title, extraClass) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = DEJAVU.classNames("open-doc__action", extraClass);
    btn.title = title;
    btn.setAttribute("aria-label", title);
    const icon = document.createElement("span");
    icon.className = DEJAVU.classNames("svg-icon", iconClass);
    icon.dataset.icon = iconClass.replace(/^icon-/, "");
    icon.setAttribute("aria-hidden", "true");
    if (window.dejavu && window.dejavu.injectIcon) {
        window.dejavu.injectIcon(icon);
    }
    btn.appendChild(icon);
    return btn;
};

const closeOpenDocsActionMenus = () => {
    document.querySelectorAll(".open-doc-menu.is-open").forEach((menu) => {
        menu.classList.remove("is-open");
        menu.setAttribute("aria-hidden", "true");
    });
    document.querySelectorAll(".open-doc__action-arrow[aria-expanded='true']").forEach((btn) => {
        btn.setAttribute("aria-expanded", "false");
    });
    document.querySelectorAll(".open-doc__split-action.is-open").forEach((wrap) => {
        wrap.classList.remove("is-open");
    });
};

const makeOpenDocsMenu = (onSaveAndClose, kind) => {
    const menu = document.createElement("div");
    menu.className = "select-menu open-doc-menu";
    menu.dataset.openDocMenu = kind || "row";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-hidden", "true");
    const item = document.createElement("button");
    item.type = "button";
    item.className = "select-menu__item open-doc-menu__item";
    item.setAttribute("role", "menuitem");
    item.innerHTML = '<span class="select-menu__label">Save and close</span>';
    item.addEventListener("click", () => {
        closeOpenDocsActionMenus();
        onSaveAndClose();
    });
    menu.appendChild(item);
    return menu;
};

const positionOpenDocsMenu = (anchor, menu) => {
    const rect = anchor.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.minWidth = "";
    menu.style.width = "auto";
    const width = Math.ceil(
        menu.getBoundingClientRect().width ||
        menu.scrollWidth ||
        0
    );
    menu.style.left = `${Math.round(Math.min(
        Math.max(4, rect.left),
        window.innerWidth - width - 4
    ))}px`;
    const menuHeight = Math.min(menu.scrollHeight || 0, 240);
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    if (below >= menuHeight + 4 || below >= above) {
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    } else {
        menu.style.top = `${Math.round(Math.max(4, rect.top - menuHeight - 4))}px`;
    }
};

const makeSaveSplitAction = (title, onSave, onSaveAndClose) => {
    const wrap = document.createElement("div");
    wrap.className = "open-doc__split-action";

    const saveBtn = makeOpenDocAction(
        OPEN_DOC_ICONS.save,
        title,
        "open-doc__action--save"
    );
    saveBtn.addEventListener("click", onSave);
    wrap.appendChild(saveBtn);

    const arrowBtn = document.createElement("button");
    arrowBtn.type = "button";
    arrowBtn.className = "open-doc__action-arrow";
    arrowBtn.setAttribute("aria-label", "Save and close");
    arrowBtn.setAttribute("aria-expanded", "false");
    arrowBtn.innerHTML =
        '<span class="select-chevron open-doc__chevron" ' +
        'data-icon="chevron-down" aria-hidden="true"></span>';
    wrap.appendChild(arrowBtn);
    if (window.dejavu && window.dejavu.injectSvgIcons) {
        window.dejavu.injectSvgIcons(arrowBtn);
    }

    const menu = makeOpenDocsMenu(onSaveAndClose, "row");
    wrap.appendChild(menu);
    arrowBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const isOpen = menu.getAttribute("aria-hidden") === "false";
        closeOpenDocsActionMenus();
        if (!isOpen) {
            menu.classList.add("is-open");
            wrap.classList.add("is-open");
            menu.setAttribute("aria-hidden", "false");
            arrowBtn.setAttribute("aria-expanded", "true");
            menu.style.left = "0";
            menu.style.top = "0";
            positionOpenDocsMenu(wrap, menu);
            return;
        }
        menu.setAttribute("aria-hidden", "true");
        arrowBtn.setAttribute("aria-expanded", "false");
    });
    return wrap;
};

const selectedOpenDocs = () => {
    const keys = openDocsSelectedKeys();
    return state.openDocsCache.filter((doc) => {
        return keys.indexOf(docKeyForListedDoc(doc)) !== -1;
    });
};

const bindOpenDocsGlobalMenuClose = () => {
    if (state.openDocsMenuCloseBound) return;
    state.openDocsMenuCloseBound = true;
    document.addEventListener("click", (evt) => {
        if (!evt.target.closest(".open-doc__split-action")) {
            closeOpenDocsActionMenus();
        }
    });
    document.addEventListener("keydown", (evt) => {
        if (evt.key === "Escape") closeOpenDocsActionMenus();
    });
};

/** Builds a single document row element. */
const buildOpenDocRow = (doc) => {
    const key = docKeyForListedDoc(doc);
    const on = isDejavuOnForKey(key);

    const row = document.createElement("div");
    row.className = DEJAVU.classNames(
        "open-doc",
        doc.isActive && "open-doc--active",
        isOpenDocSelected(key) && "open-doc--selected"
    );

    // Left state slot: aligned with the Timeline / Recovery pin circles.
    // Unsaved documents show the unsaved glyph here; saved documents keep
    // an invisible placeholder so names still line up.
    const dot = document.createElement("span");
    dot.className = DEJAVU.classNames(
        "open-doc__dot",
        doc.saved === false && "open-doc__dot--unsaved"
    );
    dot.setAttribute("aria-hidden", "true");
    dot.appendChild(makeSvgIcon(OPEN_DOC_ICONS.unsaved));
    if (doc.saved === false) {
        dot.title = "Unsaved changes";
    }
    row.appendChild(dot);

    const main = document.createElement("div");
    main.className = "open-doc__main";

    const nameRow = document.createElement("div");
    nameRow.className = "open-doc__name-row";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "open-doc__name";
    name.textContent = doc.name;
    name.title = doc.hasPath
        ? `${doc.fullPath}  ·  Shift-click to reveal in Finder`
        : "Unsaved document";
    name.addEventListener("click", (evt) => {
        if (evt.shiftKey) {
            evt.preventDefault();
            const revealTarget = doc.fullPath ||
                doc.path ||
                doc.filePath ||
                doc.savedPath ||
                "";
            if (revealTarget) {
                revealPath(revealTarget);
            } else {
                setHint("This document has not been saved to disk yet.", "warn");
            }
            return;
        }
        activateDoc(doc.documentSessionId).then((r) => {
            if (r && r.ok) refreshDocStatus();
            else if (r && r.error) setHint(r.error, "warn");
            refreshOpenDocuments();
        });
    });
    nameRow.appendChild(name);

    if (doc.isActive) {
        const pill = document.createElement("span");
        pill.className = "open-doc__pill";
        pill.textContent = "active";
        nameRow.appendChild(pill);
    }
    const lastTs = openDocUnsavedStatusAt(doc);
    if (doc.saved === false) {
        const timeContainer = document.createElement("div");
        timeContainer.className = "snapshot__time-container";
        const rel = document.createElement("span");
        rel.className = "snapshot__rel open-doc__rel";
        rel.textContent = lastTs ? formatRelativeTime(lastTs) : "NEVER SAVED";
        rel.title = lastTs
            ? "Time since the last saved file version on disk"
            : "This document has never been saved";
        timeContainer.appendChild(rel);
        nameRow.appendChild(timeContainer);
    }
    main.appendChild(nameRow);
    row.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "open-doc__actions";

    const toggleBtn = makeOpenDocAction(
        OPEN_DOC_ICONS.power,
        on ? "Dejavu is on — click to turn off"
            : "Dejavu is off — click to turn on",
        `open-doc__action--toggle${(on ? " open-doc__action--on" : "")}`
    );
    toggleBtn.setAttribute("aria-pressed", on ? "true" : "false");
    toggleBtn.addEventListener("click", () => {
        setDejavuForKey(key, !on);
        refreshOpenDocuments();
    });
    actions.appendChild(toggleBtn);

    actions.appendChild(makeSaveSplitAction(
        "Save this document now",
        () => { saveOpenDocs([doc]); },
        () => { saveOpenDocs([doc], { closeAfter: true }); }
    ));

    row.appendChild(actions);

    // Rounded selection control at the right edge (order:10), matching
    // the Timeline / Recovery Center tables.
    const selectLabel = document.createElement("label");
    selectLabel.className = "open-doc__select";
    const selectInput = document.createElement("input");
    selectInput.type = "checkbox";
    selectInput.checked = isOpenDocSelected(key);
    selectInput.setAttribute("aria-label", `Select ${doc.name}`);
    selectInput.title = "Select for bulk edit (shift-click for a range)";
    selectInput.addEventListener("click", (evt) => {
        const newState = selectInput.checked;
        if (evt.shiftKey && selectOpenDocRange(key, newState)) return;
        setOpenDocSelected(key, newState);
        row.classList.toggle("open-doc--selected", newState);
        state.openDocsLastClickedKey = key;
        syncOpenDocsBulkUi();
    });
    selectLabel.appendChild(selectInput);
    row.appendChild(selectLabel);

    return row;
};

/** Activates a document by its host session id. */
const activateDoc = (sessionId) => {
    return callHost("dejavu_activateDocument", [sessionId]);
};

/** Closes a document by its host session id. */
const closeDoc = (sessionId) => {
    return callHost("dejavu_closeDocument", [sessionId]);
};

/**
 * Saves a list of open documents one at a time (each must be the
 * active document to be saved), restoring the originally-active
 * document afterwards. Used by per-row Save, bulk Save and Save all.
 * @param {Array<Object>} docs Documents from the open-documents cache.
 * @return {Promise}
 */
const saveOpenDocs = (docs, options) => {
    options = options || {};
    if (state.openDocsBusy || !docs || !docs.length) {
        return Promise.resolve();
    }
    state.openDocsBusy = true;
    setOpenDocsBusyUi(true);
    if (docs.length > 1) {
        setHint(`Saving ${docs.length} documents…`);
    }
    let activeBefore = null;
    state.openDocsCache.forEach((doc) => {
        if (doc.isActive) activeBefore = doc.documentSessionId;
    });

    let saved = 0;
    let chain = Promise.resolve();
    docs.forEach((doc) => {
        chain = chain.then(() => {
            return activateDoc(doc.documentSessionId).then((r) => {
                if (!r || !r.ok) return null;
                return refreshDocStatus().then(() => {
                    return runDejavuCycle(true);
                }).then(() => {
                    saved += 1;
                    if (options.closeAfter) {
                        return closeDoc(doc.documentSessionId);
                    }
                    return null;
                });
            });
        });
    });

    return chain.then(() => {
        if (activeBefore) return activateDoc(activeBefore);
        return null;
    }).then(() => {
        return refreshDocStatus();
    }).then(() => {
        state.openDocsBusy = false;
        setOpenDocsBusyUi(false);
        if (docs.length > 1) {
            setHint(`Saved ${saved} of ${docs.length} documents.`, saved ? "ok" : "warn");
        }
        return refreshOpenDocuments();
    }, () => {
        state.openDocsBusy = false;
        setOpenDocsBusyUi(false);
        return refreshOpenDocuments();
    });
};

const initOpenDocsBulkSaveMenu = () => {
    const host = document.getElementById("openDocsBulkSaveSplit");
    const arrow = document.getElementById("openDocsBulkSaveMenuBtn");
    if (!host || !arrow || host.querySelector(".open-doc-menu")) return;
    const menu = makeOpenDocsMenu(() => {
        saveOpenDocs(selectedOpenDocs(), { closeAfter: true });
    }, "bulk");
    host.appendChild(menu);
    arrow.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const isOpen = menu.getAttribute("aria-hidden") === "false";
        closeOpenDocsActionMenus();
        if (!isOpen) {
            menu.classList.add("is-open");
            host.classList.add("is-open");
            menu.setAttribute("aria-hidden", "false");
            arrow.setAttribute("aria-expanded", "true");
            menu.style.left = "0";
            menu.style.top = "0";
            positionOpenDocsMenu(host, menu);
            return;
        }
        menu.setAttribute("aria-hidden", "true");
        arrow.setAttribute("aria-expanded", "false");
    });
    bindOpenDocsGlobalMenuClose();
};

/** Disables the bulk Save controls while a sequential save runs. */
const setOpenDocsBusyUi = (busy) => {
    [
        el.openDocsBulkSaveBtn,
        el.openDocsBulkSaveMenuBtn
    ].forEach((btn) => {
        if (btn) btn.disabled = busy;
    });
    if (el.openDocsList) {
        el.openDocsList.classList.toggle("open-docs--busy", busy);
    }
};

/** Applies dejavu on/off to the currently-selected documents. */
const bulkSetDejavuSelected = (on) => {
    const keys = openDocsSelectedKeys();
    if (!keys.length) return;
    setDejavuForKeys(keys, on);
    refreshOpenDocuments();
};

/**
 * Chooses the next state for the compact four-state switch.
 * The order is arranged so the common examples are one click:
 * off-all → on-current, and on-all → off-current.
 * @param {string} mode Current display mode.
 * @return {string}
 */
