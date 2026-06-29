/**
 * TokenField — a small, self-contained token / chip editor built from
 * scratch (inspired by the in-house TokenInput + tok__chips editors).
 *
 *   const tf = window.TokenField.create(options);
 *   container.appendChild(tf.element);
 *   // or:  window.TokenField.attach(container, options);
 *
 * Options (all optional unless noted):
 *   tokens: [{ key, label?, title?, pin? }]
 *       The predefined / available tokens. `pin` is "start" or "end" and
 *       locks the token to that edge of the field: it is always present, can
 *       never be removed or reordered, and — crucially — the caret can never
     *       land before a start-pinned token or after an end-pinned token (they
     *       live outside the editable flow, so this is structural).
 *   value: Array<string | {token:string} | {text:string}>
 *       Initial content. A bare string is treated as a token key when it
 *       matches a predefined token, otherwise as text / a custom token.
 *   singleUse:        bool  — each predefined token can be used at most once.
 *   allowFreeText:    bool  — typed text that isn't a token stays as free text.
 *   allowCustomTokens:bool  — Enter / separator / blur turns typed text into a
 *                             pill even when it isn't a predefined token.
 *   separator:        string— auto-inserted between adjacent parts in getText()
 *                             (and shown faintly between chips) when it wasn't
 *                             typed manually.
 *   showPalette:      bool  — render every available token below the field;
 *                             when singleUse, used ones get the .is-used class.
 *   reorder:          bool  — drag & drop to reorder the middle tokens.
 *   trailingButton: { label, title?, onClick(instance) }
 *                             — a token-shaped button (different style) placed
 *                               after all tokens and the free-text input.
 *   placeholder:      string
 *   onChange(parts, instance)
 *
 * Instance API:
 *   element, getParts(), getValues(), getText(), setValue(v),
 *   addToken(key), addCustom(text), focus(), destroy()
 */
