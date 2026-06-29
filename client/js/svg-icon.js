(function (global) {
    "use strict";

    const ICON_FILES = {
        "app-logo": "icons/app-logo.svg",
        "app-logo-anim": "icons/app-logo-anim.svg",
        "app-logo-anim-css": "icons/app-logo-anim-css.svg",
        "chevron-down": "icons/icon-chevron-down.svg",
        "chevron-up": "icons/icon-chevron-up.svg",
        "check-corner": "icons/icon-check-corner.svg",
        "circle": "icons/icon-circle.svg",
        "circle-radio": "icons/icon-circle-radio.svg",
        "close": "icons/icon-close.svg",
        "close-circle": "icons/icon-close-circle.svg",
        "coffee": "icons/icon-coffee.svg",
        "compact": "icons/icon-compact.svg",
        "download": "icons/icon-download.svg",
        "engine-ai2svg": "icons/icon-engine-ai2svg.svg",
        "engine-embedded": "icons/icon-engine-embedded.svg",
        "engine-file": "icons/icon-engine-file.svg",
        "engine-inkscape": "icons/icon-engine-inkscape.svg",
        "engine-unknown": "icons/icon-engine-unknown.svg",
        "format-ai": "icons/icon-format-ai.svg",
        "format-eps": "icons/icon-format-eps.svg",
        "format-pdf": "icons/icon-format-pdf.svg",
        "format-svg": "icons/icon-format-svg.svg",
        "pin": "icons/icon-pin.svg",
        "power": "icons/icon-power.svg",
        "refresh": "icons/icon-refresh.svg",
        "reset": "icons/icon-reset.svg",
        "save": "icons/icon-save.svg",
        "settings": "icons/icon-settings.svg",
        "similarity": "icons/icon-similarity.svg",
        "trash": "icons/icon-trash.svg",
        "unsaved": "icons/icon-unsaved.svg"
    };
    const LEGACY_ICON_CLASSES = {
        "app__logo": "app-logo",
        "app__logo--anim": "app-logo-anim-css",
        "icon-circle": "circle-radio",
        "icon-coffee": "coffee",
        "icon-compact": "compact",
        "icon-download": "download",
        "icon-dropdown": "chevron-down",
        "icon-pin": "pin",
        "icon-power": "power",
        "icon-refresh": "refresh",
        "icon-reset": "reset",
        "icon-save": "save",
        "icon-trash": "trash",
        "icon-unsaved": "unsaved",
        "icon-format-ai": "format-ai",
        "icon-format-pdf": "format-pdf",
        "icon-format-eps": "format-eps",
        "icon-format-svg": "format-svg"
    };
    const extensionRoot = () => {
        if (typeof DEJAVU_EXTENSION_ROOT !== "undefined") {
            return DEJAVU_EXTENSION_ROOT;
        }
        return "";
    };

    const loadSvgText = (relPath, root) => {
        const extRoot = root || extensionRoot();
        let svgText;
        if (typeof require === "function" && extRoot) {
            const fs = require("fs");
            const pathMod = require("path");
            return fs.readFileSync(
                pathMod.join(extRoot, relPath),
                "utf8"
            );
        }
        let url = extRoot
            ? `file://${extRoot}/${relPath}`
            : `../${relPath}`;
        if (global.__DEJAVU_ASSET_RELOAD_TOKEN__) {
            const join = url.indexOf("?") === -1 ? "?" : "&";
            url += `${join}reload=${global.__DEJAVU_ASSET_RELOAD_TOKEN__}`;
        }
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, false);
        xhr.send();
        if (xhr.status !== 0 && xhr.status !== 200) {
            throw new Error(`Failed to load ${url}: ${xhr.status}`);
        }
        svgText = xhr.responseText;
        return svgText;
    };

    const iconNameFor = (el) => {
        const explicit = el.getAttribute("data-icon");
        if (explicit) return explicit;
        const classes = el.classList;
        for (let i = 0; i < classes.length; i += 1) {
            if (LEGACY_ICON_CLASSES[classes[i]]) {
                return LEGACY_ICON_CLASSES[classes[i]];
            }
        }
        return null;
    };

    const injectIcon = (el) => {
        const iconName = iconNameFor(el);
        if (!iconName) return;
        const relPath = ICON_FILES[iconName] || `icons/${iconName}.svg`;
        let svgText;
        try {
            svgText = loadSvgText(relPath);
        } catch {
            return;
        }
        el.innerHTML = "";
        const wrapper = document.createElement("div");
        wrapper.innerHTML = svgText;
        const svg = wrapper.querySelector("svg");
        if (!svg) return;
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        if (!svg.getAttribute("viewBox")) {
            svg.setAttribute("viewBox", "0 0 16 16");
        }
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        el.appendChild(svg);
        el.dataset.iconInjected = iconName;
    };

    const injectSvgIcons = (scope) => {
        const root = scope || document;
        const icons = root.querySelectorAll
            ? root.querySelectorAll(".svg-icon, [data-icon]")
            : [];
        if (root.nodeType === 1 &&
                (root.classList.contains("svg-icon") ||
                    root.hasAttribute("data-icon"))) {
            injectIcon(root);
        }
        Array.from(icons).forEach(injectIcon);
    };

    const observeIcons = () => {
        if (typeof MutationObserver === "undefined" || !document.body) return;
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType !== 1) return;
                    if (node.classList &&
                            (node.classList.contains("svg-icon") ||
                                node.hasAttribute("data-icon"))) {
                        injectIcon(node);
                    }
                    if (node.querySelectorAll) {
                        Array.from(
                            node.querySelectorAll(".svg-icon, [data-icon]")
                        ).forEach(injectIcon);
                    }
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    };

    if (typeof document !== "undefined") {
        document.addEventListener("DOMContentLoaded", () => {
            injectSvgIcons();
            observeIcons();
        });
    }

    global.dejavu = global.dejavu || {};
    global.dejavu.injectSvgIcons = injectSvgIcons;
    global.dejavu.injectIcon = injectIcon;
})(this);
