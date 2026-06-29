/**
 * DejaVu — split from the original client/js/main.js.
 *
 * This file preserves the original statements and function bodies;
 * it only moves them into a responsibility-focused script file.
 */
"use strict";

const readLocalJson = (key, fallback) => {
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
};

const writeLocalJson = (key, value) => {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
};

const cleanRecoveryDisplayName = (name) => {
    const value = String(name || "").trim();
    if (!value) return "";
    return value.replace(/_(?:0*\d+)$/, "");
};

const isSavedDocumentInfo = (info) => {
    return !!(info && (info.hasPath || info.fullPath));
};

/** Extracts the lowercase file extension from a recovery candidate's path. */
const recoveryCandidateExtension = (candidate) => {
    const path = candidate && candidate.path ? String(candidate.path) : "";
    const match = path.match(/\.([^.\\/]+)$/);
    return match ? match[1].toLowerCase() : "";
};

const recoveryCandidateDisplayName = (candidate) => {
    let name = cleanRecoveryDisplayName(
        candidate && (
            candidate.displayName ||
            candidate.name ||
            candidate.baseName ||
            "Dejavu"
        )
    ) || "Dejavu";
    // Unsaved-document names (e.g. "Untitled-3") carry no extension, unlike
    // saved-document names ("Untitled-1.ai"). Append the real extension from
    // the dejavu file so every recovery row shows a complete filename.
    const ext = recoveryCandidateExtension(candidate);
    if (ext && !/\.[a-z0-9]{1,5}$/i.test(name)) {
        name = `${name}.${ext}`;
    }
    return name;
};

const pruneRecoveryCandidatesForSavedDocument = (info) => {
    if (!isSavedDocumentInfo(info)) return false;
    const sessionId = info && info.documentSessionId
        ? String(info.documentSessionId)
        : "";
    const fullPath = info && info.fullPath ? String(info.fullPath) : "";
    const candidates = readLocalJson(RECOVERY_CANDIDATES_KEY, []);
    if (!Array.isArray(candidates)) return false;
    const kept = candidates.filter((candidate) => {
        if (!candidate) return false;
        if (fullPath && candidate.sourceKey === `file:${fullPath}`) return false;
        if (
            sessionId &&
            (
                candidate.documentSessionId === sessionId ||
                candidate.sourceKey === `unsaved:${sessionId}`
            )
        ) {
            return false;
        }
        return true;
    });
    if (kept.length === candidates.length) return false;
    writeLocalJson(RECOVERY_CANDIDATES_KEY, kept);
    renderRecoveryCenter();
    return true;
};

const recoveryVersionsPerUnsavedDoc = () => {
    return Math.max(
        1,
        Math.min(20, parseInt(state.settings.recoveryVersionsPerUnsavedDoc, 10) || 5)
    );
};

const recoveryMaxCandidates = () => {
    return Math.max(
        10,
        Math.min(500, parseInt(state.settings.recoveryMaxCandidates, 10) || 80)
    );
};

const trimRecoveryCandidates = (items) => {
    const perSourceLimit = recoveryVersionsPerUnsavedDoc();
    const sourceCounts = {};
    const kept = [];
    const seenPaths = {};
    items.forEach((candidate) => {
        if (!candidate || !candidate.path) return;
        if (seenPaths[candidate.path]) return;
        seenPaths[candidate.path] = true;
        const sourceKey = String(candidate.sourceKey || candidate.path);
        sourceCounts[sourceKey] = sourceCounts[sourceKey] || 0;
        if (sourceCounts[sourceKey] >= perSourceLimit) return;
        sourceCounts[sourceKey]++;
        kept.push(candidate);
    });
    return kept.slice(0, recoveryMaxCandidates());
};

