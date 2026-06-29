/**
 * DejaVu reusable table API.
 *
 * Shared controller for Timeline, Recovery Center, and Open Documents lists.
 * It centralizes the repeated table concerns while keeping each panel's row
 * rendering and host actions inside its own responsibility file.
 */
"use strict";

(() => {
    const asArray = (value) => {
        return Array.isArray(value) ? value : [];
    };

    const normalizeText = (value) => {
        return String(value || "").toLowerCase().trim();
    };

    const call = (fn, fallback, ...args) => {
        return typeof fn === "function" ? fn(...args) : fallback;
    };

    class TableController {
        /**
         * Creates a shared table controller.
         * @param {Object} options Controller options.
         */
        constructor(options = {}) {
            this.options = options;
            this.lastClickedKey = null;
        }

        keyFor(item) {
            return String(call(this.options.keyForItem, "", item) || "");
        }

        items() {
            return asArray(call(this.options.getItems, [], this));
        }

        query() {
            return normalizeText(call(this.options.getQuery, "", this));
        }

        range() {
            return String(call(this.options.getRange, "all", this) || "all");
        }

        sortMode() {
            return String(call(this.options.getSort, "", this) || "");
        }

        selectionStore() {
            const store = call(this.options.getSelectionStore, null, this);
            return store || {};
        }

        setSelectionStore(store) {
            call(this.options.setSelectionStore, null, store || {}, this);
        }

        isSelected(key) {
            return !!(key && this.selectionStore()[key]);
        }

        setSelected(key, selected) {
            if (!key) return;
            const store = this.selectionStore();
            if (selected) store[key] = true;
            else delete store[key];
            this.setSelectionStore(store);
        }

        clearSelection() {
            this.setSelectionStore({});
            this.lastClickedKey = null;
            this.syncBulkBar();
        }

        selectedKeys() {
            const store = this.selectionStore();
            const ordered = [];
            const seen = {};
            this.items().forEach((item) => {
                const key = this.keyFor(item);
                if (key && store[key]) {
                    ordered.push(key);
                    seen[key] = true;
                }
            });
            Object.keys(store).forEach((key) => {
                if (store[key] && !seen[key]) ordered.push(key);
            });
            return ordered;
        }

        selectedVisibleKeys() {
            return this.visibleItems().map((item) => {
                return this.keyFor(item);
            }).filter((key) => {
                return this.isSelected(key);
            });
        }

        pruneSelection(validItems = this.items()) {
            const valid = {};
            asArray(validItems).forEach((item) => {
                const key = this.keyFor(item);
                if (key) valid[key] = true;
            });
            const store = this.selectionStore();
            Object.keys(store).forEach((key) => {
                if (!valid[key]) delete store[key];
            });
            this.setSelectionStore(store);
        }

        matchesQuery(item, query = this.query()) {
            if (!query) return true;
            const text = call(this.options.textForItem, "", item, this);
            return normalizeText(text).indexOf(query) !== -1;
        }

        matchesRange(item, range = this.range()) {
            return call(this.options.matchesRange, true, item, range, this);
        }

        matchesCustomFilters(item) {
            return call(this.options.matchesFilters, true, item, this);
        }

        filteredItems(items = this.items()) {
            const query = this.query();
            const range = this.range();
            return asArray(items).filter((item) => {
                return this.matchesRange(item, range) &&
                    this.matchesQuery(item, query) &&
                    this.matchesCustomFilters(item);
            });
        }

        sortedItems(items) {
            const sorter = this.options.sorter;
            if (typeof sorter !== "function") return [...asArray(items)];
            return [...asArray(items)].sort((a, b) => {
                return sorter(a, b, this.sortMode(), this);
            });
        }

        visibleItems(items = this.items()) {
            return this.sortedItems(this.filteredItems(items));
        }

        selectRange(key, selected, visibleItems = this.visibleItems()) {
            const anchor = this.lastClickedKey;
            if (!anchor || anchor === key) return false;
            let anchorIndex = -1;
            let currentIndex = -1;
            asArray(visibleItems).forEach((item, index) => {
                const itemKey = this.keyFor(item);
                if (itemKey === anchor) anchorIndex = index;
                if (itemKey === key) currentIndex = index;
            });
            if (anchorIndex === -1 || currentIndex === -1) return false;
            const start = Math.min(anchorIndex, currentIndex);
            const end = Math.max(anchorIndex, currentIndex);
            for (let i = start; i <= end; i += 1) {
                this.setSelected(this.keyFor(visibleItems[i]), selected);
            }
            this.lastClickedKey = key;
            return true;
        }

        handleRowSelection(key, selected, event, visibleItems) {
            if (event && event.shiftKey && this.selectRange(key, selected, visibleItems)) {
                call(this.options.render, null, this);
                this.syncBulkBar();
                return true;
            }
            this.setSelected(key, selected);
            this.lastClickedKey = key;
            this.syncBulkBar();
            return false;
        }

        toggleAllVisible(force) {
            const visible = this.visibleItems();
            const shouldSelect = typeof force === "boolean"
                ? force
                : !this.allVisibleSelected(visible);
            visible.forEach((item) => {
                this.setSelected(this.keyFor(item), shouldSelect);
            });
            this.syncBulkBar();
            call(this.options.render, null, this);
            return shouldSelect;
        }

        allVisibleSelected(visible = this.visibleItems()) {
            return visible.length > 0 && visible.every((item) => {
                return this.isSelected(this.keyFor(item));
            });
        }

        syncBulkBar() {
            const bulkBar = call(this.options.getBulkBar, null, this);
            const countEl = call(this.options.getSelectionCountEl, null, this);
            const selectAllToggle = call(this.options.getSelectAllToggle, null, this);
            const count = this.selectedKeys().length;
            if (bulkBar) bulkBar.hidden = count === 0;
            if (countEl) countEl.textContent = `${count} selected`;
            if (selectAllToggle && typeof setToggleIcon === "function") {
                const visibleSelectedCount = this.selectedVisibleKeys().length;
                const allSelected = this.allVisibleSelected();
                const someSelected = visibleSelectedCount > 0 && !allSelected;
                if (someSelected && typeof setToggleIconMixed === "function") {
                    setToggleIconMixed(selectAllToggle, true);
                } else {
                    setToggleIcon(selectAllToggle, allSelected);
                }
            }
            call(this.options.afterBulkSync, null, count, this);
        }

        bindFilterInput(input, onChange) {
            if (!input) return;
            input.addEventListener("input", () => {
                call(onChange, null, input.value || "", this);
                call(this.options.render, null, this);
                this.syncBulkBar();
            });
        }

        bindSelect(select, onChange) {
            if (!select) return;
            select.addEventListener("change", () => {
                call(onChange, null, select.value, this);
                call(this.options.render, null, this);
                this.syncBulkBar();
            });
        }

        bindToggle(button, onChange) {
            if (!button) return;
            button.addEventListener("click", () => {
                const current = typeof toggleIconIsOn === "function" &&
                    toggleIconIsOn(button);
                const next = !current;
                if (typeof setToggleIcon === "function") {
                    setToggleIcon(button, next);
                }
                call(onChange, null, next, this);
                call(this.options.render, null, this);
                this.syncBulkBar();
            });
        }

        bindBulkAction(button, action) {
            if (!button) return;
            button.addEventListener("click", () => {
                call(action, null, this.selectedKeys(), this);
                this.syncBulkBar();
            });
        }

        createEmptyState(text) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = text;
            return empty;
        }
    }

    const create = (options) => {
        return new TableController(options);
    };

    window.DejaVuTable = {
        TableController,
        create,
        normalizeText
    };
})();
