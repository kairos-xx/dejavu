/**
 * DejaVu — UXP theme engine.
 *
 * Reads UXP/browser light-dark mode signals and derives all custom
 * properties from the selected base chrome color. The palette is computed
 * proportionally from background luminance instead of switching between
 * two hardcoded presets, so intermediate brightness levels still render
 * with consistent contrast.
 */
const log = false;
const DejaVuTheme = (() => {
    "use strict";

    /**
     * Clamps a number between 0 and 255.
     * @param {number} v
     * @return {number}
     */
    const clamp255 = (v) => {
        return Math.max(0, Math.min(255, v));
    };

    /**
     * Converts an RGB triple to perceptual luminance (ITU-R BT.601),
     * which tracks how bright a panel actually looks better than a
     * plain average of channels.
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @return {number} 0 (black) to 255 (white).
     */
    const luminance = (r, g, b) => {
        return 0.299 * r + 0.587 * g + 0.114 * b;
    };

    /**
     * Linear interpolation between a and b by t (0..1).
     * @param {number} a
     * @param {number} b
     * @param {number} t
     * @return {number}
     */
    const lerp = (a, b, t) => {
        return a + (b - a) * t;
    };

    /**
     * Mixes two RGB colors by a 0..1 ratio.
     * @param {Array<number>} a
     * @param {Array<number>} b
     * @param {number} t 0 = a, 1 = b.
     * @return {Array<number>}
     */
    const mix = (a, b, t) => {
        return [
            clamp255(a[0] + (b[0] - a[0]) * t),
            clamp255(a[1] + (b[1] - a[1]) * t),
            clamp255(a[2] + (b[2] - a[2]) * t)
        ];
    };

    /**
     * Lightens or darkens an RGB color toward white/black by amount.
     * Negative amount darkens, positive lightens.
     * @param {Array<number>} rgb
     * @param {number} amount -255..255
     * @return {Array<number>}
     */
    const shade = (rgb, amount) => {
        if (amount >= 0) return mix(rgb, [255, 255, 255], amount / 255);
        return mix(rgb, [0, 0, 0], -amount / 255);
    };

    /**
     * Formats an RGB triple as a CSS hex string.
     * @param {Array<number>} rgb
     * @return {string}
     */
    const toHex = (rgb) => {
        return `#${rgb
            .map((v) => {
                const h = Math.round(clamp255(v)).toString(16);
                return h.length === 1 ? `0${h}` : h;
            })
            .join("")}`;
    };

    /**
     * Builds a CSS rgba() string from an [r,g,b] triple and an alpha,
     * used for translucent tint/glow variables. the embedded runtime may not support every modern CSS color
     * function, so pre-built rgba strings are the portable way to get theme-colored translucency.
     * @param {Array<number>} rgb
     * @param {number} alpha 0..1
     * @return {string}
     */
    const toRgba = (rgb, alpha) => {
        return (
            `rgba(${Math.round(clamp255(rgb[0]))}, ${Math.round(clamp255(rgb[1]))}, ${Math.round(clamp255(rgb[2]))}, ${alpha})`
        );
    };


    /**
     * Reads an optional CommonJS module in UXP without failing in a
     * browser preview.
     * @param {string} name
     * @return {Object|null}
     */
    const requireOptional = (name) => {
        if (typeof require !== "function") return null;
        try {
            return require(name);
        } catch (e) {
            return null;
        }
    };

    /**
     * Converts Illustrator's uiBrightness preference into the panel
     * background used to derive the full custom palette. The preference
     * is normally a float from 0.0 (darkest) to 1.0 (lightest); some
     * older builds return an integer 0..4. Both encodings are normalized
     * to the same 5-point skin scale so every theme mode adapts.
     * @param {number} brightness
     * @return {{rgb: Array<number>, isDark: boolean}}
     */
    const brightnessToSkin = (brightness) => {
        const value = Number(brightness);
        if (!Number.isFinite(value)) {
            return { rgb: [50, 50, 50], isDark: true };
        }

        // Normalize 0.0..1.0 floats onto the 0..4 integer scale. The four
        // Illustrator UI brightness presets land on darkest/dark/light/
        // lightest; the middle step is only reached by intermediate values.
        const normalized = value <= 1.0 ? value * 4 : value;

        // Exact panel backgrounds for the four Illustrator brightness presets
        // (Darkest #323232, Dark #535353, Light #b9b9b9, Lightest #f0f0f0).
        // The bucket boundaries are kept from the calibrated original so each
        // preset still maps to a distinct mode; only the RGB targets changed.
        if (normalized <= 0) return { rgb: [50, 50, 50], isDark: true };      // #323232
        if (normalized <= 1) return { rgb: [83, 83, 83], isDark: true };      // #535353
        if (normalized <= 2) return { rgb: [83, 83, 83], isDark: true };      // (unused middle)
        if (normalized <= 3) return { rgb: [185, 185, 185], isDark: false };  // #b9b9b9
        if (normalized <= 4) return { rgb: [240, 240, 240], isDark: false };  // #f0f0f0
        return { rgb: [240, 240, 240], isDark: false };
    };

    /**
     * Normalizes Illustrator's UI scaling factor into a safe multiplier.
     * Some builds return values such as 1, 1.25, 1.5 or 2, while others
     * may return a stored percentage-like value. Keep the accepted range
     * bounded so a corrupt preference cannot make the panel unusable.
     * @param {number} value
     * @return {number}
     */
    const normalizeUiScale = (value) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return 1;
        const normalized = n > 10 ? n / 100 : n;
        return Math.max(0.75, Math.min(2.5, normalized));
    };

    /**
     * Reads a real Illustrator preference when the UXP application layer
     * is available.
     * @param {Object} preferences
     * @param {string} key
     * @return {number|null}
     */
    const readRealPreference = (preferences, key) => {
        const getter = preferences && preferences.getRealPreference;
        if (typeof getter !== "function") return null;
        try {
            return getter.call(preferences, key);
        } catch (e) {
            return null;
        }
    };

    /**
     * Reads a boolean Illustrator preference when the UXP application
     * layer is available.
     * @param {Object} preferences
     * @param {string} key
     * @return {boolean|null}
     */
    const readBooleanPreference = (preferences, key) => {
        const getter = preferences && preferences.getBooleanPreference;
        if (typeof getter !== "function") return null;
        try {
            return !!getter.call(preferences, key);
        } catch (e) {
            return null;
        }
    };

    /**
     * Reads the native Illustrator uiBrightness, uiScalingFactor and
     * uiLargeTabs preferences via the host bridge. This is the preferred
     * source because it follows the application chrome, not the operating-
     * system browser preference.
     * @return {Promise<{{rgb: Array<number>, fontFamily: string, fontSize: number,
     *     source: string, uiScalePreference: number, uiScaleFactor: number,
     *     largeTabsEnabled: boolean}|null}>}
     */
    const readIllustratorBrightnessSkin = async () => {
        // Try UXP host first (window.DejaVuHost)
        if (typeof window !== "undefined" && window.DejaVuHost &&
                typeof window.DejaVuHost.dejavu_getUiBrightness === "function") {
            try {
                const result = await window.DejaVuHost.dejavu_getUiBrightness();
                if (result && result.ok && typeof result.brightness === "number") {
                    const skin = brightnessToSkin(result.brightness);
                    if (typeof console !== "undefined" && console.log && log) {
                        console.log(
                            `[DejaVu theme] UXP host brightness: ${result.brightness}, source: ${result.source}, rgb: ${skin.rgb.join(",")}`
                        );
                    }
                    return {
                        rgb: skin.rgb,
                        fontFamily: "",
                        fontSize: 12,
                        source: "illustrator-uiBrightness",
                        uiScalePreference: 1,
                        uiScaleFactor: 1,
                        largeTabsEnabled: false
                    };
                }
            } catch (error) {
                if (typeof console !== "undefined" && console.log && log) {
                    console.log(
                        `[DejaVu theme] UXP host brightness error: ${error && error.message ? error.message : error}`
                    );
                }
            }
        }

        // Try CEP host (callHost)
        if (typeof window !== "undefined" && typeof window.callHost === "function") {
            try {
                const result = await window.callHost("dejavu_getUiBrightness", []);
                if (result && result.ok && typeof result.brightness === "number") {
                    const skin = brightnessToSkin(result.brightness);
                    if (typeof console !== "undefined" && console.log && log) {
                        console.log(
                            `[DejaVu theme] CEP host brightness: ${result.brightness}, source: ${result.source}, rgb: ${skin.rgb.join(",")}`
                        );
                    }
                    return {
                        rgb: skin.rgb,
                        fontFamily: "",
                        fontSize: 12,
                        source: "illustrator-uiBrightness",
                        uiScalePreference: 1,
                        uiScaleFactor: 1,
                        largeTabsEnabled: false
                    };
                }
            } catch (error) {
                if (typeof console !== "undefined" && console.log && log) {
                    console.log(
                        `[DejaVu theme] CEP host brightness error: ${error && error.message ? error.message : error}`
                    );
                }
            }
        }

        if (typeof console !== "undefined" && console.log && log) {
            console.log(
                `[DejaVu theme] No host bridge available for uiBrightness`
            );
        }
        return null;
    };

    /**
     * Extracts a named theme mode from host theme values without
     * depending on one exact UXP property name. Different Adobe hosts and
     * builds expose slightly different theme metadata, so the detector is
     * intentionally tolerant.
     * @param {Object|string|null} value
     * @return {string|null} One of "darkest", "dark", "medium", "light", "lightest".
     */
    const parseThemeValue = (value) => {
        if (!value) return null;
        const text = typeof value === "string"
            ? value
            : [value.name, value.id, value.theme, value.colorTheme]
                .filter(Boolean)
                .join(" ");
        const normalized = String(text).toLowerCase();
        if (normalized.indexOf("darkest") >= 0) return "darkest";
        if (normalized.indexOf("dark") >= 0) return "dark";
        if (normalized.indexOf("medium") >= 0) return "medium";
        if (normalized.indexOf("lightest") >= 0) return "lightest";
        if (normalized.indexOf("light") >= 0) return "light";
        return null;
    };

    /**
     * Reads UXP host metadata when available. This is a secondary UXP
     * source after Illustrator's native uiBrightness preference.
     * @return {{rgb: Array<number>, fontFamily: string, fontSize: number,
     *     source: string}|null}
     */
    const readUxpHostThemeSkin = () => {
        try {
            const uxpModule = requireOptional("uxp");
            const host = (uxpModule && uxpModule.host)
                || window.uxpHost
                || null;
            if (!host) {
                if (typeof console !== "undefined" && console.log && log) {
                    console.log(
                        `[DejaVu theme] uxpModule: ${!!uxpModule}, host: ${!!host}`
                    );
                }
                return null;
            }
            const themeName = parseThemeValue(
                host.uiTheme || host.theme || host.colorTheme
                    || host.applicationTheme
            );
            if (themeName === null) {
                if (typeof console !== "undefined" && console.log && log) {
                    console.log(
                        `[DejaVu theme] host theme value: ${host.uiTheme || host.theme || host.colorTheme || host.applicationTheme || "none"}`
                    );
                }
                return null;
            }
            const rgbByTheme = {
                darkest: [50, 50, 50],
                dark: [83, 83, 83],
                medium: [83, 83, 83],
                light: [185, 185, 185],
                lightest: [240, 240, 240]
            };
            const rgb = rgbByTheme[themeName] || [245, 245, 245];
            if (typeof console !== "undefined" && console.log && log) {
                console.log(
                    `[DejaVu theme] uxp host theme: ${themeName}, rgb: ${rgb.join(",")}`
                );
            }
            return {
                rgb,
                fontFamily: "",
                fontSize: 12,
                source: "uxp-host-theme",
                uiScalePreference: 1,
                uiScaleFactor: 1,
                largeTabsEnabled: false
            };
        } catch (e) {
            if (typeof console !== "undefined" && console.log && log) {
                console.log(
                    `[DejaVu theme] uxp host theme error: ${e && e.message ? e.message : e}`
                );
            }
            return null;
        }
    };

    /**
     * Reads the browser color-scheme fallback. This is used only outside
     * Illustrator/UXP or when no native host signal is available.
     * @return {{rgb: Array<number>, fontFamily: string, fontSize: number,
     *     source: string}}
     */
    const readBrowserColorSchemeSkin = () => {
        let isDark = true;
        if (window.matchMedia) {
            try {
                isDark = window.matchMedia(
                    "(prefers-color-scheme: dark)"
                ).matches;
            } catch (e) {
                isDark = true;
            }
        }
        return {
            rgb: isDark ? [50, 50, 50] : [240, 240, 240],
            fontFamily: "",
            fontSize: 12,
            source: "prefers-color-scheme",
            uiScalePreference: 1,
            uiScaleFactor: 1,
            largeTabsEnabled: false
        };
    };

    /**
     * Reads the strongest available theme source. Priority:
     * Illustrator uiBrightness -> UXP host metadata -> browser fallback.
     * @return {Promise<{{rgb: Array<number>, fontFamily: string, fontSize: number,
     *     source: string}}>}
     */
    const readHostSkin = async () => {
        const illustratorSkin = await readIllustratorBrightnessSkin();
        if (illustratorSkin) return illustratorSkin;
        const uxpSkin = readUxpHostThemeSkin();
        if (uxpSkin) return uxpSkin;
        return readBrowserColorSchemeSkin();
    };

    /**
     * Derives a complete UI palette from a single real background
     * color, anchored against the same chrome values used by def_colors.css
     * (Darkest #323232, Dark #535353, Light #B9B9B9, Lightest #F0F0F0).
     * Rather than
     * bucketing into fixed presets, every surface is computed as an
     * offset from the measured background, scaled by how dark/light
     * that background already is — so the relative contrast feels
     * consistent at every brightness level.
     * @param {Array<number>} bgRgb
     * @return {Object} Map of CSS variable name -> hex/rgba string.
     */
    const derivePalette = (bgRgb) => {
        const bgLum = luminance(bgRgb[0], bgRgb[1], bgRgb[2]);
        const isDark = bgLum < 128;

        // Bucket the measured background into the four brightness modes so
        // CSS can hand-tune popups per mode. Boundaries match the panel
        // backgrounds: #323232 (50), #535353 (83), #b9b9b9 (185), #f0f0f0 (240).
        const skin = bgLum <= 66 ? "darkest"
            : bgLum <= 128 ? "dark"
                : bgLum < 220 ? "light"
                    : "lightest";

        // How far toward black/white we are within our own mode,
        // 0 = at the boundary between modes (mid-gray ~128),
        // 1 = at the extreme (pure black or pure white panel).
        let depth = isDark ? 1 - bgLum / 128 : 1 - (255 - bgLum) / 128;
        depth = Math.max(0, Math.min(1, depth));

        // Recessed surfaces (inputs, wells) are always darker than
        // the panel — that's what makes them read as "inset" in both
        // Illustrator's light and dark skins. Raised surfaces/hover
        // states always go lighter. Only the *step size* shrinks as
        // we approach an extreme, so we still have headroom instead
        // of clamping to the same flat color as bg (e.g. white-on-
        // white at the Lightest skin, which was the original bug).
        // Light chrome can absorb a deeper downward step before a surface
        // or border gets too close to the panel colour, so give it more
        // headroom — this is what keeps borders and dim text legible on
        // light skins instead of washing out.
        const maxDown = Math.min(isDark ? 40 : 72, bgLum * 0.6);
        const maxUp = Math.min(40, (255 - bgLum) * 0.6);

        const raisedAmount = isDark ? lerp(10, 6, depth) : -lerp(10, 6, depth);
        // Fields (text inputs, dropdowns, spin-boxes) read LIGHTER than the
        // panel in Illustrator — near-white on light skins, a touch lighter
        // than the panel on dark skins — so they stand out from the panel and
        // from buttons. (Wells stay darker/recessed for chips and tracks.)
        const inputAmount = isDark ? lerp(16, 11, depth) : 0;
        const wellAmount = -Math.min(lerp(26, 34, depth), maxDown);
        const hoverAmount = isDark
            ? Math.min(lerp(16, 10, depth), maxUp)
            : -Math.min(lerp(16, 10, depth), maxDown);

        // Borders need a stronger step on light chrome than on dark,
        // where a faint line already reads — a 22-step border is nearly
        // invisible on a near-white panel.
        const borderAmount = isDark
            ? Math.min(22, maxUp)
            : -Math.min(38, maxDown);
        const borderSoftAmount = isDark
            ? -Math.min(lerp(14, 18, depth), maxDown)
            : -Math.min(lerp(26, 32, depth), maxDown);
        const borderStrongAmount = isDark
            ? Math.min(38, maxUp)
            : -Math.min(60, maxDown);

        const bgRaised = shade(bgRgb, raisedAmount);
        // Light skins: pure-white fields like Illustrator. Dark skins: a step
        // lighter than the panel.
        const bgInput = isDark ? shade(bgRgb, inputAmount) : [255, 255, 255];
        const bgInputWell = shade(bgRgb, wellAmount);
        const bgHover = shade(bgRgb, hoverAmount);
        const border = shade(bgRgb, borderAmount);
        const borderSoft = shade(bgRgb, borderSoftAmount);
        const borderStrong = shade(bgRgb, borderStrongAmount);

        const text = isDark ? [200, 200, 200] : [40, 40, 40];
        const textBright = isDark ? [239, 239, 239] : [10, 10, 10];

        // Dim/secondary text needs to stay legible at every measured
        // background lightness, not just at the two extremes — a
        // flat gray value that reads fine on #1e1e1e or on #ffffff
        // can look "disabled" on intermediate skins like Medium
        // Light, where it sits too close to the panel's own
        // lightness. Deriving it as a fixed luminance distance from
        // the *actual* measured background keeps the contrast ratio
        // stable across all four-plus brightness levels.
        const textDim = isDark
            ? shade(bgRgb, Math.max(95, 95 + (128 - bgLum) * 0.45))
            : shade(bgRgb, -Math.max(120, 120 + (bgLum - 128) * 0.45));

        // Accent blue. The two EXTREME skins (Darkest / Lightest) keep the
        // vibrant base blue — it already reads well there. Only the two middle
        // skins were the problem: on Dark the base is marginal and on Light it
        // was nearly invisible (~1.6:1) — so brighten it on Dark chrome and
        // deepen it on Light chrome. On-accent text stays white throughout.
        // Accent per mode. Darkest (#323232) keeps a balanced blue (~5:1,
        // stronger white-on-blue pills). Dark (#535353) is mid-gray, where a
        // blue tops out near 3.4:1 — pushed to the brightest readable blue to
        // get there (accepts paler pills). Light gets a deep blue, Lightest a
        // vibrant-but-readable one.
        const accent = isDark
            ? (bgLum <= 66 ? [96, 166, 236] : [122, 176, 238])
            : (bgLum >= 220 ? [31, 111, 192] : [16, 70, 128]);
        const accentDim = isDark ? [61, 110, 150] : [173, 205, 235];
        const accentText = [255, 255, 255];

        const ok = isDark ? [111, 191, 115] : [54, 137, 59];
        const warn = isDark ? [217, 162, 59] : [156, 105, 19];
        const danger = isDark ? [217, 111, 111] : [168, 54, 54];

        return {
            "--base-color-background": toHex(bgRgb),
            "--base-color-raised": toHex(bgRaised),
            "--base-color-input": toHex(bgInput),
            "--base-color-input-well": toHex(bgInputWell),
            "--base-color-hover": toHex(bgHover),
            "--base-color-border": toHex(border),
            "--base-color-border-soft": toHex(borderSoft),
            "--base-color-border-strong": toHex(borderStrong),
            "--base-color-text": toHex(text),
            "--base-color-text-dim": toHex(textDim),
            "--base-color-text-bright": toHex(textBright),
            "--base-color-accent": toHex(accent),
            "--base-color-accent-dim": toHex(accentDim),
            "--base-color-accent-text": toHex(accentText),
            "--base-color-ok": toHex(ok),
            "--base-color-warn": toHex(warn),
            "--base-color-danger": toHex(danger),
            "--base-color-accent-glow": toRgba(
                accent,
                isDark ? 0.28 : 0.22
            ),
            "--base-color-warn-tint": toRgba(warn, isDark ? 0.16 : 0.13),
            "--base-color-ok-tint": toRgba(ok, isDark ? 0.16 : 0.13),
            "_isDark": isDark,
            "_skin": skin
        };
    };

    /**
     * Applies the Illustrator UI scale and large-tabs preferences as CSS
     * variables and state classes.
     * @param {Object} root
     * @param {Object} style
     * @param {Object} skin
     */
    const applyUiScale = (root, style, skin) => {
        const scale = skin.uiScaleFactor;
        const rawPreference = skin.uiScalePreference === null
            || typeof skin.uiScalePreference === "undefined"
            ? scale
            : skin.uiScalePreference;
        const hasLargeTabs = !!skin.largeTabsEnabled;
        const largeTabsMultiplier = hasLargeTabs ? 1.08 : 1;
        const effectiveScale = scale * largeTabsMultiplier;

        style.setProperty("--primary-ui-scale-preference", String(rawPreference));
        style.setProperty("--primary-ui-scale", String(scale));
        style.setProperty(
            "--primary-large-tabs-scale",
            String(largeTabsMultiplier)
        );
        root.classList.toggle("ui-large-tabs", hasLargeTabs);
        root.classList.toggle("ui-compact-tabs", !hasLargeTabs);
        root.dataset.uiScale = String(scale);
        root.dataset.uiLargeTabs = hasLargeTabs ? "true" : "false";
    };

    /**
     * Applies a derived palette to :root as CSS custom properties,
     * and toggles the theme-light/theme-dark class on <html>.
     * @param {Object} palette
     * @param {Object} skin
     */
    const applyPalette = (palette, skin) => {
        const root = document.documentElement;
        const style = root.style;
        // Colours now live in the per-skin CSS map (html[data-skin="…"] in
        // style.css) — the single editable source of truth. theme.js only
        // selects the skin; it must NOT write --base-color-* inline, or those
        // inline values would override (and defeat) the map.
        Object.keys(palette).forEach((key) => {
            if (key.charAt(0) === "_") return;
            if (key.indexOf("--base-color-") === 0) return;
            style.setProperty(key, palette[key]);
        });
        // Feed the measured/snapped panel + accent colours into the safe color
        // seed layer. def_colors.css maps each skin to concrete Illustrator
        // panel colours, while these values keep the default/root fallback
        // aligned with the host until the skin is known.
        if (palette["--base-color-background"]) {
            style.setProperty(
                "--primary-color", palette["--base-color-background"]);
        }
        if (palette["--base-color-accent"]) {
            style.setProperty(
                "--primary-color-accent", palette["--base-color-accent"]);
        }
        if (palette["--base-color-accent-dim"]) {
            style.setProperty("--primary-color-accent-dim",
                palette["--base-color-accent-dim"]);
        }
        root.classList.toggle("theme-dark", !!palette._isDark);
        root.classList.toggle("theme-light", !palette._isDark);
        root.dataset.skin = palette._skin
            || (palette._isDark ? "dark" : "light");
        applyUiScale(root, style, skin);
        document.dispatchEvent(
            new CustomEvent("dejavuai:theme-applied", {
                detail: {
                    isDark: !!palette._isDark,
                    source: palette._source || "unknown",
                    uiScalePreference: skin.uiScalePreference,
                    uiScaleFactor: skin.uiScaleFactor,
                    largeTabsEnabled: !!skin.largeTabsEnabled
                }
            })
        );
    };

    /**
     * Records the resolved theme on the document for any CSS or JS
     * that wants a simple light/dark flag without re-deriving it
     * (e.g. `[data-theme="dark"]` selectors, or future icon swaps).
     * @param {boolean} isDark
     */
    const onThemeKnown = (isDark) => {
        document.documentElement.dataset.theme = isDark ? "dark" : "light";
    };

    // Debug override: when a skin is forced from the UI, the host poll must
    // not revert it.
    let forced = false;

    // Canonical panel colours for the four Illustrator brightness presets,
    // used by the debug skin override.
    const FORCE_RGB = {
        darkest: [50, 50, 50],
        dark: [83, 83, 83],
        light: [185, 185, 185],
        lightest: [240, 240, 240]
    };

    /**
     * Debug: force a brightness skin (darkest/dark/light/lightest), or "auto"
     * to resume host-driven sync. Only re-seeds the colour system + data-skin;
     * it deliberately leaves UI scale/font untouched.
     * @param {string} name
     * @return {string|null}
     */
    const forceSkin = (name) => {
        const root = document.documentElement;
        if (!name || name === "auto") {
            forced = false;
            syncTheme();
            return "auto";
        }
        const rgb = FORCE_RGB[name];
        if (!rgb) return null;
        forced = true;
        const palette = derivePalette(rgb);
        const style = root.style;
        style.setProperty("--primary-color", palette["--base-color-background"]);
        style.setProperty(
            "--primary-color-accent", palette["--base-color-accent"]);
        style.setProperty(
            "--primary-color-accent-dim", palette["--base-color-accent-dim"]);
        root.classList.toggle("theme-dark", !!palette._isDark);
        root.classList.toggle("theme-light", !palette._isDark);
        root.dataset.skin = name;
        root.dataset.themeSource = "forced";
        onThemeKnown(!!palette._isDark);
        return name;
    };

    /**
     * Reads the current skin and applies the derived theme.
     */
    const syncTheme = async () => {
        if (forced) return null;
        const skin = await readHostSkin();
        if (typeof console !== "undefined" && console.log && log) {
            console.log(
                `[DejaVu theme] source: ${skin.source}, rgb: ${skin.rgb.join(",")}, isDark: ${skin.rgb ? luminance(skin.rgb[0], skin.rgb[1], skin.rgb[2]) < 128 : "unknown"}`
            );
        }
        const palette = derivePalette(skin.rgb);
        palette._source = skin.source;
        applyPalette(palette, skin);
        onThemeKnown(!!palette._isDark);
        document.documentElement.dataset.themeSource = skin.source || "unknown";
        document.documentElement.dataset.uiScaleSource = skin.source || "unknown";
        return skin;
    };

    /**
     * Sets up live UXP/browser theme sync.
     */
    const init = () => {
        syncTheme().then((initialSkin) => {
            let lastRgb = initialSkin ? initialSkin.rgb : null;

            // Poll for brightness changes in CEP mode since Illustrator
            // doesn't emit events when uiBrightness changes.
            const pollInterval = window.setInterval(() => {
                syncTheme().then((skin) => {
                    if (!skin || !skin.rgb) return;
                    const currentRgb = skin.rgb.join(",");
                    const lastRgbStr = lastRgb ? lastRgb.join(",") : null;
                    if (currentRgb !== lastRgbStr) {
                        if (typeof console !== "undefined" && console.log && log) {
                            console.log(
                                `[DejaVu theme] brightness changed: ${lastRgbStr} -> ${currentRgb}`
                            );
                        }
                        lastRgb = skin.rgb;
                    }
                }).catch(() => {});
            }, 1000);

            // Store interval ID for cleanup if needed
            if (typeof window !== "undefined") {
                window.__DEJAVU_THEME_POLL_INTERVAL__ = pollInterval;
            }
        });

        const listener = () => {
            syncTheme();
        };

        [
            "uxphostthemecandlechanged",
            "uxphostthemechanged",
            "uxphostthemechange"
        ].forEach((eventName) => {
            try {
                window.addEventListener(eventName, listener);
            } catch (e) {}
        });

        if (window.matchMedia) {
            try {
                const media = window.matchMedia("(prefers-color-scheme: dark)");
                if (typeof media.addEventListener === "function") {
                    media.addEventListener("change", listener);
                } else if (typeof media.addListener === "function") {
                    media.addListener(listener);
                }
            } catch (e) {}
        }
    };

    return {
        init,
        syncTheme,
        derivePalette,
        forceSkin
    };
})();

if (typeof window !== "undefined") {
    window.DejaVuTheme = DejaVuTheme;
}