const beginCrashRecoverySession = () => {
    const now = Date.now();
    const previous = readLocalJson(CRASH_SESSION_KEY, null);
    const heartbeatAge = previous && previous.heartbeat
        ? now - Number(previous.heartbeat)
        : 0;
    const crashed = !!(
        previous && previous.clean === false &&
        heartbeatAge > 15000 && heartbeatAge < 7 * 86400000
    );
    const session = {
        id: `session-${now}-${Math.floor(Math.random() * 100000)}`,
        started: now,
        heartbeat: now,
        clean: false
    };
    writeLocalJson(CRASH_SESSION_KEY, session);
    if (crashHeartbeatId !== null) window.clearInterval(crashHeartbeatId);
    crashHeartbeatId = window.setInterval(() => {
        session.heartbeat = Date.now();
        writeLocalJson(CRASH_SESSION_KEY, session);
    }, 5000);
    window.addEventListener("beforeunload", () => {
        session.heartbeat = Date.now();
        session.clean = true;
        writeLocalJson(CRASH_SESSION_KEY, session);
    });
    return crashed;
};

const recordRecoveryCandidate = (result, info) => {
    if (!result || !result.ok || !result.path) return;
    if (isSavedDocumentInfo(info)) {
        pruneRecoveryCandidatesForSavedDocument(info);
        return;
    }
    let candidates = readLocalJson(RECOVERY_CANDIDATES_KEY, []);
    if (!Array.isArray(candidates)) candidates = [];
    const documentSessionId = info && info.documentSessionId
        ? String(info.documentSessionId)
        : "";
    const dejavuFolder = String(result.dejavuFolder || result.folderPath || "");
    const displayName = cleanRecoveryDisplayName(
        info && (info.docName || info.baseName)
            ? (info.docName || info.baseName)
            : (result.document || result.name || "Dejavu")
    ) || "Dejavu";
    const sourceKey = documentSessionId
        ? `unsaved:${documentSessionId}`
        : `unsaved:${dejavuFolder}/${displayName}`;
    candidates = candidates.filter((candidate) => {
        if (!candidate) return false;
        if (candidate.path === result.path) return false;
        if (
            dejavuFolder &&
            !documentSessionId &&
            String(candidate.sourceKey || "").indexOf(
                `unsaved:${dejavuFolder}/`
            ) === 0
        ) {
            return false;
        }
        return true;
    });
    candidates.unshift({
        sourceKey,
        path: result.path,
        name: displayName,
        displayName,
        isUnsaved: true,
        documentSessionId,
        dejavuFolder,
        timestamp: Number(result.timestamp || result.savedAt) || Date.now(),
        size: Number(result.size) || 0
    });
    writeLocalJson(RECOVERY_CANDIDATES_KEY, trimRecoveryCandidates(candidates));
    renderRecoveryCenter();
};

const promoteRecoveredCandidate = (candidate, result) => {
    if (!candidate || !result || !result.ok || !result.path) return;
    let candidates = readLocalJson(RECOVERY_CANDIDATES_KEY, []);
    if (!Array.isArray(candidates)) candidates = [];
    candidates = candidates.filter((item) => {
        return item &&
            item.sourceKey !== candidate.sourceKey &&
            item.sourceKey !== `file:${candidate.path}` &&
            item.path !== result.path;
    });
    candidates.unshift({
        sourceKey: candidate.sourceKey,
        path: result.path,
        name: candidate.name,
        displayName: recoveryCandidateDisplayName(candidate),
        isUnsaved: candidate.isUnsaved !== false,
        documentSessionId: candidate.documentSessionId || "",
        dejavuFolder: candidate.dejavuFolder || "",
        timestamp: Number(result.timestamp) || Date.now(),
        size: Number(result.size) || 0
    });
    writeLocalJson(RECOVERY_CANDIDATES_KEY, trimRecoveryCandidates(candidates));
    renderRecoveryCenter();
};

const getRecoveryCandidates = () => {
    const candidates = readLocalJson(RECOVERY_CANDIDATES_KEY, []);
    if (!Array.isArray(candidates)) return [];
    return candidates.filter((candidate) => {
        if (!candidate || !candidate.path) return false;
        return candidate.isUnsaved === true ||
            String(candidate.sourceKey || "").indexOf("unsaved:") === 0;
    }).sort((a, b) => {
        return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
    });
};