(function (global) {
    "use strict";

    const isString = (value) => typeof value === "string";
    const classNames = (...names) => names.filter(Boolean).join(" ");

    /** Builds one normalized token definition. */
    const normalizeTokenDefinition = (token) => {
        if (isString(token)) token = { key: token };
        const key = String(token.key);
        return {
            key,
            label: token.label != null ? String(token.label) : key,
            title: token.title != null ? String(token.title) : "",
            pin: token.pin === "start" || token.pin === "end"
                ? token.pin
                : null
        };
    };

    function TokenField(options) {
        const o = options || {};
        const defs = (o.tokens || []).map(normalizeTokenDefinition);
        const byKey = {};
        defs.forEach((d) => { byKey[d.key.toLowerCase()] = d; });
        const startPins = defs.filter((d) => d.pin === "start");
        const endPins = defs.filter((d) => d.pin === "end");

        const cfg = {
            singleUse: !!o.singleUse,
            allowFreeText: !!o.allowFreeText,
            allowCustomTokens: !!o.allowCustomTokens,
            separator: o.separator != null ? String(o.separator) : "",
            showPalette: !!o.showPalette,
            reorder: !!o.reorder,
            commitOnSpace: !!o.commitOnSpace,
            placeholder: o.placeholder != null ? String(o.placeholder) : "",
            trailingButton: o.trailingButton || null,
            onChange: typeof o.onChange === "function" ? o.onChange : null,
            // Gate for turning typed text into a custom token. Return truthy
            // (or a resolving promise) to accept, falsy to discard the text.
            validateCustom: typeof o.validateCustom === "function"
                ? o.validateCustom
                : null,
            // Autocomplete: given the current pending text, return an array of
            // suggestions (string | { value, label?, hint?, token? }) — or a
            // promise of them. Drives the dropdown menu. With token:true an item
            // is inserted as a chip; otherwise it completes the typed text.
            suggest: typeof o.suggest === "function" ? o.suggest : null,
            // Max suggestions shown at once; extra matches collapse into a
            // non-clickable "…" hint (type more to filter).
            menuMaxItems: o.menuMaxItems > 0 ? o.menuMaxItems : 8,
            // When set, the suggestion menu only opens once the pending text's
            // first character is one of these (e.g. "/~" opens on "/" or "~").
            suggestTrigger: o.suggestTrigger != null
                ? String(o.suggestTrigger)
                : "",
            // With singleUse, already-used suggestions are shown disabled by
            // default; set this to drop them from the menu entirely instead.
            hideUsedSuggestions: !!o.hideUsedSuggestions,
            // Optional transform applied to a value as it becomes a token (e.g.
            // strip a trailing "/" from a folder path).
            normalize: typeof o.normalize === "function" ? o.normalize : null,
            // Double-clicking a token calls this with its value; resolve a new
            // value to replace the token (e.g. re-pick a folder), or null/empty
            // to leave it unchanged.
            onTokenDblClick: typeof o.onTokenDblClick === "function"
                ? o.onTokenDblClick
                : null
        };

        // ---- DOM scaffold --------------------------------------------------
        const root = document.createElement("div");
        root.className = "tf";
        if (cfg.separator) {
            root.style.setProperty(
                "--token-field-chip-separator-content",
                JSON.stringify(cfg.separator)
            );
        }

        const field = document.createElement("div");
        field.className = "tf__field";

        const flow = document.createElement("div");
        flow.className = "tf__flow";
        flow.contentEditable = "true";
        flow.spellcheck = false;
        flow.setAttribute("role", "textbox");
        if (cfg.placeholder) flow.dataset.placeholder = cfg.placeholder;

        field.appendChild(flow);

        // The field + its autocomplete menu share a positioned wrapper so the
        // menu can overlay directly beneath the field.
        const fieldWrap = document.createElement("div");
        fieldWrap.className = "tf__field-wrap";
        fieldWrap.appendChild(field);
        root.appendChild(fieldWrap);

        let menu = null;
        if (cfg.suggest) {
            menu = document.createElement("div");
            menu.className = "tf__menu";
            menu.hidden = true;
            fieldWrap.appendChild(menu);
        }

        // The trailing button + a word-joiner live as the last children of the
        // flow (the editable region), so the button ends the last line and wraps
        // with the content. The word-joiner (U+2060) removes the break before the
        // button so it never wraps alone. Both are excluded from the content.
        const WJ = String.fromCharCode(0x2060);
        let buttonEl = null;
        let wjNode = null;

        let palette = null;
        if (cfg.showPalette) {
            palette = document.createElement("div");
            palette.className = "tf__palette";
            root.appendChild(palette);
        }

        // ---- helpers -------------------------------------------------------
        const tokenChip = (def, custom) => {
            const chip = document.createElement("span");
            chip.className = classNames(
                "tf__chip",
                custom && "tf__chip--custom"
            );
            chip.contentEditable = "false";
            chip.dataset.key = def.key;
            chip.dataset.label = def.label;
            if (custom) chip.dataset.custom = "1";
            if (def.title) chip.title = def.title;
            if (def.pin) {
                chip.classList.add("tf__chip--pin", `tf__chip--${def.pin}`);
            }

            const lbl = document.createElement("span");
            lbl.className = "tf__chip-label";
            lbl.textContent = def.label;
            chip.appendChild(lbl);

            // No per-chip close button: tokens are removed with the keyboard
            // (Backspace / Delete, or highlight + Ctrl-X). Non-pinned chips can
            // be grabbed (pointer drag) to reorder.
            if (!def.pin && cfg.reorder) chip.classList.add("tf__chip--draggable");
            return chip;
        };

        /** Resolve typed text into a token definition (or null). */
        const tokenFromText = (raw) => {
            const text = String(raw || "").trim();
            if (!text) return null;
            const hit = byKey[text.toLowerCase()];
            if (hit && !hit.pin) {
                if (cfg.singleUse && isUsed(hit.key)) return null;
                return { def: hit, custom: false };
            }
            // also match by label
            const byLabel = defs.find(
                (d) => !d.pin && d.label.toLowerCase() === text.toLowerCase()
            );
            if (byLabel) {
                if (cfg.singleUse && isUsed(byLabel.key)) return null;
                return { def: byLabel, custom: false };
            }
            if (cfg.allowCustomTokens) {
                const norm = cfg.normalize ? String(cfg.normalize(text)) : text;
                if (!norm) return null;
                if (cfg.singleUse && isUsed(norm)) return null;
                return { def: { key: norm, label: norm, title: "" }, custom: true };
            }
            return null;
        };

        const isUsed = (key) => {
            const k = String(key).toLowerCase();
            return middleParts().some(
                (p) => p.type === "token" && p.key.toLowerCase() === k
            );
        };

        const isUsedByOtherChip = (key, currentChip) => {
            const k = String(key).toLowerCase();
            return Array.prototype.some.call(
                flow.querySelectorAll(".tf__chip"),
                (chip) => chip !== currentChip &&
                    String(chip.dataset.key || "").toLowerCase() === k
            );
        };

        // ---- caret -----------------------------------------------------------
        const sel = () => global.getSelection();

        const caretInFlow = () => {
            const s = sel();
            if (!s || !s.rangeCount) return null;
            const r = s.getRangeAt(0);
            return flow.contains(r.startContainer) ? r : null;
        };

        const placeCaretAfter = (node) => {
            const r = document.createRange();
            r.setStartAfter(node);
            r.collapse(true);
            const s = sel();
            s.removeAllRanges();
            s.addRange(r);
        };

        const placeCaretAtFlowEnd = () => {
            flow.focus();
            const r = document.createRange();
            // End of the *content* = before the trailing word-joiner/button.
            if (wjNode && wjNode.parentNode === flow) {
                r.setStartBefore(wjNode);
                r.collapse(true);
            } else {
                r.selectNodeContents(flow);
                r.collapse(false);
            }
            const s = sel();
            s.removeAllRanges();
            s.addRange(r);
        };

        const beforeActionTail = (node) => {
            if (wjNode && wjNode.parentNode === flow) {
                flow.insertBefore(node, wjNode);
            } else {
                flow.appendChild(node);
            }
        };

        const normalizeActionTail = () => {
            if (!buttonEl || buttonEl.parentNode !== flow) return;
            const moved = [];
            let node = buttonEl.nextSibling;
            while (node) {
                const next = node.nextSibling;
                if (node.nodeType === 3 && !node.nodeValue) {
                    node.parentNode.removeChild(node);
                } else if (node.nodeType === 1 && node.nodeName === "BR") {
                    node.parentNode.removeChild(node);
                } else {
                    moved.push(node);
                }
                node = next;
            }
            moved.forEach(beforeActionTail);
        };

        let clampingActionCaret = false;
        const actionTailStartIndex = () => {
            if (wjNode && wjNode.parentNode === flow) {
                return Array.prototype.indexOf.call(flow.childNodes, wjNode);
            }
            if (buttonEl && buttonEl.parentNode === flow) {
                return Array.prototype.indexOf.call(flow.childNodes, buttonEl);
            }
            return -1;
        };

        const flowChildFor = (node) => {
            let n = node;
            while (n && n.parentNode !== flow) n = n.parentNode;
            return n;
        };

        const rangeIsAfterActionTail = (r) => {
            if (!buttonEl || buttonEl.parentNode !== flow || !r || !r.collapsed) {
                return false;
            }
            const tailIndex = actionTailStartIndex();
            if (tailIndex < 0) return false;
            if (r.startContainer === flow) return r.startOffset > tailIndex;
            const child = flowChildFor(r.startContainer);
            if (!child) return false;
            if (child === wjNode || child === buttonEl) return true;
            const index = Array.prototype.indexOf.call(flow.childNodes, child);
            return index > tailIndex;
        };

        const caretRangeFromPoint = (x, y) => {
            if (document.caretRangeFromPoint) {
                return document.caretRangeFromPoint(x, y);
            }
            if (document.caretPositionFromPoint) {
                const pos = document.caretPositionFromPoint(x, y);
                if (!pos) return null;
                const r = document.createRange();
                r.setStart(pos.offsetNode, pos.offset);
                r.collapse(true);
                return r;
            }
            return null;
        };

        const clampPointBeforeAction = (x, y) => {
            if (!buttonEl) return false;
            const r = caretRangeFromPoint(x, y);
            if (!r || !flow.contains(r.startContainer) ||
                !rangeIsAfterActionTail(r)) {
                return false;
            }
            flow.focus();
            placeCaretAtFlowEnd();
            return true;
        };

        const clampCaretBeforeAction = () => {
            if (clampingActionCaret) return;
            const r = caretInFlow();
            if (!rangeIsAfterActionTail(r)) return;
            clampingActionCaret = true;
            placeCaretAtFlowEnd();
            clampingActionCaret = false;
        };

        const clampCaretSoon = () => {
            global.setTimeout(clampCaretBeforeAction, 0);
        };

        /** Insert a node at the caret (inside flow), else append to flow. */
        const insertAtCaret = (node) => {
            const r = caretInFlow();
            if (!r) {
                beforeActionTail(node);
            } else if (rangeIsAfterActionTail(r)) {
                r.deleteContents();
                beforeActionTail(node);
            } else {
                r.deleteContents();
                r.insertNode(node);
            }
            normalizeActionTail();
            placeCaretAfter(node);
        };

        // ---- model <-> DOM ---------------------------------------------------
        /** Middle parts, read straight from the editable flow. */
        const middleParts = () => {
            const parts = [];
            Array.prototype.forEach.call(flow.childNodes, (node) => {
                if (node.nodeType === 1 && node.classList.contains("tf__chip")) {
                    parts.push({
                        type: "token",
                        key: node.dataset.key,
                        label: node.dataset.label || node.dataset.key,
                        custom: node.dataset.custom === "1"
                    });
                } else if (node.nodeType === 1 && node.classList && (
                    node.classList.contains("tf__placeholder") ||
                    node.classList.contains("tf__action"))) {
                    // The placeholder hint and the trailing button aren't content.
                } else {
                    let text = node.nodeType === 3
                        ? node.nodeValue
                        : node.textContent;
                    text = text ? text.split(WJ).join("") : ""; // drop word-joiner
                    if (text) {
                        const last = parts[parts.length - 1];
                        if (last && last.type === "text") last.value += text;
                        else parts.push({ type: "text", value: text });
                    }
                }
            });
            return parts;
        };

        const pinParts = (pins) => pins.map((d) => ({
            type: "token", key: d.key, label: d.label, custom: false, pin: d.pin
        }));

        const getParts = () =>
            pinParts(startPins).concat(middleParts(), pinParts(endPins));

        const getText = () => {
            const sep = cfg.separator;
            let out = "";
            getParts().forEach((p, i) => {
                const s = p.type === "token" ? p.key : p.value;
                if (i > 0 && sep && !out.endsWith(sep) && !s.startsWith(sep)) {
                    out += sep;
                }
                out += s;
            });
            return out;
        };

        const getValues = () =>
            getParts()
                .filter((p) => p.type === "token" || cfg.allowFreeText)
                .map((p) => (p.type === "token" ? p.key : p.value.trim()))
                .filter(Boolean);

        // ---- mutations -------------------------------------------------------
        let changeRaf = 0;
        const emitChange = () => {
            if (palette) renderPalette();
            if (!cfg.onChange) return;
            if (changeRaf) global.cancelAnimationFrame(changeRaf);
            changeRaf = global.requestAnimationFrame(() => {
                changeRaf = 0;
                cfg.onChange(getParts(), instance);
            });
        };

        /** Re-render the editable flow from a parts array (middle only). */
        const renderMiddle = (parts) => {
            flow.innerHTML = "";
            (parts || []).forEach((p) => {
                if (p.type === "token") {
                    const def = byKey[String(p.key).toLowerCase()];
                    if (def && def.pin) return; // pins are not in the flow
                    flow.appendChild(tokenChip(
                        def || { key: p.key, label: p.label || p.key, title: "" },
                        def ? false : true
                    ));
                } else if (p.value) {
                    flow.appendChild(document.createTextNode(p.value));
                }
            });
            // Keep the trailing word-joiner + button as the last flow children.
            if (wjNode) flow.appendChild(wjNode);
            if (buttonEl) flow.appendChild(buttonEl);
        };

        const syncAfterMutation = () => { emitChange(); };

        const insertToken = (def, custom) => {
            if (!def) return;
            if (cfg.singleUse && isUsed(def.key)) return;
            insertAtCaret(tokenChip(def, custom));
            emitChange();
        };

        const addToken = (key) => {
            const def = byKey[String(key).toLowerCase()];
            if (def && !def.pin) insertToken(def, false);
        };

        const addCustom = (text) => {
            const t = tokenFromText(text);
            if (t) {
                placeCaretAtFlowEnd();
                insertToken(t.def, t.custom);
            }
        };

        /** Convert the text node touching the caret into a token, if possible. */
        const commitPendingText = (force) => {
            const r = caretInFlow();
            let node = r && r.startContainer && r.startContainer.nodeType === 3
                ? r.startContainer
                : null;
            // On blur the caret is gone, so fall back to the last non-empty text
            // node (skipping the placeholder / empty nodes). This is what lets a
            // blur commit (convert) or discard the typed text.
            if (!node) {
                for (let i = flow.childNodes.length - 1; i >= 0; i--) {
                    const c = flow.childNodes[i];
                    if (c.nodeType === 3 && c.nodeValue.split(WJ).join("").trim()) {
                        node = c;
                        break;
                    }
                }
            }
            if (!node || node.nodeType !== 3) return false;
            const text = node.nodeValue.split(WJ).join("").trim();
            if (!text) {
                if (force && !cfg.allowFreeText) node.nodeValue = "";
                return false;
            }
            const t = tokenFromText(text);
            if (t) {
                // Custom tokens may need validation (e.g. the folder must
                // exist). Keep the text until the (possibly async) gate
                // resolves: accept → swap in a chip, reject → drop the text.
                if (t.custom && cfg.validateCustom) {
                    const theNode = node;
                    Promise.resolve(cfg.validateCustom(text)).then((ok) => {
                        if (!flow.contains(theNode)) return;
                        if (ok) {
                            const chip = tokenChip(t.def, t.custom);
                            theNode.parentNode.replaceChild(chip, theNode);
                            placeCaretAfter(chip);
                        } else {
                            theNode.nodeValue = "";
                        }
                        emitChange();
                    });
                    return true;
                }
                const chip = tokenChip(t.def, t.custom);
                node.parentNode.replaceChild(chip, node);
                placeCaretAfter(chip);
                emitChange();
                return true;
            }
            if (force && !cfg.allowFreeText) {
                node.nodeValue = "";
                emitChange();
            }
            return false;
        };

        // ---- palette ---------------------------------------------------------
        function renderPalette() {
            if (!palette) return;
            palette.innerHTML = "";
            defs.forEach((d) => {
                if (d.pin) return; // pinned tokens aren't pickable from the pool
                const used = cfg.singleUse && isUsed(d.key);
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = classNames("tf__pool-item", used && "is-used");
                btn.disabled = used;
                btn.textContent = d.label;
                if (d.title) btn.title = d.title;
                btn.addEventListener("click", () => {
                    placeCaretAtFlowEnd();
                    insertToken(d, false);
                });
                palette.appendChild(btn);
            });
        }

        // ---- pointer drag & drop (mouse + touch, "flying" ghost) ------------
        // The grabbed chip detaches into a floating clone that follows the
        // pointer while the original is live-reordered underneath. Touch needs a
        // long-press to grab (so the list can still be scrolled); mouse/pen grab
        // after a few pixels of movement (so a plain click still places a caret).
        let drag = null;
        let justDragged = false;
        const DRAG_THRESHOLD = 5;
        const LONGPRESS_MS = 320;

        /** Where to drop, by pointer position (row-aware via weighted y). */
        const dropTarget = (x, y) => {
            const chips = Array.prototype.slice.call(
                flow.querySelectorAll(".tf__chip:not(.is-dragging)")
            );
            let best = null;
            let bestDist = Infinity;
            let before = true;
            chips.forEach((chip) => {
                const r = chip.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const dist = Math.abs(y - cy) * 2 + Math.abs(x - cx);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = chip;
                    before = x < cx;
                }
            });
            return { best, before };
        };

        const moveGhost = (x, y) => {
            if (!drag || !drag.ghost) return;
            drag.ghost.style.left = (x - drag.dx) + "px";
            drag.ghost.style.top = (y - drag.dy) + "px";
        };

        const reorderTo = (x, y) => {
            const t = dropTarget(x, y);
            if (!t.best) {
                beforeActionTail(drag.chip);
                return;
            }
            if (t.before) flow.insertBefore(drag.chip, t.best);
            else flow.insertBefore(drag.chip, t.best.nextSibling);
            normalizeActionTail();
        };

        const beginDrag = (px, py) => {
            drag.started = true;
            const chip = drag.chip;
            const r = chip.getBoundingClientRect();
            drag.dx = px - r.left;
            drag.dy = py - r.top;
            const ghost = chip.cloneNode(true);
            ghost.classList.add("tf__chip--ghost");
            ghost.classList.remove("is-dragging", "is-selected");
            ghost.style.width = r.width + "px";
            document.body.appendChild(ghost);
            drag.ghost = ghost;
            chip.classList.add("is-dragging");
            document.body.classList.add("tf-dragging");
            const s = sel();
            if (s) s.removeAllRanges();
            moveGhost(px, py);
        };

        const endDrag = () => {
            if (!drag) return;
            if (drag.timer) global.clearTimeout(drag.timer);
            if (drag.started) {
                normalizeActionTail();
                drag.chip.classList.remove("is-dragging");
                if (drag.ghost && drag.ghost.parentNode) {
                    drag.ghost.parentNode.removeChild(drag.ghost);
                }
                document.body.classList.remove("tf-dragging");
                justDragged = true;   // suppress the click that follows a drag
                emitChange();
            }
            global.removeEventListener("pointermove", onPointerMove, true);
            global.removeEventListener("pointerup", endDrag, true);
            global.removeEventListener("pointercancel", endDrag, true);
            drag = null;
        };

        const onPointerMove = (e) => {
            if (!drag) return;
            const moved = Math.abs(e.clientX - drag.x0) +
                Math.abs(e.clientY - drag.y0);
            if (!drag.started) {
                // Touch: if it moves before the long-press fires, it's a scroll.
                if (drag.touch) { if (moved > 12) endDrag(); return; }
                if (moved > DRAG_THRESHOLD) beginDrag(e.clientX, e.clientY);
                else return;
            }
            e.preventDefault();
            moveGhost(e.clientX, e.clientY);
            reorderTo(e.clientX, e.clientY);
        };

        const onPointerDown = (e) => {
            // Shift+click is a range-selection gesture, never a drag.
            if (!cfg.reorder || (e.button && e.button !== 0) || e.shiftKey) {
                return;
            }
            const chip = e.target.closest && e.target.closest(".tf__chip");
            if (!chip || chip.classList.contains("tf__chip--pin") ||
                !flow.contains(chip)) {
                return;
            }
            drag = {
                chip,
                x0: e.clientX,
                y0: e.clientY,
                started: false,
                touch: e.pointerType === "touch",
                ghost: null,
                timer: 0
            };
            if (drag.touch) {
                drag.timer = global.setTimeout(() => {
                    if (drag && !drag.started) beginDrag(drag.x0, drag.y0);
                }, LONGPRESS_MS);
            }
            global.addEventListener("pointermove", onPointerMove, true);
            global.addEventListener("pointerup", endDrag, true);
            global.addEventListener("pointercancel", endDrag, true);
        };

        if (cfg.reorder) flow.addEventListener("pointerdown", onPointerDown);

        // ---- input wiring ----------------------------------------------------
        // ---- selection / navigation helpers ---------------------------------
        const nodeIfChip = (n) =>
            (n && n.nodeType === 1 && n.classList &&
                n.classList.contains("tf__chip") &&
                !n.classList.contains("tf__chip--pin")) ? n : null;

        /** The removable chip directly to the left of a collapsed caret. */
        const chipBeforeCaret = () => {
            const r = caretInFlow();
            if (!r || !r.collapsed) return null;
            const node = r.startContainer;
            const off = r.startOffset;
            if (node === flow) {
                return off > 0 ? nodeIfChip(flow.childNodes[off - 1]) : null;
            }
            if (node.nodeType === 3) {
                return off === 0 ? nodeIfChip(node.previousSibling) : null;
            }
            return off > 0 ? nodeIfChip(node.childNodes[off - 1]) : null;
        };

        /** The removable chip directly to the right of a collapsed caret. */
        const chipAfterCaret = () => {
            const r = caretInFlow();
            if (!r || !r.collapsed) return null;
            const node = r.startContainer;
            const off = r.startOffset;
            if (node === flow) return nodeIfChip(flow.childNodes[off]);
            if (node.nodeType === 3) {
                return off === node.nodeValue.length
                    ? nodeIfChip(node.nextSibling)
                    : null;
            }
            return nodeIfChip(node.childNodes[off]);
        };

        const currentRange = () => {
            const s = sel();
            return s && s.rangeCount ? s.getRangeAt(0) : null;
        };

        const clearSelectedChips = () => {
            flow.querySelectorAll(".tf__chip.is-selected").forEach((chip) => {
                chip.classList.remove("is-selected");
            });
        };

        const setRange = (r) => {
            clearSelectedChips();
            const s = sel();
            s.removeAllRanges();
            s.addRange(r);
        };

        /** Highlight a single chip by selecting it as an atomic unit. */
        const selectChip = (chip) => {
            const r = document.createRange();
            r.selectNode(chip);
            setRange(r);
            chip.classList.add("is-selected");
        };

        /** True if `node` sits at/after the given anchor in document order. */
        const chipIsAfter = (node, anchorNode, anchorOffset) => {
            const r = document.createRange();
            r.setStart(anchorNode, anchorOffset);
            r.collapse(true);
            try {
                return r.comparePoint(node, 0) >= 0;
            } catch (e) {
                return true;
            }
        };

        const rangeInFlow = (r) =>
            !!r && (flow.contains(r.commonAncestorContainer) ||
                r.commonAncestorContainer === flow);

        /** Serialize a cloned fragment: chips → token key, text → its value. */
        const serializeFragment = (frag) => {
            let out = "";
            Array.prototype.forEach.call(frag.childNodes, (node) => {
                let piece;
                if (node.nodeType === 1 && node.classList &&
                    node.classList.contains("tf__chip")) {
                    piece = node.dataset.key || node.textContent;
                } else if (node.nodeType === 1 && node.classList && (
                    node.classList.contains("tf__action") ||
                    node.classList.contains("tf__placeholder"))) {
                    return; // button / placeholder aren't content
                } else {
                    piece = (node.textContent || "").split(WJ).join("");
                }
                if (!piece) return;
                // Multiple copied tokens are separated by the configured
                // separator, or a space when none is set.
                const j = cfg.separator || " ";
                if (out && !out.endsWith(j) && !piece.startsWith(j)) out += j;
                out += piece;
            });
            return out;
        };

        const serializeSelection = () => {
            const r = currentRange();
            if (!r || r.collapsed || !rangeInFlow(r)) return "";
            return serializeFragment(r.cloneContents());
        };

        /** Delete the current (non-collapsed) selection, tokens and text. */
        const deleteSelectionContents = () => {
            const r = currentRange();
            if (!r || r.collapsed || !rangeInFlow(r)) return false;
            r.deleteContents();   // collapses r to the deletion point
            normalizeActionTail();
            setRange(r);
            emitChange();
            return true;
        };

        // ---- autocomplete menu ----------------------------------------------
        let menuItems = [];
        let menuActive = -1;
        let suggestSeq = 0;
        // Space accepts/descends the highlighted suggestion; a *fast* double
        // space instead commits the current path as a token (like Enter).
        let lastSpaceTime = 0;
        const SPACE_DOUBLE_MS = 300;

        const menuOpen = () => !!menu && !menu.hidden && menuItems.length > 0;

        /** The text node holding the text currently being typed, if any. */
        const pendingTextNode = () => {
            const r = caretInFlow();
            if (r && r.startContainer && r.startContainer.nodeType === 3) {
                return r.startContainer;
            }
            for (let i = flow.childNodes.length - 1; i >= 0; i--) {
                const node = flow.childNodes[i];
                if (node === wjNode || node === buttonEl) continue;
                if (node.nodeType === 1 && node.classList && (
                    node.classList.contains("tf__placeholder") ||
                    node.classList.contains("tf__action"))) {
                    continue;
                }
                if (node.nodeType === 3) return node;
            }
            return null;
        };

        const currentQuery = () => {
            const n = pendingTextNode();
            return n ? n.nodeValue : "";
        };

        // Placeholder hint shown (before the trailing button) while the field is
        // blurred and has no content (tokens or text).
        let phEl = null;
        const hasContent = () => middleParts().some((p) =>
            p.type === "token" || (p.type === "text" && p.value.trim()));
        const hidePlaceholder = () => {
            if (phEl && phEl.parentNode) phEl.parentNode.removeChild(phEl);
        };
        const showPlaceholder = () => {
            if (!cfg.placeholder || hasContent()) return;
            if (!phEl) {
                phEl = document.createElement("span");
                phEl.className = "tf__placeholder";
                phEl.contentEditable = "false";
                phEl.textContent = cfg.placeholder;
            }
            if (phEl.parentNode !== flow) {
                if (wjNode && wjNode.parentNode === flow) {
                    flow.insertBefore(phEl, wjNode);
                } else {
                    flow.appendChild(phEl);
                }
            }
        };

        const closeMenu = () => {
            lastSpaceTime = 0;
            if (!menu) return;
            menu.hidden = true;
            menu.innerHTML = "";
            menuItems = [];
            menuActive = -1;
        };

        const setActive = (idx) => {
            if (!menuItems.length) return;
            menuActive = (idx + menuItems.length) % menuItems.length;
            menuItems.forEach((it, i) => {
                if (it._row) it._row.classList.toggle("is-active", i === menuActive);
            });
            const el = menuItems[menuActive] && menuItems[menuActive]._row;
            if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
        };

        const acceptSuggestion = (item) => {
            if (!item) return;
            // Clicking a menu item can drop focus — restore it so the next key
            // (e.g. space to commit) is received by the editor.
            flow.focus();
            // A leaf (no children) — or an explicit token item — is committed as
            // a token. Anything with children descends: complete the text and
            // re-query so the children show immediately.
            const commitsToken = item.token === true ||
                item.hasChildren === false;
            if (commitsToken) {
                const textNode = pendingTextNode();
                if (textNode) {
                    const typedFragment = item.replaceText != null
                        ? String(item.replaceText)
                        : "";
                    if (typedFragment &&
                        textNode.nodeValue.toLowerCase().endsWith(
                            typedFragment.toLowerCase()
                        )) {
                        textNode.nodeValue = textNode.nodeValue.slice(
                            0,
                            textNode.nodeValue.length - typedFragment.length
                        );
                        const r = document.createRange();
                        r.setStart(textNode, textNode.nodeValue.length);
                        r.collapse(true);
                        setRange(r);
                    } else {
                        textNode.nodeValue = "";
                    }
                }
                const suggestedKey = cfg.normalize
                    ? String(cfg.normalize(item.value))
                    : item.value;
                if (suggestedKey && !(cfg.singleUse && isUsed(suggestedKey))) {
                    const def = byKey[String(suggestedKey).toLowerCase()];
                    insertToken(
                        def || {
                            key: suggestedKey,
                            label: suggestedKey,
                            title: item.hint || ""
                        },
                        !def
                    );
                }
                closeMenu();
                runInputValidation();
                return;
            }
            const textNode = pendingTextNode();
            if (textNode) {
                textNode.nodeValue = item.value;
                const r = document.createRange();
                r.setStart(textNode, textNode.nodeValue.length);
                r.collapse(true);
                setRange(r);
            } else {
                const tn = document.createTextNode(item.value);
                if (wjNode && wjNode.parentNode === flow) {
                    flow.insertBefore(tn, wjNode);
                } else {
                    flow.appendChild(tn);
                }
                const r = document.createRange();
                r.setStart(tn, tn.nodeValue.length);
                r.collapse(true);
                setRange(r);
            }
            emitChange();
            runSuggest();
            runInputValidation();
        };

        const renderMenu = (items) => {
            if (!menu) return;
            // Mark suggestions whose value is already a token (singleUse), then
            // optionally drop them.
            let all = (items || []).map((it) => {
                const key = cfg.normalize
                    ? String(cfg.normalize(it.value))
                    : String(it.value);
                return (cfg.singleUse && isUsed(key))
                    ? Object.assign({}, it, { _used: true })
                    : it;
            });
            if (cfg.hideUsedSuggestions) all = all.filter((it) => !it._used);
            menu.innerHTML = "";
            if (!all.length) { closeMenu(); return; }
            // Only the first N are shown; the rest collapse behind a "…" hint.
            const visible = all.slice(0, cfg.menuMaxItems);
            menuItems = [];   // navigable (non-used) items only
            visible.forEach((it) => {
                const row = document.createElement("div");
                row.className = "tf__menu-item";
                const lbl = document.createElement("span");
                lbl.className = "tf__menu-label";
                lbl.textContent = it.label != null ? it.label : it.value;
                row.appendChild(lbl);
                if (it.hint) {
                    const h = document.createElement("span");
                    h.className = "tf__menu-hint";
                    h.textContent = it.hint;
                    row.appendChild(h);
                }
                if (it._used) {
                    // Already added (singleUse) — shown disabled, not selectable.
                    row.classList.add("is-used");
                    row.setAttribute("aria-disabled", "true");
                    row.addEventListener("mousedown", (e) => e.preventDefault());
                } else {
                    it._row = row;
                    // mousedown (not click) so the flow keeps focus through accept.
                    row.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        acceptSuggestion(it);
                    });
                    menuItems.push(it);
                }
                menu.appendChild(row);
            });
            if (all.length > visible.length) {
                const more = document.createElement("div");
                more.className = classNames("tf__menu-item", "tf__menu-more");
                more.setAttribute("aria-disabled", "true");
                more.title = "Type more to narrow the results";
                more.textContent = "…";
                more.addEventListener("mousedown", (e) => e.preventDefault());
                menu.appendChild(more);
            }
            menuActive = menuItems.length ? 0 : -1;
            if (menuActive === 0) menuItems[0]._row.classList.add("is-active");
            menu.hidden = false;
        };

        function runSuggest() {
            if (!cfg.suggest) return;
            const q = currentQuery();
            // Only open once the text's first character is a configured trigger.
            if (cfg.suggestTrigger &&
                (!q || cfg.suggestTrigger.indexOf(q.charAt(0)) < 0)) {
                closeMenu();
                return;
            }
            const seq = ++suggestSeq;
            Promise.resolve(cfg.suggest(q)).then((items) => {
                if (seq !== suggestSeq) return; // a newer query superseded this
                renderMenu((items || []).map(
                    (it) => (typeof it === "string" ? { value: it } : it)
                ));
            }).catch(() => closeMenu());
        }

        // Live validity styling: while there is pending text that doesn't pass
        // validateCustom, mark the flow invalid (so the input can be styled).
        let validateSeq = 0;
        const runInputValidation = () => {
            const text = currentQuery().trim();
            if (!text) {
                validateSeq++;
                flow.classList.remove("is-invalid");
                flow.removeAttribute("aria-invalid");
                return;
            }
            if (!cfg.allowFreeText && !cfg.allowCustomTokens) {
                const hit = tokenFromText(text);
                const invalid = !hit;
                flow.classList.toggle("is-invalid", invalid);
                flow.setAttribute("aria-invalid", invalid ? "true" : "false");
                return;
            }
            if (!cfg.validateCustom) {
                validateSeq++;
                flow.classList.remove("is-invalid");
                flow.removeAttribute("aria-invalid");
                return;
            }
            const seq = ++validateSeq;
            Promise.resolve(cfg.validateCustom(text)).then((ok) => {
                if (seq !== validateSeq) return;
                flow.classList.toggle("is-invalid", !ok);
                flow.setAttribute("aria-invalid", ok ? "false" : "true");
            }).catch(() => {});
        };

        // Add a list of strings as tokens, validating each (used by paste:
        // split on whitespace → validate → multi-add). Invalid/unknown and
        // duplicate entries are silently skipped.
        const addValidatedTokens = (pieces) => {
            let chain = Promise.resolve();
            pieces.forEach((piece) => {
                chain = chain.then(() => Promise.resolve(
                    cfg.validateCustom ? cfg.validateCustom(piece) : true
                ).then((ok) => {
                    if (!ok) return;
                    const t = tokenFromText(piece);
                    if (!t) return;
                    placeCaretAtFlowEnd();
                    insertToken(t.def, t.custom);
                }));
            });
            chain.then(() => { emitChange(); runInputValidation(); });
        };

        // Backspace / Delete on a token "explodes" it back into editable free
        // text, dropping the last (back) or first (fwd) character — so you can
        // fix a committed token instead of only removing it whole.
        const explodeChip = (chip, mode) => {
            let text = chip.dataset.key || chip.textContent || "";
            text = mode === "back" ? text.slice(0, -1) : text.slice(1);
            const tn = document.createTextNode(text);
            chip.parentNode.replaceChild(tn, chip);
            const r = document.createRange();
            r.setStart(tn, mode === "back" ? tn.nodeValue.length : 0);
            r.collapse(true);
            setRange(r);
            emitChange();
            runSuggest();
            runInputValidation();
        };

        flow.addEventListener("keydown", (e) => {
            // Autocomplete navigation while the menu is open. Enter is NOT an
            // accept key here — it commits the current text as a token (below).
            // Tab accepts the highlighted suggestion (descend, or add if leaf).
            if (menuOpen()) {
                if (e.key === "ArrowDown") {
                    e.preventDefault(); lastSpaceTime = 0;
                    setActive(menuActive + 1); return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault(); lastSpaceTime = 0;
                    setActive(menuActive - 1); return;
                }
                if (e.key === "Tab") {
                    e.preventDefault();
                    acceptSuggestion(menuItems[menuActive]);
                    return;
                }
                // Enter accepts the highlighted suggestion for plain autocomplete
                // fields. With commitOnSpace (folder browser) Enter still commits
                // the typed path, so let it fall through there.
                if (e.key === "Enter" && !cfg.commitOnSpace) {
                    e.preventDefault();
                    acceptSuggestion(menuItems[menuActive]);
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault(); closeMenu(); return;
                }
                // Space accepts the highlighted suggestion. With commitOnSpace
                // (the folder-browser case) it also descends a level and a FAST
                // double-space commits the current path — except when more than
                // one candidate continues with a space right after what's typed
                // (e.g. "Application Support" vs "Application Xxx"), where the
                // space is ambiguous and is typed literally to keep narrowing.
                if (e.key === " " || e.key === "Spacebar") {
                    if (!cfg.commitOnSpace) {
                        // Plain autocomplete fields: space accepts the
                        // highlighted suggestion (insert/complete it).
                        e.preventDefault();
                        acceptSuggestion(menuItems[menuActive]);
                        return;
                    }
                    const q = currentQuery();
                    const ql = q.toLowerCase();
                    let spacey = 0;
                    for (let i = 0; i < menuItems.length; i++) {
                        const v = String(menuItems[i].value || "");
                        if (v.length > q.length &&
                            v.toLowerCase().indexOf(ql) === 0 &&
                            v.charAt(q.length) === " ") {
                            spacey++;
                            if (spacey >= 2) break;
                        }
                    }
                    if (spacey >= 2) {
                        lastSpaceTime = 0;
                        return;   // ambiguous — let the space type into the field
                    }
                    e.preventDefault();
                    const now = Date.now();
                    if (now - lastSpaceTime < SPACE_DOUBLE_MS) {
                        lastSpaceTime = 0;
                        closeMenu();
                        commitPendingText(true);
                        runInputValidation();
                    } else {
                        lastSpaceTime = now;
                        acceptSuggestion(menuItems[menuActive]);
                    }
                    return;
                }
            }
            const isSep = cfg.separator && e.key === cfg.separator;
            const isSpace = cfg.commitOnSpace &&
                (e.key === " " || e.key === "Spacebar");
            const tokenCommitKey = !cfg.allowFreeText || cfg.allowCustomTokens;
            if (
                e.key === "Enter" ||
                (tokenCommitKey && (e.key === "," || isSep || isSpace))
            ) {
                e.preventDefault();
                closeMenu();
                commitPendingText(true);
                runInputValidation();
                return;
            }

            // Cmd/Ctrl + Left/Right jump the caret to the start/end of the line
            // (the whole editable region); with Shift it extends the selection.
            if ((e.metaKey || e.ctrlKey) && !e.altKey &&
                (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                e.preventDefault();
                const toStart = e.key === "ArrowLeft";
                const edge = document.createRange();
                edge.selectNodeContents(flow);
                edge.collapse(toStart);
                if (e.shiftKey) {
                    const s = sel();
                    if (s && s.rangeCount && flow.contains(s.anchorNode)) {
                        s.setBaseAndExtent(
                            s.anchorNode, s.anchorOffset,
                            edge.startContainer, edge.startOffset
                        );
                        return;
                    }
                }
                setRange(edge);
                return;
            }

            // Plain (no-modifier) arrows first HIGHLIGHT an adjacent token; a
            // second press collapses the caret past it. Shift / word arrows fall
            // through to the browser's native range extension.
            const plainArrow = !e.shiftKey && !e.ctrlKey &&
                !e.metaKey && !e.altKey;
            if (plainArrow && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                const toLeft = e.key === "ArrowLeft";
                const r = currentRange();
                if (r && !r.collapsed) {
                    e.preventDefault();
                    r.collapse(toLeft);   // before (left) / after (right)
                    setRange(r);
                    return;
                }
                const chip = toLeft ? chipBeforeCaret() : chipAfterCaret();
                if (chip) {
                    e.preventDefault();
                    selectChip(chip);
                }
                return;
            }

            if (e.key === "Backspace") {
                if (deleteSelectionContents()) { e.preventDefault(); return; }
                const chip = chipBeforeCaret();
                if (chip) { e.preventDefault(); explodeChip(chip, "back"); }
                return;
            }
            if (e.key === "Delete") {
                if (deleteSelectionContents()) { e.preventDefault(); return; }
                const chip = chipAfterCaret();
                if (chip) { e.preventDefault(); explodeChip(chip, "fwd"); return; }
                // Don't let forward-delete consume the trailing word-joiner/button.
                const r = caretInFlow();
                if (r && r.collapsed) {
                    const n = r.startContainer;
                    const off = r.startOffset;
                    let nxt = null;
                    if (n === flow) nxt = flow.childNodes[off];
                    else if (n.nodeType === 3 && off === n.nodeValue.length) {
                        nxt = n.nextSibling;
                    }
                    if (nxt && ((nxt.nodeType === 3 &&
                        nxt.nodeValue.split(WJ).join("") === "") ||
                        (nxt.nodeType === 1 && nxt.classList &&
                            nxt.classList.contains("tf__action")))) {
                        e.preventDefault();
                    }
                }
                return;
            }
        });

        flow.addEventListener("beforeinput", () => {
            normalizeActionTail();
            clampCaretBeforeAction();
        });

        // Cut / copy: write the selection (tokens + free text) as plain text.
        flow.addEventListener("copy", (e) => {
            const text = serializeSelection();
            if (!text) return;
            e.preventDefault();
            (e.clipboardData || global.clipboardData)
                .setData("text/plain", text);
        });
        flow.addEventListener("cut", (e) => {
            const text = serializeSelection();
            if (!text) return;
            e.preventDefault();
            (e.clipboardData || global.clipboardData)
                .setData("text/plain", text);
            deleteSelectionContents();
        });

        // Selection range behavior is left to the browser, while single-chip
        // clicks add .is-selected so the chip owns its own highlight.

        flow.addEventListener("input", () => {
            normalizeActionTail();
            clampCaretBeforeAction();
            // Real typing breaks any pending double-space.
            lastSpaceTime = 0;
            // Live text node typing is allowed; if free text is forbidden and a
            // typed run exactly matches a token, auto-tokenize as you go.
            if (!cfg.allowFreeText) {
                // soft attempt: only converts on exact token match, never
                // discards mid-typing.
                const r = caretInFlow();
                const node = r && r.startContainer;
                if (node && node.nodeType === 3) {
                    const t = byKey[node.nodeValue.trim().toLowerCase()];
                    if (t && !t.pin) commitPendingText(false);
                }
            }
            emitChange();
            runSuggest();
            runInputValidation();
        });

        flow.addEventListener("focus", () => {
            hidePlaceholder();
            runSuggest();
            runInputValidation();
            clampCaretSoon();
        });
        flow.addEventListener("blur", () => {
            closeMenu();
            commitPendingText(true);
            // Drop the token highlight (a class, plus the native selection) so a
            // selected/arrow-highlighted token doesn't stay highlighted after
            // focus leaves the field.
            clearSelectedChips();
            const s = sel();
            if (s && s.rangeCount && flow.contains(s.anchorNode)) {
                s.removeAllRanges();
            }
            // commitPendingText may resolve its validation on a microtask; only
            // re-check validity and show the placeholder once the text has
            // settled, so the invalid style isn't left on the field/placeholder.
            Promise.resolve().then(() => {
                runInputValidation();
                showPlaceholder();
            });
        });

        // Any mousedown that isn't on a token (the trailing button, empty space,
        // other UI…) drops a token highlight — covers cases blur doesn't (e.g.
        // the in-flow button, which keeps focus). Shift-click keeps extending.
        const clearHighlightOnOutsideDown = (e) => {
            if (e.shiftKey) return;
            const onChip = e.target && e.target.closest &&
                flow.contains(e.target) && e.target.closest(".tf__chip");
            if (onChip) return;   // clicking a token re-selects via the click handler
            clearSelectedChips();
            const s = sel();
            if (s && s.rangeCount && flow.contains(s.anchorNode)) {
                s.removeAllRanges();
            }
        };
        document.addEventListener("mousedown", clearHighlightOnOutsideDown, true);

        // Allow clicking to place the caret BEFORE the first token when there is
        // no free text before it (the browser otherwise can't put a caret there).
        flow.addEventListener("mousedown", (e) => {
            hidePlaceholder();

            // Shift+click extends the selection from the current anchor to the
            // click point; clicking on a token includes the whole token.
            if (e.shiftKey) {
                const s = sel();
                if (s && s.rangeCount && flow.contains(s.anchorNode)) {
                    const aNode = s.anchorNode;
                    const aOff = s.anchorOffset;
                    let fNode = null;
                    let fOff = 0;
                    const chip = e.target.closest &&
                        e.target.closest(".tf__chip");
                    if (chip && chip.parentNode === flow) {
                        const idx = Array.prototype.indexOf.call(
                            flow.childNodes, chip
                        );
                        fNode = flow;
                        fOff = chipIsAfter(chip, aNode, aOff) ? idx + 1 : idx;
                    } else if (document.caretRangeFromPoint) {
                        const cr = document.caretRangeFromPoint(
                            e.clientX, e.clientY
                        );
                        if (cr && flow.contains(cr.startContainer)) {
                            fNode = cr.startContainer;
                            fOff = cr.startOffset;
                        }
                    }
                    if (fNode) {
                        e.preventDefault();
                        s.setBaseAndExtent(aNode, aOff, fNode, fOff);
                    }
                }
                return;
            }

            if (clampPointBeforeAction(e.clientX, e.clientY)) {
                e.preventDefault();
                return;
            }

            // Click left of the first token (no text before it) → caret at start.
            const first = flow.firstChild;
            if (first && first.nodeType === 1 &&
                first.classList.contains("tf__chip")) {
                const box = first.getBoundingClientRect();
                if (e.clientX < box.left) {
                    e.preventDefault();
                    flow.focus();
                    const r = document.createRange();
                    r.setStart(flow, 0);
                    r.collapse(true);
                    setRange(r);
                }
            }
        });
        flow.addEventListener("mouseup", clampCaretSoon);
        flow.addEventListener("keyup", clampCaretBeforeAction);

        // A plain click on a token selects it immediately (also on the first
        // click while the field is unfocused). A click right after a drag is
        // ignored so reordering doesn't leave the chip selected.
        flow.addEventListener("click", (e) => {
            if (e.shiftKey) return;
            if (justDragged) { justDragged = false; return; }
            const chip = e.target.closest && e.target.closest(".tf__chip");
            if (chip && flow.contains(chip) &&
                !chip.classList.contains("tf__chip--pin")) {
                selectChip(chip);
            }
        });

        // Double-click a token → re-pick (e.g. open the folder chooser at that
        // location); a chosen value replaces the token's path.
        flow.addEventListener("dblclick", (e) => {
            if (!cfg.onTokenDblClick) return;
            const chip = e.target.closest && e.target.closest(".tf__chip");
            if (!chip || !flow.contains(chip) ||
                chip.classList.contains("tf__chip--pin")) {
                return;
            }
            e.preventDefault();
            Promise.resolve(cfg.onTokenDblClick(chip.dataset.key)).then((nv) => {
                if (nv == null || nv === "") return;
                const key = cfg.normalize ? String(cfg.normalize(nv)) : String(nv);
                if (!key) return;
                if (cfg.singleUse && isUsedByOtherChip(key, chip)) return;
                chip.dataset.key = key;
                chip.dataset.label = key;
                const lbl = chip.querySelector(".tf__chip-label");
                if (lbl) lbl.textContent = key;
                emitChange();
            });
        });

        flow.addEventListener("paste", (e) => {
            e.preventDefault();
            const raw = (e.clipboardData || global.clipboardData)
                .getData("text/plain");
            // Token fields: split the pasted text on whitespace and add each
            // piece as a validated token (multi-add). Plain free-text fields
            // just insert the text.
            if (cfg.allowCustomTokens || (!cfg.allowFreeText && defs.length)) {
                const pieces = raw.split(/\s+/).filter(Boolean);
                addValidatedTokens(pieces);
            } else {
                document.execCommand(
                    "insertText", false, raw.replace(/[\r\n]+/g, " ")
                );
                global.setTimeout(() => {
                    normalizeActionTail();
                    clampCaretBeforeAction();
                    emitChange();
                }, 0);
            }
        });

        flow.addEventListener("drop", () => {
            global.setTimeout(() => {
                normalizeActionTail();
                clampCaretBeforeAction();
                emitChange();
            }, 0);
        });

        const onDocumentSelectionChange = () => {
            if (document.activeElement === flow) clampCaretBeforeAction();
        };
        document.addEventListener("selectionchange", onDocumentSelectionChange);

        // Clicking empty field space focuses the flow at its end (never before
        // a start-pin / after an end-pin, which are outside the flow).
        field.addEventListener("mousedown", (e) => {
            if (e.target === field) {
                e.preventDefault();
                placeCaretAtFlowEnd();
            }
        });

        // ---- pinned chips (outside the flow) + trailing button (inside it) ----
        startPins.forEach((d) => field.insertBefore(tokenChip(d, false), flow));
        endPins.forEach((d) => field.appendChild(tokenChip(d, false)));

        if (cfg.trailingButton) {
            buttonEl = document.createElement("button");
            buttonEl.type = "button";
            buttonEl.className = "tf__action";
            buttonEl.contentEditable = "false";
            buttonEl.textContent = cfg.trailingButton.label || "Add";
            if (cfg.trailingButton.title) buttonEl.title = cfg.trailingButton.title;
            buttonEl.addEventListener("mousedown", (e) => e.preventDefault());
            buttonEl.addEventListener("click", (e) => {
                e.preventDefault();
                if (typeof cfg.trailingButton.onClick === "function") {
                    cfg.trailingButton.onClick(instance);
                }
            });
            // Word-joiner before the button removes the break opportunity there,
            // so the button never wraps alone — the preceding token/word comes
            // down with it. renderMiddle keeps both as the flow's last children.
            wjNode = document.createTextNode(WJ);
            flow.appendChild(wjNode);
            flow.appendChild(buttonEl);
        }

        // ---- initial value ---------------------------------------------------
        const setValue = (value) => {
            const parts = [];
            const usedKeys = {};
            const addPart = (part) => {
                if (part.type === "token" && cfg.singleUse) {
                    if (cfg.normalize) {
                        part.key = String(cfg.normalize(part.key || ""));
                    }
                    const key = String(part.key || "").toLowerCase();
                    if (!key || usedKeys[key]) return;
                    usedKeys[key] = true;
                }
                parts.push(part);
            };
            (value || []).forEach((v) => {
                if (v && typeof v === "object") {
                    if (v.token != null) {
                        addPart({ type: "token", key: String(v.token) });
                    } else if (v.text != null) {
                        addPart({ type: "text", value: String(v.text) });
                    }
                    return;
                }
                const s = String(v);
                const hit = byKey[s.toLowerCase()];
                if (hit && !hit.pin) {
                    addPart({ type: "token", key: hit.key });
                } else if (cfg.allowCustomTokens) {
                    addPart({ type: "token", key: s, custom: true });
                } else {
                    addPart({ type: "text", value: s });
                }
            });
            renderMiddle(parts);
            if (palette) renderPalette();
            // Field starts (and re-renders) blurred → show the placeholder hint
            // after any tokens.
            if (document.activeElement !== flow) showPlaceholder();
        };
        setValue(o.value);

        // ---- public instance -------------------------------------------------
        const instance = {
            element: root,
            getParts,
            getValues,
            getText,
            setValue,
            addToken,
            addCustom,
            focus: placeCaretAtFlowEnd,
            destroy: () => {
                document.removeEventListener(
                    "selectionchange",
                    onDocumentSelectionChange
                );
                document.removeEventListener(
                    "mousedown",
                    clearHighlightOnOutsideDown,
                    true
                );
                if (root.parentNode) root.parentNode.removeChild(root);
            }
        };
        return instance;
    }

    global.TokenField = {
        create: (options) => new TokenField(options),
        attach: (container, options) => {
            const tf = new TokenField(options);
            if (container) container.appendChild(tf.element);
            return tf;
        }
    };
})(typeof window !== "undefined" ? window : this);
