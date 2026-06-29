/*
 * DejaVu — shared pure-logic core (DEJAVU namespace).
 *
 * Runtime-agnostic, side-effect-free helpers used by the client (via the
 * global `DEJAVU`) and by the unit tests (via Node `require`). Keeping the
 * pure logic here is the first step of R3 (replace scattered implicit
 * globals with an explicit namespace) and the foundation for R8 (tests):
 * these functions take their inputs as arguments — no DOM, no Illustrator
 * host — so they can be unit-tested with `node --test`.
 */
(function (root) {
    "use strict";

    const DEJAVU = {};

    /** Joins conditional CSS class names while dropping empty values. */
    DEJAVU.classNames = function () {
        return Array.prototype.filter.call(arguments, Boolean).join(" ");
    };

    /** Two-digit zero pad: 7 -> "07", 12 -> "12". */
    DEJAVU.pad2 = function (n) {
        return (n < 10 ? "0" : "") + n;
    };

    /** Human-readable byte size: "0 KB", "512 KB", "3.4 MB", "1.2 GB", "3.4 TB". */
    DEJAVU.formatBytes = function (bytes) {
        if (!bytes || bytes <= 0) return "0 KB";
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
        if (bytes < 1024 * 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
        return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + " TB";
    };

    /** "HH:MM:SS" from a Date. */
    DEJAVU.formatTime = function (d) {
        return DEJAVU.pad2(d.getHours()) + ":" +
            DEJAVU.pad2(d.getMinutes()) + ":" +
            DEJAVU.pad2(d.getSeconds());
    };

    /** "HH:MM:SS · DD/MM" from epoch ms, or "—" when falsy. */
    DEJAVU.formatTimestamp = function (ms) {
        if (!ms) return "—";
        const d = new Date(ms);
        return DEJAVU.formatTime(d) + " · " +
            DEJAVU.pad2(d.getDate()) + "/" + DEJAVU.pad2(d.getMonth() + 1);
    };

    /**
     * Compact relative age ("just now", "5 min ago", "yesterday",
     * "2 days ago", "3 months ago", "1 yr ago"). `now` is injectable so the
     * function is deterministic for tests; it defaults to Date.now().
     * @param {number} ms past epoch milliseconds
     * @param {number} [now]
     * @return {string}
     */
    DEJAVU.relativeAge = function (ms, now) {
        if (!ms) return "";
        const reference = typeof now === "number" ? now : Date.now();
        const deltaSec = Math.max(0, Math.round((reference - ms) / 1000));
        if (deltaSec < 45) return "just now";
        const deltaMin = Math.round(deltaSec / 60);
        if (deltaMin < 60) return deltaMin + " min ago";
        const deltaHr = Math.round(deltaMin / 60);
        if (deltaHr < 24) return deltaHr + " hr ago";
        const deltaDay = Math.round(deltaHr / 24);
        if (deltaDay === 1) return "yesterday";
        if (deltaDay < 30) return deltaDay + " days ago";
        const deltaMonth = Math.round(deltaDay / 30);
        if (deltaMonth < 12) {
            return deltaMonth + (deltaMonth === 1 ? " month ago" : " months ago");
        }
        return Math.round(deltaMonth / 12) + " yr ago";
    };

    /**
     * Signed size difference between two snapshots, e.g. { text: "+12 KB",
     * dir: "up" }. Uses a U+2212 minus for negatives to match the UI.
     * @param {number} bytes
     * @param {number} prevBytes
     * @return {{text:string,dir:string}}
     */
    DEJAVU.sizeDelta = function (bytes, prevBytes) {
        const diff = (bytes || 0) - (prevBytes || 0);
        if (diff === 0) return { text: "no change", dir: "flat" };
        const sign = diff > 0 ? "+" : "−";
        const abs = Math.abs(diff);
        let magnitude;
        if (abs < 1024) {
            magnitude = abs + " B";
        } else if (abs < 1024 * 1024) {
            magnitude = Math.round(abs / 1024) + " KB";
        } else {
            magnitude = (abs / (1024 * 1024)).toFixed(1) + " MB";
        }
        return { text: sign + magnitude, dir: diff > 0 ? "up" : "down" };
    };

    /**
     * Dejavu interval in milliseconds from a value + unit-in-seconds.
     * The value is floored at 1 and the unit defaults to 60 (minutes).
     */
    DEJAVU.intervalToMs = function (value, unitSeconds) {
        const v = Math.max(1, parseInt(value, 10) || 1);
        const u = parseInt(unitSeconds, 10) || 60;
        return v * u * 1000;
    };

    /** Collapse any run of slashes to a single "/" separator. */
    DEJAVU.collapseSlashes = function (path) {
        return String(path || "").replace(/\/+/g, "/");
    };

    /**
     * Substitute `$token` placeholders in a template with their values,
     * longest token first so a short token can't partially match a longer
     * one (e.g. "$YY" must not match inside "$YYYY"). Pure string op.
     * @param {string} template
     * @param {Object<string,string>} map token -> replacement
     * @return {string}
     */
    DEJAVU.applyTokens = function (template, map) {
        let value = String(template || "");
        const tokens = map || {};
        Object.keys(tokens)
            .sort(function (a, b) {
                return b.length - a.length;
            })
            .forEach(function (token) {
                value = value.split(token).join(tokens[token]);
            });
        return value;
    };

    /**
     * Resolve a folder/path template ("$defaultFolder/$filename" plus any
     * free text) into a concrete path: substitute tokens, then collapse
     * runs of slashes. Pure — the caller supplies the replacements (so
     * $defaultFolder must already be the *default* folder, never the
     * already-resolved per-document dejavu folder — see the duplicate-leaf
     * bug fixed in resolveDejavuRootFolder).
     * @param {string} template
     * @param {Object<string,string>} replacements token -> value
     * @return {string}
     */
    DEJAVU.resolveFolderTemplate = function (template, replacements) {
        return DEJAVU.collapseSlashes(
            DEJAVU.applyTokens(template || "$defaultFolder/$filename", replacements)
        );
    };

    /**
     * True when `token` appears in `template` not immediately followed by an
     * alphanumeric — so "$YY" is not considered present inside "$YYYY".
     * @param {string} template
     * @param {string} token
     * @return {boolean}
     */
    DEJAVU.tokenIsInTemplate = function (template, token) {
        const text = String(template || "");
        let from = 0;
        for (;;) {
            const idx = text.indexOf(token, from);
            if (idx === -1) return false;
            const nextChar = text.charAt(idx + token.length);
            if (!/[A-Za-z0-9]/.test(nextChar)) return true;
            from = idx + 1;
        }
    };

    /**
     * Parse a stored template string into ordered parts for a token editor:
     * runs of plain text and "$" tokens. Longest token matches first.
     * @param {string} template
     * @param {Array<string>} tokenStrings e.g. ["$filename", "$hh", ...]
     * @return {Array<{type:string,value?:string,trigger?:string,path?:string[]}>}
     */
    DEJAVU.tokenizeTemplate = function (template, tokenStrings) {
        const tokens = Array.isArray(tokenStrings) ? tokenStrings : [];
        const parts = [];
        let remaining = String(template || "");
        while (remaining.length > 0) {
            let bestIndex = -1;
            let bestToken = "";
            tokens.forEach(function (tok) {
                const index = remaining.indexOf(tok);
                if (index !== -1 &&
                    (bestIndex === -1 || index < bestIndex ||
                        (index === bestIndex && tok.length > bestToken.length))) {
                    bestIndex = index;
                    bestToken = tok;
                }
            });
            if (bestIndex === -1) {
                parts.push({ type: "text", value: remaining });
                break;
            }
            if (bestIndex > 0) {
                parts.push({ type: "text", value: remaining.slice(0, bestIndex) });
            }
            parts.push({
                type: "token",
                trigger: "$",
                path: [bestToken.slice(1)]
            });
            remaining = remaining.slice(bestIndex + bestToken.length);
        }
        return parts;
    };

    /**
     * Force a single "/" between every segment of a path template, so free
     * text typed between tokens always becomes "<token>/text/<token>". Token
     * strings are kept intact; text segments are trimmed of their own
     * surrounding slashes and rejoined with single separators. Pure.
     * @param {string} value
     * @param {Array<string>} tokens token strings to preserve
     * @return {string}
     */
    DEJAVU.forceTemplateSlashes = function (value, tokens) {
        const toks = (Array.isArray(tokens) ? tokens : [])
            .slice()
            .sort(function (a, b) {
                return b.length - a.length;
            });
        const pieces = [];
        let remaining = String(value || "");
        while (remaining.length > 0) {
            let bestIndex = -1;
            let bestToken = "";
            toks.forEach(function (t) {
                const i = remaining.indexOf(t);
                if (i !== -1 && (bestIndex === -1 || i < bestIndex ||
                    (i === bestIndex && t.length > bestToken.length))) {
                    bestIndex = i;
                    bestToken = t;
                }
            });
            if (bestIndex === -1) {
                const tail = remaining.replace(/^\/+|\/+$/g, "");
                if (tail.length) pieces.push(tail);
                break;
            }
            if (bestIndex > 0) {
                const seg = remaining.slice(0, bestIndex).replace(/^\/+|\/+$/g, "");
                if (seg.length) pieces.push(seg);
            }
            pieces.push(bestToken);
            remaining = remaining.slice(bestIndex + bestToken.length);
        }
        return pieces.join("/").replace(/\/+/g, "/");
    };

    /**
     * Normalize a folder template: collapse slashes, guarantee the required
     * root + leaf tokens are present (adding them if missing), and drop any
     * text before the root token. Pure.
     * @param {string} value
     * @param {Array<string>} tokens token strings to preserve
     * @param {string} [rootToken="$defaultFolder"]
     * @param {string} [leafToken="$filename"]
     * @return {string}
     */
    DEJAVU.normalizeFolderTemplate = function (value, tokens, rootToken, leafToken) {
        const root = rootToken || "$defaultFolder";
        const leaf = leafToken || "$filename";
        let v = DEJAVU.forceTemplateSlashes(value, tokens);
        if (!DEJAVU.tokenIsInTemplate(v, leaf)) {
            v = v.replace(/\/+$/, "") + "/" + leaf;
        }
        if (!DEJAVU.tokenIsInTemplate(v, root)) {
            v = root + "/" + v.replace(/^\/+/, "");
        } else {
            const idx = v.indexOf(root);
            if (idx > 0) v = v.slice(idx);
        }
        return DEJAVU.forceTemplateSlashes(v, tokens);
    };

    /**
     * Extract the editable middle path of a folder template — the segment
     * between the fixed $defaultFolder and $filename tokens, trimmed of
     * surrounding slashes. Pure string op.
     * @param {string} template
     * @return {string}
     */
    DEJAVU.folderTemplateMidValue = function (template) {
        let v = String(template || "");
        v = v.replace(/^\$defaultFolder/, "");
        v = v.replace(/\$filename$/, "");
        return v.replace(/^\/+|\/+$/g, "");
    };

    /**
     * Return a copy of `defaults` with values adopted from `parsed` for
     * exactly the keys the schema already defines — unknown/stale keys in
     * `parsed` are dropped. This is the settings-migration adopt step
     * (shallow, by design: nested objects are taken wholesale and then
     * normalized by the caller). Pass a throwaway clone as `defaults` if the
     * caller will mutate the result, since non-adopted nested values are
     * referenced, not deep-copied.
     * @param {Object} defaults
     * @param {Object} parsed
     * @return {Object}
     */
    DEJAVU.adoptKnownKeys = function (defaults, parsed) {
        const base = defaults && typeof defaults === "object" ? defaults : {};
        const out = {};
        Object.keys(base).forEach(function (k) {
            out[k] = base[k];
        });
        if (parsed && typeof parsed === "object") {
            Object.keys(out).forEach(function (k) {
                if (Object.prototype.hasOwnProperty.call(parsed, k)) {
                    out[k] = parsed[k];
                }
            });
        }
        return out;
    };

    /**
     * Deep-merge stored settings onto defaults, so a settings object saved
     * by an older version gains any newly-added default keys while keeping
     * the user's chosen values (settings migration). Arrays and primitives
     * from `stored` replace defaults; plain objects merge recursively.
     */
    DEJAVU.mergeSettings = function (defaults, stored) {
        const base = defaults && typeof defaults === "object" ? defaults : {};
        const over = stored && typeof stored === "object" ? stored : {};
        const out = {};
        Object.keys(base).forEach(function (k) {
            out[k] = base[k];
        });
        Object.keys(over).forEach(function (k) {
            const d = base[k];
            const s = over[k];
            const bothPlainObjects = d && s &&
                typeof d === "object" && typeof s === "object" &&
                !Array.isArray(d) && !Array.isArray(s);
            out[k] = bothPlainObjects ? DEJAVU.mergeSettings(d, s) : s;
        });
        return out;
    };

    root.DEJAVU = DEJAVU;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = DEJAVU;
    }
})(typeof window !== "undefined" ? window : globalThis);