const forgetRecoveryCandidate = (path) => {
    const candidates = getRecoveryCandidates().filter((candidate) => {
        return candidate.path !== path;
    });
    writeLocalJson(RECOVERY_CANDIDATES_KEY, candidates);
    renderRecoveryCenter();
    setHint("Recovery entry forgotten; its file was not deleted.", "ok");
};

const renderRecoveryCenter = () => {
    if (!el.recoveryCandidateList) return;
    if (isEditingSnapshotNoteIn(el.recoveryCandidateList)) return;
    const candidates = getRecoveryCandidates();
    el.recoveryCandidateList.innerHTML = "";
    el.recoveryCandidateCount.textContent = String(candidates.length);
    
    // Clean up selections for items that no longer exist.
    const existingPaths = {};
    candidates.forEach((candidate) => { existingPaths[candidate.path] = true; });
    const recoveryCtrl = getRecoveryTable();
    if (recoveryCtrl) recoveryCtrl.pruneSelection(candidates);
    else getSelectedRecoveryPaths().forEach((path) => {
        if (!existingPaths[path]) delete state.selectedRecoveryPaths[path];
    });
    
    const visibleItems = getVisibleRecoveryCandidates();
    updateRecoveryBulkBar();
    
    el.recoveryCandidateList.classList.toggle(
        "version-list--compact",
        !!state.settings.recoveryCompact
    );

    if (!candidates || candidates.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "No recovery history yet.";
        el.recoveryCandidateList.appendChild(empty);
        return;
    }

    if (visibleItems.length === 0) {
        const noMatch = document.createElement("div");
        noMatch.className = "empty-state";
        noMatch.textContent = "No recovery entries match the current filter.";
        el.recoveryCandidateList.appendChild(noMatch);
        return;
    }

    const fragment = document.createDocumentFragment();
    const groups = groupSnapshotsByDay(visibleItems);

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

        group.items.forEach((candidate) => {
            const isProtected = isSnapshotProtected(candidate.path);

            const node = document.createElement("div");
            const noteText = getSnapshotNote(candidate.path);
            node.className = DEJAVU.classNames(
                "snapshot",
                isProtected && "snapshot--pinned",
                noteText && "snapshot--comment",
                isRecoverySelected(candidate.path) && "snapshot--selected"
            );
            node.tabIndex = 0;
            node.dataset.path = candidate.path;
            node.addEventListener("mouseenter", () => {
                if (state.isPainting) {
                    setRecoverySelected(candidate.path, state.paintState);
                    const checkbox = node.querySelector(".snapshot__select input");
                    if (checkbox) checkbox.checked = state.paintState;
                }
                if (state.isPaintingPin) {
                    const currentlyProtected = isSnapshotProtected(candidate.path);
                    if (state.paintPinState !== currentlyProtected) {
                        toggleSnapshotProtectionForRecovery({ path: candidate.path });
                    }
                }
            });

            const pin = document.createElement("button");
            pin.type = "button";
            pin.className = "snapshot__dot";
            pin.title = isProtected ? "Unpin snapshot" : "Pin snapshot";
            pin.setAttribute(
                "aria-label",
                isProtected ? "Unpin snapshot" : "Pin snapshot"
            );
            pin.dataset.path = candidate.path;
            
            if (candidate.exists === false) {
                pin.disabled = true;
                pin.title = "File no longer exists - cannot pin";
            }
            
            pin.addEventListener("mousedown", (evt) => {
                if (evt.button !== 0) return;
                const currentlyProtected = isSnapshotProtected(candidate.path);
                state.isPaintingPin = true;
                state.paintPinState = !currentlyProtected;
                toggleSnapshotProtectionForRecovery({ path: candidate.path });
                evt.preventDefault();
            });
            node.appendChild(pin);

            const body = document.createElement("div");
            body.className = "snapshot__body";

            const topLine = document.createElement("div");
            topLine.className = "snapshot__top";

            const name = document.createElement("button");
            name.type = "button";
            name.className = "snapshot__time snapshot__filename";
            name.textContent = recoveryCandidateDisplayName(candidate);
            name.title = `Open this recovery file  ·  Shift-click to reveal in Finder`;
            if (candidate.exists === false) {
                name.disabled = true;
                name.title = "File no longer exists";
            }
            name.addEventListener("click", (evt) => {
                if (evt.shiftKey) {
                    revealPath(candidate.path);
                    return;
                }
                openSnapshotAndDejavu(candidate.path, "recovery");
            });
            topLine.appendChild(name);

            const timeContainer = document.createElement("div");
            timeContainer.className = "snapshot__time-container";

            const rel = document.createElement("span");
            rel.className = "snapshot__rel";
            rel.textContent = candidate.exists === false ? "File not found" : formatRelativeTime(candidate.timestamp);
            timeContainer.appendChild(rel);
            
            topLine.appendChild(timeContainer);

            const rightGroup = document.createElement("div");
            rightGroup.className = "snapshot__right-group";

            const sizeEl = document.createElement("span");
            sizeEl.className = "snapshot__size";
            sizeEl.textContent = candidate.size ? formatBytes(candidate.size) : "Unknown";
            rightGroup.appendChild(sizeEl);

            const selectLabel = document.createElement("label");
            selectLabel.className = "snapshot__select";
            selectLabel.title = "Select recovery entry for bulk actions";
            const selectInput = document.createElement("input");
            selectInput.type = "checkbox";
            selectInput.checked = isRecoverySelected(candidate.path);
            selectInput.setAttribute("aria-label", `Select ${(candidate.name || "Dejavu")}`);
            selectInput.dataset.path = candidate.path;
            let handledByMousedown = false;
            selectInput.addEventListener("click", (evt) => {
                evt.stopPropagation();
                if (handledByMousedown) {
                    handledByMousedown = false;
                    evt.preventDefault();
                    return;
                }
                setRecoverySelected(candidate.path, selectInput.checked);
            });
            selectInput.addEventListener("mousedown", (evt) => {
                if (evt.button !== 0) return;
                evt.stopPropagation();
                state.isPainting = true;
                state.paintState = !selectInput.checked;
                state.paintStartPath = candidate.path;
                setRecoverySelected(candidate.path, state.paintState);
                selectInput.checked = state.paintState;
                handledByMousedown = true;
                evt.preventDefault();
            });
            selectLabel.appendChild(selectInput);
            rightGroup.appendChild(selectLabel);

            topLine.appendChild(rightGroup);

            body.appendChild(topLine);

            const notes = state.settings.snapshotNotes || {};
            const note = notes[candidate.path] || "";
            const noteEl = document.createElement("div");
            noteEl.className = DEJAVU.classNames(
                "snapshot__note",
                !note && "snapshot__note--empty"
            );
            noteEl.textContent = note || "Note";
            noteEl.title = "Double-click to edit note";

            if (candidate.exists === false) {
                noteEl.title = "File no longer exists - cannot edit note";
                noteEl.classList.add("snapshot__note--missing");
            } else {
                noteEl.tabIndex = 0;
                noteEl.setAttribute("role", "button");
                noteEl.setAttribute("aria-label", "Edit snapshot note");
                noteEl.addEventListener("dblclick", (evt) => {
                    evt.stopPropagation();
                    editSnapshotNoteForRecovery(candidate, noteEl);
                });
                noteEl.addEventListener("keydown", (evt) => {
                    if (evt.key === "Enter" || evt.key === "F2") {
                        evt.preventDefault();
                        editSnapshotNoteForRecovery(candidate, noteEl);
                    }
                });
            }
            
            body.appendChild(noteEl);

            node.appendChild(body);
            rail.appendChild(node);
        });
        section.appendChild(rail);
        fragment.appendChild(section);
    });
    
    el.recoveryCandidateList.appendChild(fragment);
    
    // Check file existence asynchronously after rendering for strikethrough styling
    checkMissingFilesInRecoveryCenter();
};

