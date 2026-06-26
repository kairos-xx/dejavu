/**
 * TokenInput — reusable hierarchical token input (vendored).
 * Source: token_mixed_input.html (author's library), unmodified except
 * for an added insertItemAtCaret() public method used by the token
 * palette. Exposes window.TokenInput.
 */
(() => {
  "use strict";

  const ZWSP = "\u200b";
  const ACTIVE_HIGHLIGHT = "token-input-active-path";

  const isElement = value => value instanceof Element;
  const isText = node => node && node.nodeType === Node.TEXT_NODE;
  const escapeHtml = value => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const cleanText = value => String(value).replaceAll(ZWSP, "");
  const sameText = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const starts = (a, b) => String(a).toLowerCase().startsWith(String(b).toLowerCase());
  const includes = (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase());
  const isBoundary = value => !value || /[\s\u200b]/.test(value);
  const escapeCss = value => window.CSS?.escape
    ? CSS.escape(String(value))
    : String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');

  class TokenInput {
    static attach(target, config = {}) {
      const element = typeof target === "string"
        ? document.querySelector(target)
        : target;
      if (!isElement(element)) throw new Error("TokenInput target was not found.");
      return new TokenInput(element, config);
    }

    constructor(target, config = {}) {
      this.original = target;
      this.originalDisplay = target.style.display;
      this.config = this.mergeConfig(config);
      this.systems = this.normalizeSystems(this.config.systems);
      this.systemByTrigger = new Map(this.systems.map(system => [system.trigger, system]));
      this.editor = this.createEditor(target);
      this.shell = this.editor.closest(".token-shell");
      this.menu = document.createElement("div");
      this.menu.className = "token-menu";
      this.menu.setAttribute("role", "listbox");
      document.body.appendChild(this.menu);
      this.dropCaret = document.createElement("span");
      this.dropCaret.className = "token-drop-caret";
      this.dropCaret.hidden = true;
      document.body.appendChild(this.dropCaret);
      this.drag = null;
      this.activeMention = null;
      this.rows = [];
      this.selectedIndex = 0;
      this.disabled = Boolean(this.config.disabled);
      this.suppressed = null;
      this.bound = {
        input: event => this.onInput(event),
        beforeinput: event => this.onBeforeInput(event),
        keydown: event => this.onKeyDown(event),
        paste: event => this.onPaste(event),
        pointerdown: event => this.onPointerDown(event),
        pointermove: event => this.onPointerMove(event),
        pointerup: event => this.onPointerUp(event),
        pointercancel: event => this.onPointerCancel(event),
        mousedown: event => this.onMouseDown(event),
        mousemove: event => this.onMouseMove(event),
        mouseup: event => this.onMouseUp(event),
        selectionchange: () => this.onSelectionChange(),
        resize: () => this.positionMenu(),
        scroll: () => this.positionMenu()
      };
      this.editor.addEventListener("input", this.bound.input);
      this.editor.addEventListener("beforeinput", this.bound.beforeinput);
      this.editor.addEventListener("keydown", this.bound.keydown);
      this.editor.addEventListener("paste", this.bound.paste);
      this.editor.addEventListener("pointerdown", this.bound.pointerdown);
      window.addEventListener("pointermove", this.bound.pointermove, { passive: false });
      window.addEventListener("pointerup", this.bound.pointerup, { passive: false });
      window.addEventListener("pointercancel", this.bound.pointercancel);
      // Desktop drag goes through plain mouse events: embedded runtime's older
      // Chromium handles Pointer Events + setPointerCapture unreliably,
      // so the mouse path is what actually fires in the panel. Pointer
      // events are kept for touch/pen (onPointerDown bails on mouse).
      this.editor.addEventListener("mousedown", this.bound.mousedown);
      window.addEventListener("mousemove", this.bound.mousemove);
      window.addEventListener("mouseup", this.bound.mouseup);
      document.addEventListener("selectionchange", this.bound.selectionchange);
      window.addEventListener("resize", this.bound.resize);
      window.visualViewport?.addEventListener("resize", this.bound.resize);
      window.visualViewport?.addEventListener("scroll", this.bound.scroll);
      this.menu.addEventListener("pointerdown", event => event.preventDefault());
      this.setDisabled(this.disabled);
      this.ensureInitialContent();
      this.normalizeBoundaries();
      this.update();
    }

    mergeConfig(config) {
      return {
        placeholder: "Ask the agent, mention files with @, issues with #, commands with /…",
        disabled: false,
        autoTokenizeExactOnSpace: true,
        hideUsedSingleTokens: true,
        singleUseAll: false,
        systems: [],
        dropdown: {
          placement: "outside-editor",
          maxItems: 12,
          renderItem: null,
          emptyHtml: "No matching options.",
          className: ""
        },
        token: {
          render: null
        },
        onChange: null,
        ...config,
        dropdown: {
          placement: "outside-editor",
          maxItems: 12,
          renderItem: null,
          emptyHtml: "No matching options.",
          className: "",
          ...(config.dropdown || {})
        },
        token: {
          render: null,
          ...(config.token || {})
        }
      };
    }

    normalizeSystems(systems) {
      return systems.map((system, systemIndex) => {
        const normalized = {
          id: system.id || system.name || `system_${systemIndex}`,
          name: system.name || system.id || `system_${systemIndex}`,
          trigger: system.trigger,
          icon: system.icon || system.trigger,
          tokenClass: system.tokenClass || "",
          items: []
        };
        normalized.items = this.normalizeItems(system.items || [], normalized, []);
        return normalized;
      });
    }

    normalizeItems(items, system, parentPath) {
      return items.map((item, index) => {
        const key = item.key || item.value || item.label || String(index);
        const path = [...parentPath, key];
        const hasChildren = Array.isArray(item.children) && item.children.length > 0;
        const normalized = {
          id: item.id || `${system.id}:${path.join("/")}`,
          key,
          label: item.label || key,
          description: item.description || "",
          icon: item.icon || (hasChildren ? "›" : system.icon),
          path,
          pathText: path.join("/"),
          kind: hasChildren ? "branch" : "token",
          children: [],
          disabled: Boolean(item.disabled),
          deletable: item.deletable !== false,
          movable: item.movable !== false,
          tokenDisabled: Boolean(item.tokenDisabled),
          singleUse: Boolean(item.singleUse),
          tokenClass: item.tokenClass || "",
          dropdownClass: item.dropdownClass || "",
          tokenStyle: item.tokenStyle || null,
          dropdownStyle: item.dropdownStyle || null,
          payload: item.payload || null,
          html: item.html || null,
          dropdownHtml: item.dropdownHtml || null,
          raw: item
        };
        normalized.children = this.normalizeItems(item.children || [], system, path);
        return normalized;
      });
    }

    createEditor(target) {
      const isFormControl = target.matches("textarea,input");
      if (isFormControl) {
        const shell = document.createElement("div");
        const editor = document.createElement("div");
        shell.className = "token-shell";
        editor.className = "token-editor";
        editor.textContent = target.value || "";
        target.after(shell);
        shell.appendChild(editor);
        target.style.display = "none";
        target.setAttribute("data-token-input-source", "true");
        this.formSource = target;
        return editor;
      }
      if (!target.parentElement?.classList.contains("token-shell")) {
        const shell = document.createElement("div");
        shell.className = "token-shell";
        target.parentNode.insertBefore(shell, target);
        shell.appendChild(target);
      }
      target.classList.add("token-editor");
      return target;
    }

    ensureInitialContent() {
      this.editor.setAttribute("role", "textbox");
      this.editor.setAttribute("aria-multiline", "true");
      this.editor.setAttribute("spellcheck", "true");
      this.editor.setAttribute("autocapitalize", "off");
      this.editor.setAttribute("autocomplete", "off");
      this.editor.dataset.placeholder = this.config.placeholder;
      if (!this.editor.textContent) this.editor.appendChild(document.createTextNode(ZWSP));
      if (this.config.initialParts) this.setParts(this.config.initialParts);
    }

    setDisabled(value) {
      this.disabled = Boolean(value);
      this.editor.contentEditable = this.disabled ? "false" : "true";
      this.editor.setAttribute("aria-disabled", String(this.disabled));
      this.closeMenu();
      this.editor.querySelectorAll(".token-chip").forEach(token => {
        token.setAttribute("aria-disabled", String(this.disabled || token.classList.contains("is-disabled")));
      });
    }

    destroy() {
      this.closeMenu();
      this.clearHighlight();
      this.editor.removeEventListener("input", this.bound.input);
      this.editor.removeEventListener("beforeinput", this.bound.beforeinput);
      this.editor.removeEventListener("keydown", this.bound.keydown);
      this.editor.removeEventListener("paste", this.bound.paste);
      this.editor.removeEventListener("pointerdown", this.bound.pointerdown);
      window.removeEventListener("pointermove", this.bound.pointermove);
      window.removeEventListener("pointerup", this.bound.pointerup);
      window.removeEventListener("pointercancel", this.bound.pointercancel);
      this.editor.removeEventListener("mousedown", this.bound.mousedown);
      window.removeEventListener("mousemove", this.bound.mousemove);
      window.removeEventListener("mouseup", this.bound.mouseup);
      document.removeEventListener("selectionchange", this.bound.selectionchange);
      window.removeEventListener("resize", this.bound.resize);
      window.visualViewport?.removeEventListener("resize", this.bound.resize);
      window.visualViewport?.removeEventListener("scroll", this.bound.scroll);
      this.menu.remove();
      this.dropCaret.remove();
      if (this.formSource) this.formSource.style.display = this.originalDisplay;
    }

    focus() {
      this.editor.focus();
      const range = document.createRange();
      range.selectNodeContents(this.editor);
      range.collapse(false);
      this.setSelection(range);
    }

    /**
     * Inserts a token for the given trigger + path at the current caret
     * (or the end of the editor if there is no caret inside it). Added
     * for palette-style insertion where a click outside the editor adds
     * a token. Returns true when a token was inserted.
     */
    insertItemAtCaret(trigger, path) {
      if (this.disabled) return false;
      const system = this.systemByTrigger.get(trigger);
      if (!system) return false;
      const item = this.findNodeByPath(system.items, path);
      if (!item || item.kind !== "token") return false;
      if (this.isUsedAndHidden(item)) return false;
      this.editor.focus();
      let range = this.getCollapsedRange();
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(this.editor);
        range.collapse(false);
        this.setSelection(range);
      }
      range.deleteContents();
      const token = this.createToken(system, item);
      const before = document.createTextNode(ZWSP);
      const after = document.createTextNode(ZWSP);
      range.insertNode(after);
      range.insertNode(token);
      range.insertNode(before);
      const caret = document.createRange();
      caret.setStart(after, after.data.length);
      caret.collapse(true);
      this.setSelection(caret);
      this.suppressed = null;
      this.normalizeBoundaries();
      this.closeMenu();
      this.update();
      return true;
    }

    setText(text) {
      this.editor.textContent = text || ZWSP;
      this.normalizeBoundaries();
      this.update();
    }

    setParts(parts) {
      this.editor.replaceChildren();
      parts.forEach(part => {
        if (part.type === "token") {
          const system = this.systemByTrigger.get(part.trigger);
          const item = system ? this.findNodeByPath(system.items, part.path || part.pathText || part.value) : null;
          if (system && item) this.appendToken(system, item);
        } else {
          this.editor.appendChild(document.createTextNode(part.value || part.text || ""));
        }
      });
      if (!this.editor.childNodes.length) this.editor.appendChild(document.createTextNode(ZWSP));
      this.normalizeBoundaries();
      this.update();
    }

    getText() {
      return this.getParts().map(part => part.type === "token"
        ? `${part.trigger}${part.pathText}`
        : part.value
      ).join("");
    }

    getParts() {
      const parts = [];
      this.editor.childNodes.forEach(node => {
        if (isText(node)) {
          const text = cleanText(node.data);
          if (text) parts.push({ type: "text", value: text });
          return;
        }
        if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains("token-chip")) {
          parts.push({
            type: "token",
            trigger: node.dataset.trigger,
            system: node.dataset.system,
            id: node.dataset.itemId,
            path: node.dataset.path.split("/"),
            pathText: node.dataset.path,
            label: node.dataset.label,
            disabled: node.classList.contains("is-disabled"),
            locked: node.classList.contains("is-locked"),
            pinned: node.classList.contains("is-pinned")
          });
        }
      });
      return this.mergeTextParts(parts);
    }

    mergeTextParts(parts) {
      const merged = [];
      parts.forEach(part => {
        const previous = merged[merged.length - 1];
        if (part.type === "text" && previous?.type === "text") previous.value += part.value;
        else merged.push(part);
      });
      return merged;
    }

    onInput() {
      this.normalizeBoundaries();
      this.update();
    }

    onBeforeInput(event) {
      if (this.disabled) {
        event.preventDefault();
        return;
      }
      if (event.inputType === "deleteContentBackward") {
        const token = this.previousTokenFromCaret();
        if (token) {
          event.preventDefault();
          this.suppressed = null;
          this.explodeToken(token, "backward");
        }
      }
      if (event.inputType === "deleteContentForward") {
        const token = this.nextTokenFromCaret();
        if (token) {
          event.preventDefault();
          this.suppressed = null;
          this.explodeToken(token, "forward");
        }
      }
    }

    onKeyDown(event) {
      if (this.disabled) return;
      const movementKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];
      if (movementKeys.includes(event.key)) this.suppressed = null;
      if (event.key === "Escape") {
        if (this.activeMention) this.suppressed = {
          node: this.activeMention.node,
          start: this.activeMention.start,
          trigger: this.activeMention.trigger
        };
        this.closeMenu();
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && this.menu.classList.contains("is-open")) {
        this.suppressed = null;
      }
      if (event.key === "Backspace") {
        const token = this.previousTokenFromCaret();
        if (token) {
          event.preventDefault();
          this.explodeToken(token, "backward");
          return;
        }
      }
      if (event.key === "Delete") {
        const token = this.nextTokenFromCaret();
        if (token) {
          event.preventDefault();
          this.explodeToken(token, "forward");
          return;
        }
      }
      // Step the caret over a whole token (and its zero-width-space
      // boundaries) in a single press. Without this, the contentEditable
      // caret stops on each ZWSP and on the non-editable token, so it
      // takes several presses to cross one token.
      if (event.key === "ArrowRight" && !event.shiftKey &&
          !event.metaKey && !event.altKey &&
          !this.menu.classList.contains("is-open")) {
        const token = this.nextTokenFromCaret();
        if (token) {
          event.preventDefault();
          this.placeCaretAfterToken(token);
          return;
        }
      }
      if (event.key === "ArrowLeft" && !event.shiftKey &&
          !event.metaKey && !event.altKey &&
          !this.menu.classList.contains("is-open")) {
        const token = this.previousTokenFromCaret();
        if (token) {
          event.preventDefault();
          this.placeCaretBeforeToken(token);
          return;
        }
      }
      if (this.menu.classList.contains("is-open")) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          this.moveSelection(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          this.moveSelection(-1);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          this.chooseSelected();
          return;
        }
      }
      if (event.key === " " && this.config.autoTokenizeExactOnSpace) {
        const mention = this.findActiveMention();
        if (!mention) return;
        const leaf = this.findExactLeaf(mention.system, mention.query);
        if (leaf && !leaf.disabled && !this.isUsedAndHidden(leaf)) {
          event.preventDefault();
          this.insertTokenForMention(mention, leaf);
          this.insertTextAtCaret(" ");
        }
      }
    }

    onPaste(event) {
      if (this.disabled) return;
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") || "";
      this.insertTextAtCaret(text);
    }

    onSelectionChange() {
      if (!this.editor.contains(document.activeElement)) return;
      if (this.drag?.active) return;
      this.updateMentionSoon();
    }

    updateMentionSoon() {
      cancelAnimationFrame(this.mentionFrame || 0);
      this.mentionFrame = requestAnimationFrame(() => this.update());
    }

    update() {
      this.updateEmptyState();
      this.syncOriginal();
      this.updateMention();
      this.config.onChange?.(this.getParts(), this);
    }

    updateEmptyState() {
      this.editor.dataset.empty = String(!cleanText(this.editor.textContent || "") && !this.editor.querySelector(".token-chip"));
    }

    syncOriginal() {
      if (!this.formSource) return;
      this.formSource.value = this.getText();
    }

    updateMention() {
      const mention = this.findActiveMention();
      this.activeMention = mention;
      this.updateHighlight(mention);
      if (!mention) {
        this.closeMenu();
        return;
      }
      this.rows = this.resolveRows(mention);
      this.selectedIndex = Math.max(0, this.rows.findIndex(row => !row.item.disabled && !this.isUsedAndHidden(row.item)));
      this.renderMenu(mention);
      this.positionMenu();
    }

    findActiveMention() {
      const selection = document.getSelection();
      if (!selection || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      if (!range.collapsed || !this.editor.contains(range.startContainer)) return null;
      if (!isText(range.startContainer)) return null;
      const node = range.startContainer;
      const offset = range.startOffset;
      const before = node.data.slice(0, offset);
      let best = null;
      [...this.systemByTrigger.keys()].forEach(trigger => {
        const index = before.lastIndexOf(trigger);
        if (index < 0) return;
        if (index > 0 && !isBoundary(before[index - 1])) return;
        const query = before.slice(index + trigger.length);
        if (/\s/.test(query)) return;
        if (!best || index > best.start) {
          const system = this.systemByTrigger.get(trigger);
          best = { node, offset, start: index, end: offset, trigger, query, system };
        }
      });
      if (!best) return null;
      if (this.suppressed && this.suppressed.node === best.node && this.suppressed.start === best.start && this.suppressed.trigger === best.trigger) {
        return null;
      }
      return best;
    }

    updateHighlight(mention) {
      this.clearHighlight();
      if (!mention || !("CSS" in window) || !("highlights" in CSS) || !("Highlight" in window)) return;
      const prefixEnd = this.getMentionPrefixEnd(mention);
      if (prefixEnd <= mention.start) return;
      const range = document.createRange();
      range.setStart(mention.node, mention.start);
      range.setEnd(mention.node, prefixEnd);
      CSS.highlights.set(ACTIVE_HIGHLIGHT, new Highlight(range));
    }

    clearHighlight() {
      if (("CSS" in window) && ("highlights" in CSS)) CSS.highlights.delete(ACTIVE_HIGHLIGHT);
    }

    getMentionPrefixEnd(mention) {
      const slash = mention.query.lastIndexOf("/");
      if (slash >= 0) return mention.start + mention.trigger.length + slash + 1;
      const branch = this.findExactBranch(mention.system.items, mention.query);
      if (branch) return mention.end;
      return mention.start;
    }

    resolveRows(mention) {
      const result = this.resolveHierarchy(mention.system, mention.query);
      const rows = result.children
        .filter(item => this.itemMatchesFilter(item, result.filter))
        .map(item => ({ item, system: mention.system, parentPath: result.parentPath }));
      return rows.slice(0, this.config.dropdown.maxItems || 12);
    }

    resolveHierarchy(system, query) {
      const cleanQuery = String(query || "");
      if (!cleanQuery) return { parent: null, parentPath: [], children: system.items, filter: "" };
      const trailingSlash = cleanQuery.endsWith("/");
      const rawParts = cleanQuery.split("/");
      const pathParts = trailingSlash ? rawParts.slice(0, -1) : rawParts.slice(0, -1);
      let children = system.items;
      let parent = null;
      const parentPath = [];
      for (const segment of pathParts) {
        if (!segment) continue;
        const branch = children.find(item => item.kind === "branch" && sameText(item.key, segment));
        if (!branch) return { parent: null, parentPath: [], children: [], filter: segment };
        parent = branch;
        parentPath.push(branch.key);
        children = branch.children;
      }
      if (trailingSlash) return { parent, parentPath, children, filter: "" };
      const last = rawParts[rawParts.length - 1] || "";
      const exactBranch = children.find(item => item.kind === "branch" && sameText(item.key, last));
      if (exactBranch) {
        return {
          parent: exactBranch,
          parentPath: [...parentPath, exactBranch.key],
          children: exactBranch.children,
          filter: ""
        };
      }
      return { parent, parentPath, children, filter: last };
    }

    itemMatchesFilter(item, filter) {
      if (!filter) return true;
      return starts(item.key, filter) || starts(item.label, filter) || includes(item.key, filter) || includes(item.label, filter);
    }

    renderMenu(mention) {
      this.menu.className = `token-menu is-open ${this.config.dropdown.className || ""}`.trim();
      this.menu.replaceChildren();
      const hint = document.createElement("div");
      hint.className = "token-menu__hint";
      const prefix = this.getLocalPrefixLabel(mention);
      hint.textContent = prefix
        ? "Submenu options. Choose a child, or keep typing to refine."
        : `Choose a ${mention.system.name} item, or keep typing.`;
      this.menu.appendChild(hint);
      const visibleRows = this.rows.filter(row => !this.isUsedAndHidden(row.item));
      if (!visibleRows.length) {
        const empty = document.createElement("div");
        empty.className = "token-menu__hint";
        empty.innerHTML = this.config.dropdown.emptyHtml || "No matching options.";
        this.menu.appendChild(empty);
        return;
      }
      visibleRows.forEach((row, index) => {
        const button = document.createElement("button");
        const item = row.item;
        const disabled = Boolean(item.disabled);
        button.type = "button";
        button.className = `token-menu__item ${item.dropdownClass || ""}`.trim();
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(index === this.selectedIndex));
        button.setAttribute("aria-disabled", String(disabled));
        if (item.dropdownStyle) Object.entries(item.dropdownStyle).forEach(([key, value]) => button.style.setProperty(key, value));
        const ctx = this.createRenderContext(row, mention);
        const html = item.dropdownHtml || this.config.dropdown.renderItem?.(item, ctx) || this.defaultRowHtml(item, ctx);
        button.innerHTML = html;
        button.addEventListener("click", () => {
          if (!disabled) this.chooseRow(row);
        });
        this.menu.appendChild(button);
      });
    }

    defaultRowHtml(item, ctx) {
      const badge = item.kind === "branch" ? "submenu" : item.singleUse ? "single" : ctx.system.trigger;
      const desc = item.description || (item.kind === "branch" ? "Open this submenu" : "Insert token");
      return `
        <span class="token-menu__icon">${escapeHtml(item.icon || ctx.system.icon)}</span>
        <span class="token-menu__main">
          <span class="token-menu__title">${escapeHtml(item.label)}</span>
          <span class="token-menu__desc">${escapeHtml(desc)}</span>
        </span>
        <span class="token-menu__badge">${escapeHtml(badge)}</span>`;
    }

    createRenderContext(row, mention) {
      const item = row.item;
      return {
        api: this,
        system: row.system,
        mention,
        trigger: row.system.trigger,
        icon: item.icon || row.system.icon,
        path: item.path,
        pathText: item.pathText,
        localLabel: item.label,
        isBranch: item.kind === "branch",
        escape: escapeHtml
      };
    }

    getLocalPrefixLabel(mention) {
      const result = this.resolveHierarchy(mention.system, mention.query);
      return result.parentPath.length ? result.parentPath.join("/") : "";
    }

    positionMenu() {
      if (!this.menu.classList.contains("is-open")) return;
      const rect = this.editor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const vx = viewport?.offsetLeft || 0;
      const vy = viewport?.offsetTop || 0;
      const vw = viewport?.width || window.innerWidth;
      const vh = viewport?.height || window.innerHeight;
      const gap = 8;
      const width = Math.min(Math.max(rect.width, 300), vw - 20);
      this.menu.style.width = `${width}px`;
      const below = rect.bottom + gap;
      const above = rect.top - gap - Math.min(this.menu.offsetHeight || 320, vh * 0.48);
      const enoughBelow = below + Math.min(this.menu.offsetHeight || 320, vh * 0.48) < vy + vh - 10;
      const top = enoughBelow ? below : Math.max(vy + 10, above);
      const left = Math.min(Math.max(rect.left, vx + 10), vx + vw - width - 10);
      this.menu.style.left = `${left}px`;
      this.menu.style.top = `${top}px`;
    }

    closeMenu() {
      this.menu.classList.remove("is-open");
      this.rows = [];
      this.activeMention = null;
      this.clearHighlight();
    }

    moveSelection(delta) {
      const items = [...this.menu.querySelectorAll(".token-menu__item")];
      if (!items.length) return;
      let next = this.selectedIndex;
      for (let step = 0; step < items.length; step += 1) {
        next = (next + delta + items.length) % items.length;
        if (items[next]?.getAttribute("aria-disabled") !== "true") break;
      }
      this.selectedIndex = next;
      items.forEach((item, index) => item.setAttribute("aria-selected", String(index === next)));
      items[next]?.scrollIntoView({ block: "nearest" });
    }

    chooseSelected() {
      const visibleRows = this.rows.filter(row => !this.isUsedAndHidden(row.item));
      const row = visibleRows[this.selectedIndex];
      if (row && !row.item.disabled) this.chooseRow(row);
    }

    chooseRow(row) {
      if (!this.activeMention) return;
      if (row.item.kind === "branch") {
        this.replaceMentionWithText(this.activeMention, `${this.activeMention.trigger}${row.item.pathText}/`);
        this.updateMentionSoon();
        return;
      }
      this.insertTokenForMention(this.activeMention, row.item);
    }

    insertTokenForMention(mention, item) {
      const range = document.createRange();
      range.setStart(mention.node, mention.start);
      range.setEnd(mention.node, mention.end);
      range.deleteContents();
      const token = this.createToken(mention.system, item);
      const before = document.createTextNode(ZWSP);
      const after = document.createTextNode(ZWSP);
      range.insertNode(after);
      range.insertNode(token);
      range.insertNode(before);
      const caret = document.createRange();
      caret.setStart(after, after.data.length);
      caret.collapse(true);
      this.setSelection(caret);
      this.suppressed = null;
      this.normalizeBoundaries();
      this.closeMenu();
      this.update();
    }

    replaceMentionWithText(mention, value) {
      const range = document.createRange();
      range.setStart(mention.node, mention.start);
      range.setEnd(mention.node, mention.end);
      range.deleteContents();
      const text = document.createTextNode(value);
      range.insertNode(text);
      const caret = document.createRange();
      caret.setStart(text, text.data.length);
      caret.collapse(true);
      this.setSelection(caret);
      this.update();
    }

    appendToken(system, item) {
      this.editor.appendChild(document.createTextNode(ZWSP));
      this.editor.appendChild(this.createToken(system, item));
      this.editor.appendChild(document.createTextNode(ZWSP));
    }

    createToken(system, item) {
      const token = document.createElement("span");
      token.className = `token-chip ${system.tokenClass || ""} ${item.tokenClass || ""}`.trim();
      token.contentEditable = "false";
      // A contentEditable=false element is natively HTML5-draggable in
      // some engines, which hijacks the library's pointer-based drag
      // (the native ghost takes over and the reorder never starts).
      // Disabling native drag lets the pointer drag own the gesture.
      token.draggable = false;
      token.dataset.token = "true";
      token.dataset.system = system.id;
      token.dataset.trigger = system.trigger;
      token.dataset.itemId = item.id;
      token.dataset.path = item.pathText;
      token.dataset.label = item.label;
      token.dataset.deletable = String(item.deletable);
      token.dataset.movable = String(item.movable);
      token.dataset.disabled = String(item.tokenDisabled);
      token.setAttribute("role", "button");
      token.setAttribute("aria-label", `${system.trigger}${item.pathText}`);
      if (!item.deletable) token.classList.add("is-locked");
      if (!item.movable) token.classList.add("is-pinned");
      if (item.tokenDisabled) token.classList.add("is-disabled");
      if (item.singleUse) token.classList.add("is-single");
      if (item.tokenStyle) Object.entries(item.tokenStyle).forEach(([key, value]) => token.style.setProperty(key, value));
      const ctx = {
        api: this,
        system,
        trigger: system.trigger,
        icon: item.icon || system.icon,
        path: item.path,
        pathText: item.pathText,
        escape: escapeHtml
      };
      const inner = item.html || this.config.token.render?.(item, ctx) || `
        <span class="token-chip__pill">
          <span class="token-chip__icon">${escapeHtml(item.icon || system.icon)}</span>
          <span class="token-chip__label">${escapeHtml(item.label)}</span>
        </span>`;
      token.innerHTML = inner;
      return token;
    }

    previousTokenFromCaret() {
      const range = this.getCollapsedRange();
      if (!range) return null;
      if (isText(range.startContainer)) {
        const node = range.startContainer;
        const before = node.data.slice(0, range.startOffset);
        if (cleanText(before).length > 0) return null;
        return this.previousElementToken(node);
      }
      const child = range.startContainer.childNodes[range.startOffset - 1];
      if (child?.nodeType === Node.ELEMENT_NODE && child.classList.contains("token-chip")) return child;
      if (isText(child) && !cleanText(child.data)) return this.previousElementToken(child);
      return null;
    }

    nextTokenFromCaret() {
      const range = this.getCollapsedRange();
      if (!range) return null;
      if (isText(range.startContainer)) {
        const node = range.startContainer;
        const after = node.data.slice(range.startOffset);
        if (cleanText(after).length > 0) return null;
        return this.nextElementToken(node);
      }
      const child = range.startContainer.childNodes[range.startOffset];
      if (child?.nodeType === Node.ELEMENT_NODE && child.classList.contains("token-chip")) return child;
      if (isText(child) && !cleanText(child.data)) return this.nextElementToken(child);
      return null;
    }

    previousElementToken(node) {
      let current = node.previousSibling;
      while (current && isText(current) && !cleanText(current.data)) current = current.previousSibling;
      return current?.nodeType === Node.ELEMENT_NODE && current.classList.contains("token-chip") ? current : null;
    }

    nextElementToken(node) {
      let current = node.nextSibling;
      while (current && isText(current) && !cleanText(current.data)) current = current.nextSibling;
      return current?.nodeType === Node.ELEMENT_NODE && current.classList.contains("token-chip") ? current : null;
    }

    explodeToken(token, direction) {
      if (token.dataset.deletable === "false") {
        this.flashStatus("Locked token cannot be converted or removed.");
        return;
      }
      const value = `${token.dataset.trigger}${token.dataset.path}`;
      const textValue = direction === "backward"
        ? value.slice(0, -1)
        : value.slice(1);
      const text = document.createTextNode(textValue || ZWSP);
      const before = token.previousSibling;
      const after = token.nextSibling;
      token.replaceWith(text);
      if (before && isText(before) && !cleanText(before.data)) before.remove();
      if (after && isText(after) && !cleanText(after.data)) after.remove();
      const range = document.createRange();
      const offset = direction === "backward" ? text.data.length : 0;
      range.setStart(text, offset);
      range.collapse(true);
      this.setSelection(range);
      this.normalizeBoundaries();
      this.update();
    }

    normalizeBoundaries() {
      this.editor.querySelectorAll(".token-chip").forEach(token => {
        if (!isText(token.previousSibling)) token.before(document.createTextNode(ZWSP));
        else if (!token.previousSibling.data.includes(ZWSP) && !cleanText(token.previousSibling.data)) token.previousSibling.data = ZWSP;
        if (!isText(token.nextSibling)) token.after(document.createTextNode(ZWSP));
        else if (!token.nextSibling.data.includes(ZWSP) && !cleanText(token.nextSibling.data)) token.nextSibling.data = ZWSP;
      });
      if (!this.editor.childNodes.length) this.editor.appendChild(document.createTextNode(ZWSP));
    }

    insertTextAtCaret(text) {
      const range = this.getCollapsedRange();
      if (!range) return;
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      const caret = document.createRange();
      caret.setStart(node, node.data.length);
      caret.collapse(true);
      this.setSelection(caret);
      this.update();
    }

    getCollapsedRange() {
      const selection = document.getSelection();
      if (!selection || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      if (!range.collapsed || !this.editor.contains(range.startContainer)) return null;
      return range;
    }

    setSelection(range) {
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    findNodeByPath(items, path) {
      const parts = Array.isArray(path) ? path : String(path || "").split("/");
      let children = items;
      let found = null;
      for (const part of parts) {
        found = children.find(item => sameText(item.key, part) || sameText(item.label, part));
        if (!found) return null;
        children = found.children;
      }
      return found;
    }

    findExactBranch(items, query) {
      const node = this.findNodeByPath(items, query);
      return node?.kind === "branch" ? node : null;
    }

    findExactLeaf(system, query) {
      const node = this.findNodeByPath(system.items, query);
      return node?.kind === "token" ? node : null;
    }

    isUsedAndHidden(item) {
      const shouldHide = this.config.hideUsedSingleTokens && (this.config.singleUseAll || item.singleUse);
      if (!shouldHide) return false;
      return Boolean(this.editor.querySelector(`.token-chip[data-item-id="${escapeCss(item.id)}"]`));
    }

    onPointerDown(event) {
      // Mouse is driven by the dedicated mouse handlers (more reliable
      // in embedded runtime); only touch and pen use the pointer path here.
      if ((event.pointerType || "mouse") === "mouse") return;
      const token = event.target.closest?.(".token-chip");
      if (!token || !this.editor.contains(token)) {
        this.suppressed = null;
        return;
      }
      if (this.disabled || token.dataset.movable === "false" || token.classList.contains("is-disabled")) return;
      const pointerType = event.pointerType || "mouse";
      this.drag = {
        token,
        pointerId: event.pointerId,
        pointerType,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        ghost: null,
        placeholder: null,
        range: null,
        timer: null
      };
      token.setPointerCapture?.(event.pointerId);
      if (pointerType === "touch" || pointerType === "pen") {
        this.drag.timer = window.setTimeout(() => this.startDrag(event.clientX, event.clientY), 360);
      }
    }

    onPointerMove(event) {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
      const distance = Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY);
      if (!this.drag.active && this.drag.pointerType === "mouse" && distance > 5) this.startDrag(event.clientX, event.clientY);
      if (!this.drag.active && distance > 12 && this.drag.pointerType !== "mouse") {
        clearTimeout(this.drag.timer);
      }
      if (this.drag.active) {
        event.preventDefault();
        this.moveGhost(event.clientX, event.clientY);
        this.updateDropTarget(event.clientX, event.clientY);
      }
    }

    onPointerUp(event) {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      clearTimeout(this.drag.timer);
      if (this.drag.active) {
        event.preventDefault();
        this.finishDrag();
      } else {
        this.placeCaretNearToken(this.drag.token, event.clientX);
      }
      this.drag = null;
    }

    onPointerCancel(event) {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      clearTimeout(this.drag.timer);
      if (this.drag.active) this.cancelDrag();
      this.drag = null;
    }

    // --- Desktop (mouse) drag: the reliable path in embedded runtime. -----------
    onMouseDown(event) {
      if (event.button !== 0 || this.drag) return;
      const token = event.target.closest?.(".token-chip");
      if (!token || !this.editor.contains(token)) {
        this.suppressed = null;
        return;
      }
      if (this.disabled || token.dataset.movable === "false" ||
          token.classList.contains("is-disabled")) return;
      this.drag = {
        token,
        pointerId: "mouse",
        pointerType: "mouse",
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        ghost: null,
        placeholder: null,
        range: null,
        timer: null
      };
    }

    onMouseMove(event) {
      if (!this.drag || this.drag.pointerId !== "mouse") return;
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
      const distance = Math.hypot(
        event.clientX - this.drag.startX,
        event.clientY - this.drag.startY
      );
      if (!this.drag.active && distance > 5) {
        this.startDrag(event.clientX, event.clientY);
      }
      if (this.drag.active) {
        event.preventDefault();
        this.moveGhost(event.clientX, event.clientY);
        this.updateDropTarget(event.clientX, event.clientY);
      }
    }

    onMouseUp(event) {
      if (!this.drag || this.drag.pointerId !== "mouse") return;
      if (this.drag.active) {
        event.preventDefault();
        this.finishDrag();
      } else {
        this.placeCaretNearToken(this.drag.token, event.clientX);
      }
      this.drag = null;
    }

    startDrag(x, y) {
      if (!this.drag || this.drag.active) return;
      const { token } = this.drag;
      this.closeMenu();
      this.clearHighlight();
      const placeholder = document.createElement("span");
      placeholder.className = "token-placeholder";
      token.before(placeholder);
      token.classList.add("is-drag-source");
      const ghost = token.cloneNode(true);
      ghost.classList.add("token-ghost");
      ghost.classList.remove("is-drag-source");
      document.body.appendChild(ghost);
      this.drag.active = true;
      this.drag.ghost = ghost;
      this.drag.placeholder = placeholder;
      document.body.classList.add("token-input-dragging");
      this.moveGhost(x, y);
      this.updateDropTarget(x, y);
    }

    moveGhost(x, y) {
      if (!this.drag?.ghost) return;
      this.drag.ghost.style.left = `${x}px`;
      this.drag.ghost.style.top = `${y}px`;
    }

    updateDropTarget(x, y) {
      const range = this.rangeFromPoint(x, y);
      this.drag.range = range;
      if (!range || !this.editor.contains(range.startContainer)) {
        this.dropCaret.hidden = true;
        return;
      }
      const rect = this.rangeRect(range);
      if (!rect) {
        this.dropCaret.hidden = true;
        return;
      }
      this.dropCaret.hidden = false;
      this.dropCaret.style.left = `${rect.left}px`;
      this.dropCaret.style.top = `${rect.top}px`;
      this.dropCaret.style.height = `${Math.max(rect.height, 24)}px`;
    }

    finishDrag() {
      const { token, placeholder, ghost, range } = this.drag;
      ghost?.remove();
      this.dropCaret.hidden = true;
      token.classList.remove("is-drag-source");
      if (range && this.editor.contains(range.startContainer)) {
        const insertion = range.cloneRange();
        insertion.collapse(true);
        insertion.insertNode(token);
        placeholder?.remove();
      } else {
        placeholder?.replaceWith(token);
      }
      document.body.classList.remove("token-input-dragging");
      this.normalizeBoundaries();
      this.update();
    }

    cancelDrag() {
      const { token, placeholder, ghost } = this.drag;
      ghost?.remove();
      this.dropCaret.hidden = true;
      token.classList.remove("is-drag-source");
      placeholder?.replaceWith(token);
      document.body.classList.remove("token-input-dragging");
      this.normalizeBoundaries();
    }

    rangeFromPoint(x, y) {
      const element = document.elementFromPoint(x, y);
      const token = element?.closest?.(".token-chip");
      if (token && this.editor.contains(token)) {
        const rect = token.getBoundingClientRect();
        const range = document.createRange();
        if (x < rect.left + rect.width / 2) range.setStartBefore(token);
        else range.setStartAfter(token);
        range.collapse(true);
        return range;
      }
      if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(x, y);
        if (!position) return null;
        const range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        return range;
      }
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
      return null;
    }

    rangeRect(range) {
      const rect = range.getClientRects()[0];
      if (rect) return rect;
      const probe = document.createElement("span");
      probe.textContent = ZWSP;
      range.insertNode(probe);
      const probeRect = probe.getBoundingClientRect();
      probe.remove();
      return probeRect;
    }

    placeCaretNearToken(token, x) {
      const rect = token.getBoundingClientRect();
      const range = document.createRange();
      if (x < rect.left + rect.width / 2) range.setStartBefore(token);
      else range.setStartAfter(token);
      range.collapse(true);
      this.editor.focus();
      this.setSelection(range);
      this.updateMentionSoon();
    }

    /** Places the caret just past a token, skipping its trailing ZWSP. */
    placeCaretAfterToken(token) {
      const next = token.nextSibling;
      const range = document.createRange();
      if (next && next.nodeType === Node.TEXT_NODE) {
        let offset = 0;
        while (offset < next.data.length && next.data[offset] === ZWSP) offset += 1;
        range.setStart(next, offset);
      } else {
        range.setStartAfter(token);
      }
      range.collapse(true);
      this.setSelection(range);
      this.updateMentionSoon();
    }

    /** Places the caret just before a token, skipping its leading ZWSP. */
    placeCaretBeforeToken(token) {
      const prev = token.previousSibling;
      const range = document.createRange();
      if (prev && prev.nodeType === Node.TEXT_NODE) {
        let end = prev.data.length;
        while (end > 0 && prev.data[end - 1] === ZWSP) end -= 1;
        range.setStart(prev, end);
      } else {
        range.setStartBefore(token);
      }
      range.collapse(true);
      this.setSelection(range);
      this.updateMentionSoon();
    }

    flashStatus(message) {
      this.config.onStatus?.(message, this);
    }
  }

  window.TokenInput = TokenInput;
})();
