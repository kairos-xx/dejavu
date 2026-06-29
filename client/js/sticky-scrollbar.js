(function (global) {
    "use strict";

    const instances = new WeakMap();

    const defaults = {
        stickySelector: ".timeline-day__header",
        width: 6,
        right: 4,
        bottom: 8,
        extraTop: 10,
        safeRight: 34,
        minThumbHeight: 36,
        minElasticThumbHeight: 18,
        elasticStrength: 0.55,
        elasticTrackStrength: 1,
        elasticMax: 90,
        elasticHoldDelay: 0,
        autoHide: true,
        autoHideDelay: 750,
        fadeDuration: 180,
        zIndex: 2147483647,
        thumbRadius: "999px",
        thumbBackground: "rgba(0, 0, 0, 0.38)",
        thumbBackgroundDragging: "rgba(0, 0, 0, 0.52)",
        thumbBoxShadow: "none",
        thumbBorder: "none",
        thumbOpacity: 1,
        thumbOpacityDragging: 1
    };

    const styleId = "dejavu-sticky-scrollbar-style";

    const dash = (value) => {
        return String(value).replace(/[A-Z]/g, (char) => {
            return `-${char.toLowerCase()}`;
        });
    };

    const cssName = (name) => {
        return `--sticky-scrollbar-${dash(name)}`;
    };

    const px = (value) => `${value}px`;

    const clamp = (value, min, max) => {
        return Math.min(Math.max(value, min), max);
    };

    const readNumber = (el, key) => {
        const raw = getComputedStyle(el).getPropertyValue(cssName(key)).trim();
        const parsed = Number.parseFloat(raw);
        return Number.isFinite(parsed) ? parsed : defaults[key];
    };

    const readTime = (el, key) => {
        const raw = getComputedStyle(el).getPropertyValue(cssName(key)).trim();
        const parsed = Number.parseFloat(raw);
        if (!Number.isFinite(parsed)) return defaults[key];
        return raw.toLowerCase().endsWith("s") && !raw.toLowerCase().endsWith("ms")
            ? parsed * 1000
            : parsed;
    };

    const readBool = (el, key) => {
        const raw = getComputedStyle(el).getPropertyValue(cssName(key)).trim()
            .toLowerCase();
        if (["0", "false", "off", "no"].includes(raw)) return false;
        if (["1", "true", "on", "yes"].includes(raw)) return true;
        return defaults[key];
    };

    const readString = (el, key) => {
        return getComputedStyle(el).getPropertyValue(cssName(key)).trim() ||
            defaults[key];
    };

    const readSettings = (el) => {
        return {
            width: readNumber(el, "width"),
            right: readNumber(el, "right"),
            bottom: readNumber(el, "bottom"),
            extraTop: readNumber(el, "extraTop"),
            safeRight: readNumber(el, "safeRight"),
            minThumbHeight: readNumber(el, "minThumbHeight"),
            minElasticThumbHeight: readNumber(el, "minElasticThumbHeight"),
            elasticStrength: readNumber(el, "elasticStrength"),
            elasticTrackStrength: readNumber(el, "elasticTrackStrength"),
            elasticMax: readNumber(el, "elasticMax"),
            elasticHoldDelay: readTime(el, "elasticHoldDelay"),
            autoHide: readBool(el, "autoHide"),
            autoHideDelay: readTime(el, "autoHideDelay"),
            fadeDuration: readTime(el, "fadeDuration"),
            zIndex: readNumber(el, "zIndex"),
            thumbRadius: readString(el, "thumbRadius"),
            thumbBackground: readString(el, "thumbBackground"),
            thumbBackgroundDragging: readString(el, "thumbBackgroundDragging"),
            thumbBoxShadow: readString(el, "thumbBoxShadow"),
            thumbBorder: readString(el, "thumbBorder"),
            thumbOpacity: readNumber(el, "thumbOpacity"),
            thumbOpacityDragging: readNumber(el, "thumbOpacityDragging")
        };
    };

    const ensureStyle = () => {
        if (document.getElementById(styleId)) return;
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = [
            ".sticky-scrollbar-host{scrollbar-width:none!important;-ms-overflow-style:none!important;}",
            ".sticky-scrollbar-host::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;}",
            ".sticky-scrollbar-track{position:fixed;display:none;background:transparent;opacity:0;pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none;}",
            ".sticky-scrollbar-track.is-visible{display:block;opacity:1;pointer-events:auto;}",
            ".sticky-scrollbar-thumb{position:absolute;top:0;left:0;right:0;min-height:0;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;will-change:transform,height;}",
            ".sticky-scrollbar-thumb:active{cursor:grabbing;}"
        ].join("");
        document.head.appendChild(style);
    };

    const maxScroll = (el) => Math.max(0, el.scrollHeight - el.clientHeight);

    const hasOverflow = (el) => el.scrollHeight > el.clientHeight + 1;

    const stickyBottom = (el, selector) => {
        const rect = el.getBoundingClientRect();
        const line = rect.top + el.clientTop + 1;
        const headers = el.querySelectorAll(selector);
        let bottom = rect.top + el.clientTop;
        let active = null;

        headers.forEach((header) => {
            const style = getComputedStyle(header);
            if (style.display === "none" || style.visibility === "hidden") {
                return;
            }
            const box = header.getBoundingClientRect();
            if (header.offsetTop <= el.scrollTop + 1) {
                active = header;
            }
            if (box.top <= line && box.bottom > line) {
                bottom = Math.max(bottom, box.bottom);
            }
        });

        if (bottom === rect.top + el.clientTop && active) {
            bottom = rect.top + el.clientTop +
                active.getBoundingClientRect().height;
        }

        return Math.min(bottom, rect.bottom);
    };

    const attach = (target, options) => {
        const el = typeof target === "string"
            ? document.querySelector(target)
            : target;
        if (!el) return null;
        if (instances.has(el)) return instances.get(el);

        ensureStyle();
        const stickySelector = options && options.stickySelector
            ? options.stickySelector
            : defaults.stickySelector;
        const track = document.createElement("div");
        const thumb = document.createElement("div");
        const state = {
            dragging: false,
            offset: 0,
            hideTimer: 0,
            frame: 0
        };

        track.className = "sticky-scrollbar-track";
        thumb.className = "sticky-scrollbar-thumb";
        track.appendChild(thumb);
        document.body.appendChild(track);
        el.classList.add("sticky-scrollbar-host");

        const hide = (instant) => {
            clearTimeout(state.hideTimer);
            track.classList.remove("is-visible");
            if (instant) {
                track.style.display = "none";
            }
        };

        const show = () => {
            const s = readSettings(el);
            if (!hasOverflow(el)) {
                hide(true);
                return;
            }
            clearTimeout(state.hideTimer);
            track.style.display = "block";
            track.classList.add("is-visible");
            if (s.autoHide && !state.dragging) {
                state.hideTimer = setTimeout(() => hide(false), s.autoHideDelay);
            }
        };

        const updateNow = () => {
            const s = readSettings(el);
            el.style.setProperty(
                "--custom-scrollbar-safe-right",
                hasOverflow(el) ? px(s.safeRight) : ""
            );

            if (!hasOverflow(el)) {
                hide(true);
                return;
            }

            const rect = el.getBoundingClientRect();
            const top = stickyBottom(el, stickySelector) + s.extraTop;
            const bottom = rect.top + el.clientTop + el.clientHeight - s.bottom;
            const elasticInset = clamp(
                s.elasticTrackStrength * s.elasticHoldDelay,
                0,
                s.elasticMax
            );
            const trackHeight = Math.max(0, bottom - top - elasticInset);
            const minThumbHeight = Math.max(
                s.minElasticThumbHeight,
                s.minThumbHeight - (s.elasticStrength * elasticInset)
            );
            const thumbHeight = Math.max(
                minThumbHeight,
                trackHeight * el.clientHeight / el.scrollHeight
            );
            const range = Math.max(0, trackHeight - thumbHeight);
            const topRatio = maxScroll(el) ? el.scrollTop / maxScroll(el) : 0;
            const thumbTop = clamp(topRatio * range, 0, range);

            track.style.left = px(rect.right - s.right - s.width);
            track.style.top = px(top);
            track.style.width = px(s.width);
            track.style.height = px(trackHeight);
            track.style.zIndex = String(s.zIndex);
            track.style.transition = `opacity ${s.fadeDuration}ms ease`;

            thumb.style.height = px(thumbHeight);
            thumb.style.transform = `translate3d(0,${px(thumbTop)},0)`;
            thumb.style.borderRadius = s.thumbRadius;
            thumb.style.background = state.dragging
                ? s.thumbBackgroundDragging
                : s.thumbBackground;
            thumb.style.boxShadow = s.thumbBoxShadow;
            thumb.style.border = s.thumbBorder;
            thumb.style.opacity = String(state.dragging
                ? s.thumbOpacityDragging
                : s.thumbOpacity);
        };

        const update = () => {
            cancelAnimationFrame(state.frame);
            state.frame = requestAnimationFrame(updateNow);
        };

        const scrollToPointer = (clientY) => {
            const trackRect = track.getBoundingClientRect();
            const range = Math.max(0, trackRect.height - thumb.offsetHeight);
            if (!range) return;
            const top = clamp(clientY - trackRect.top - state.offset, 0, range);
            el.scrollTop = top / range * maxScroll(el);
            updateNow();
            show();
        };

        const onScroll = () => {
            update();
            show();
        };

        const onThumbDown = (event) => {
            if (!hasOverflow(el)) return;
            state.dragging = true;
            state.offset = event.clientY - thumb.getBoundingClientRect().top;
            try {
                thumb.setPointerCapture(event.pointerId);
            } catch (_) {}
            updateNow();
            show();
            event.preventDefault();
            event.stopPropagation();
        };

        const onThumbMove = (event) => {
            if (!state.dragging) return;
            scrollToPointer(event.clientY);
            event.preventDefault();
            event.stopPropagation();
        };

        const onThumbUp = (event) => {
            if (!state.dragging) return;
            state.dragging = false;
            updateNow();
            show();
            if (event) event.stopPropagation();
        };

        const onTrackDown = (event) => {
            if (event.target === thumb || !hasOverflow(el)) return;
            state.offset = thumb.offsetHeight / 2;
            scrollToPointer(event.clientY);
            event.preventDefault();
        };

        const resizeObserver = "ResizeObserver" in window
            ? new ResizeObserver(update)
            : null;
        const mutationObserver = "MutationObserver" in window
            ? new MutationObserver(update)
            : null;

        el.addEventListener("scroll", onScroll, { passive: true });
        el.addEventListener("pointerenter", show);
        track.addEventListener("pointerdown", onTrackDown);
        thumb.addEventListener("pointerdown", onThumbDown);
        thumb.addEventListener("pointermove", onThumbMove);
        thumb.addEventListener("pointerup", onThumbUp);
        thumb.addEventListener("pointercancel", onThumbUp);
        thumb.addEventListener("lostpointercapture", onThumbUp);
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, { passive: true });

        resizeObserver?.observe(el);
        mutationObserver?.observe(el, {
            childList: true,
            subtree: true,
            characterData: true
        });

        const api = {
            update: updateNow,
            destroy() {
                clearTimeout(state.hideTimer);
                cancelAnimationFrame(state.frame);
                el.removeEventListener("scroll", onScroll);
                el.removeEventListener("pointerenter", show);
                track.removeEventListener("pointerdown", onTrackDown);
                thumb.removeEventListener("pointerdown", onThumbDown);
                thumb.removeEventListener("pointermove", onThumbMove);
                thumb.removeEventListener("pointerup", onThumbUp);
                thumb.removeEventListener("pointercancel", onThumbUp);
                thumb.removeEventListener("lostpointercapture", onThumbUp);
                window.removeEventListener("resize", update);
                window.removeEventListener("scroll", update);
                resizeObserver?.disconnect();
                mutationObserver?.disconnect();
                el.classList.remove("sticky-scrollbar-host");
                el.style.removeProperty("--custom-scrollbar-safe-right");
                track.remove();
                instances.delete(el);
            }
        };

        instances.set(el, api);
        updateNow();
        return api;
    };

    const attachAll = (selector, options) => {
        return Array.from(document.querySelectorAll(selector)).map((el) => {
            return attach(el, options);
        });
    };

    global.StickyScrollbar = {
        attach,
        attachAll
    };
})(window);