const rerenderRecoveryCenter = () => {
    const candidates = getRecoveryCandidates();
    const visibleItems = getVisibleRecoveryCandidates();
    const fragment = document.createDocumentFragment();
    const groups = groupSnapshotsByDay(visibleItems);

    groups.forEach((group) => {
        group.items.forEach((candidate) => {
            const node = el.recoveryCandidateList.querySelector(
                `[data-path="${candidate.path}"]`
            );
            if (node) {
                node.classList.toggle(
                    "snapshot--selected",
                    isRecoverySelected(candidate.path)
                );
                const checkbox = node.querySelector(".snapshot__select input");
                if (checkbox) {
                    checkbox.checked = isRecoverySelected(candidate.path);
                }
            }
        });
    });
};

const checkMissingFilesInRecoveryCenter = () => {
    const candidates = getRecoveryCandidates();
    if (!candidates || candidates.length === 0) return;
    candidates.forEach((candidate) => {
        callHost("dejavu_pathExists", [candidate.path]).then((result) => {
            const exists = result && result.ok && result.exists;
            const nodes = el.recoveryCandidateList.querySelectorAll(".snapshot");
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].dataset.path === candidate.path) {
                    const pathEl = nodes[i].querySelector(".snapshot__path");
                    const nameEl = nodes[i].querySelector(".snapshot__filename");
                    const pinEl = nodes[i].querySelector(".snapshot__dot");
                    const checkboxEl = nodes[i].querySelector(".snapshot__select");
                    const sizeEl = nodes[i].querySelector(".snapshot__size");
                    const relEl = nodes[i].querySelector(".snapshot__rel");
                    const noteEl = nodes[i].querySelector(".snapshot__note");
                    
                    // Update size if missing and file exists
                    if (sizeEl && exists && (!candidate.size || candidate.size === 0)) {
                        callHost("dejavu_getFileSize", [candidate.path]).then((sizeResult) => {
                            if (sizeResult && sizeResult.ok && sizeResult.size) {
                                candidate.size = Number(sizeResult.size);
                                const allCandidates = getRecoveryCandidates();
                                const updated = allCandidates.map((c) => {
                                    if (c.path === candidate.path) {
                                        return candidate;
                                    }
                                    return c;
                                });
                                writeLocalJson(RECOVERY_CANDIDATES_KEY, updated);
                                sizeEl.textContent = formatBytes(candidate.size);
                            }
                        });
                    }
                    
                    if (!exists) {
                        nodes[i].classList.add("snapshot--missing");
                        if (nameEl) nameEl.disabled = true;
                        if (pathEl) pathEl.disabled = true;
                        if (pinEl) pinEl.disabled = true;
                        if (relEl) relEl.textContent = "File not found";
                        if (noteEl) {
                            noteEl.classList.add("snapshot__note--missing");
                            noteEl.title = "File no longer exists - cannot edit note";
                        }
                        if (nameEl) nameEl.title = "File no longer exists";
                        if (pathEl) pathEl.title = "File no longer exists";
                        if (pinEl) pinEl.title = "File no longer exists - cannot pin";
                    } else {
                        nodes[i].classList.remove("snapshot--missing");
                        if (nameEl) nameEl.disabled = false;
                        if (pathEl) pathEl.disabled = false;
                        if (pinEl) pinEl.disabled = false;
                        if (relEl) relEl.textContent = formatRelativeTime(candidate.timestamp);
                        if (noteEl) {
                            noteEl.classList.remove("snapshot__note--missing");
                            noteEl.title = "Double-click to edit note";
                        }
                        if (nameEl) nameEl.title = "Open this recovery file  ·  Shift-click to reveal in Finder";
                        if (pathEl) pathEl.title = "Reveal in Finder or File Explorer";
                        if (pinEl) pinEl.title = isSnapshotProtected(candidate.path) ? "Unpin snapshot" : "Pin snapshot";
                    }
                    break;
                }
            }
        });
    });
};

// Minimum time the in-progress save indicator (top bar + pulsing
// LED) stays visible, so quick saves still register as a blink.
