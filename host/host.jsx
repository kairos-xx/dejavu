// host.jsx
// DejaVu — ExtendScript host
// Runs inside Illustrator. All filesystem/document access happens here;
// the CEP panel only sends commands and reads back JSON strings.
//
// IMPORTANT: ExtendScript does NOT include a global JSON object by
// default (it's an ES3-era engine; JSON.stringify/parse only exist
// if some other Adobe panel happened to load a JSON library into the
// shared ExtendScript context first). Relying on a bare `JSON.*` call
// here is not safe — it works on some machines purely by accident of
// load order, and fails on a clean install with the literal error
// "JSON is undefined". The minimal polyfill below is installed only
// if no JSON object already exists, so it never clobbers a real one.

// Bump this whenever host.jsx changes in a way the panel depends on.
// The panel reads it back (dejavu_getHostVersion) right after load and
// warns if it doesn't match, which makes a *stale* host — one left in
// Illustrator's persistent ExtendScript engine from before a fix —
// visible instead of silently producing old behaviour.
var DEJAVU_HOST_VERSION = "2026.06.25-r32";

// Persist across $.evalFile reloads so reopening the CEP panel does not make
// an already-open unsaved document look like a new document session.
if (typeof DEJAVU_DOCUMENT_SESSION_REFS === "undefined") {
    DEJAVU_DOCUMENT_SESSION_REFS = [];
    DEJAVU_DOCUMENT_SESSION_IDS = [];
    DEJAVU_DOCUMENT_SESSION_SEQUENCE = 0;
}
if (typeof DEJAVU_OPENED_DEJAVU_SESSION_IDS === "undefined") {
    DEJAVU_OPENED_DEJAVU_SESSION_IDS = [];
}

function cleanupInvalidDocumentRefs() {
    var validRefs = [];
    var validIds = [];
    for (var i = 0; i < DEJAVU_DOCUMENT_SESSION_REFS.length; i++) {
        try {
            var ref = DEJAVU_DOCUMENT_SESSION_REFS[i];
            // Try to access a property to check if the reference is still valid
            if (ref && ref.name !== undefined) {
                validRefs.push(ref);
                validIds.push(DEJAVU_DOCUMENT_SESSION_IDS[i]);
            }
        } catch (e) {
            // Reference is invalid, skip it
        }
    }
    DEJAVU_DOCUMENT_SESSION_REFS = validRefs;
    DEJAVU_DOCUMENT_SESSION_IDS = validIds;
}

function getDocumentSessionId(doc) {
    cleanupInvalidDocumentRefs();
    for (var iSession = 0; iSession < DEJAVU_DOCUMENT_SESSION_REFS.length; iSession++) {
        try {
            if (DEJAVU_DOCUMENT_SESSION_REFS[iSession] === doc) {
                return DEJAVU_DOCUMENT_SESSION_IDS[iSession];
            }
        } catch (e) {
            // Skip invalid reference
            continue;
        }
    }
    DEJAVU_DOCUMENT_SESSION_SEQUENCE++;
    var id = "doc-" + new Date().getTime() + "-" +
        DEJAVU_DOCUMENT_SESSION_SEQUENCE;
    DEJAVU_DOCUMENT_SESSION_REFS.push(doc);
    DEJAVU_DOCUMENT_SESSION_IDS.push(id);
    return id;
}

function markDocumentAsOpenedDejavu(doc) {
    var id = getDocumentSessionId(doc);
    if (!openedDejavuSessionExists(id)) {
        DEJAVU_OPENED_DEJAVU_SESSION_IDS.push(id);
    }
    return id;
}

function isDocumentOpenedDejavu(doc) {
    var id = getDocumentSessionId(doc);
    return openedDejavuSessionExists(id);
}

function openedDejavuSessionExists(id) {
    for (var iOpened = 0;
        iOpened < DEJAVU_OPENED_DEJAVU_SESSION_IDS.length;
        iOpened++) {
        if (DEJAVU_OPENED_DEJAVU_SESSION_IDS[iOpened] === id) return true;
    }
    return false;
}

function dejavu_getHostVersion() {
    return JSON.stringify({ ok: true, version: DEJAVU_HOST_VERSION });
}

function dejavu_pathExists(path) {
    try {
        var file = new File(String(path || ""));
        return JSON.stringify({
            ok: true,
            exists: !!file.exists,
            path: file.fsName
        });
    } catch (err) {
        return JSON.stringify({
            ok: false,
            exists: false,
            error: String(err.message || err)
        });
    }
}

function dejavu_getFileSize(path) {
    try {
        var file = new File(String(path || ""));
        if (!file.exists) {
            return JSON.stringify({ ok: false, error: "File not found" });
        }
        return JSON.stringify({
            ok: true,
            size: file.length
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

if (typeof JSON === "undefined") {
    // eslint-disable-next-line no-global-assign
    JSON = {};
}

if (typeof JSON.stringify !== "function") {
    /**
     * Minimal JSON.stringify polyfill for ExtendScript. Handles the
     * subset this file actually produces: plain objects, arrays,
     * strings, numbers, booleans, and null. Does not attempt full
     * spec coverage (no replacer/indent args, no Date handling) since
     * none of that is used anywhere in this file.
     * @param {*} value
     * @return {string}
     */
    JSON.stringify = function (value) {
        if (value === null || value === undefined) {
            return "null";
        }
        var type = typeof value;
        if (type === "number" || type === "boolean") {
            return String(value);
        }
        if (type === "string") {
            return jsonQuoteString(value);
        }
        if (type === "object") {
            if (jsonIsArray(value)) {
                var arrParts = [];
                for (var i = 0; i < value.length; i++) {
                    arrParts.push(JSON.stringify(value[i]));
                }
                return "[" + arrParts.join(",") + "]";
            }
            var objParts = [];
            for (var key in value) {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    objParts.push(
                        jsonQuoteString(key) +
                            ":" +
                            JSON.stringify(value[key])
                    );
                }
            }
            return "{" + objParts.join(",") + "}";
        }
        return "null";
    };
}

if (typeof JSON.parse !== "function") {
    /**
     * Minimal JSON.parse polyfill for ExtendScript, implemented via
     * a guarded eval. The input is validated against a strict
     * JSON-only character whitelist first (after stripping string
     * literals and escapes), so this only ever evaluates data that
     * already looks like pure JSON — not arbitrary script — before
     * falling through to eval.
     * @param {string} text
     * @return {*}
     */
    JSON.parse = function (text) {
        var sanitized = String(text)
            .replace(/\\["\\\/bfnrtu]/g, "@")
            .replace(
                /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,
                "]"
            )
            .replace(/(?:^|:|,)(?:\s*\[)+/g, "");
        if (/^[\],:{}\s]*$/.test(sanitized)) {
            // eslint-disable-next-line no-eval
            return eval("(" + text + ")");
        }
        throw new Error("Invalid JSON: " + text);
    };
}

/**
 * Returns true if value is an Array. ExtendScript's engine predates
 * Array.isArray in some hosts, so this checks the constructor name
 * directly instead of assuming that method exists.
 * @param {*} value
 * @return {boolean}
 */
function jsonIsArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
}

/**
 * Quotes and escapes a string for JSON output.
 * @param {string} str
 * @return {string}
 */
function jsonQuoteString(str) {
    var escaped = str.replace(/[\\"\u0000-\u001f]/g, function (ch) {
        switch (ch) {
            case "\\":
                return "\\\\";
            case '"':
                return '\\"';
            case "\n":
                return "\\n";
            case "\r":
                return "\\r";
            case "\t":
                return "\\t";
            case "\b":
                return "\\b";
            case "\f":
                return "\\f";
            default:
                var code = ch.charCodeAt(0).toString(16);
                while (code.length < 4) code = "0" + code;
                return "\\u" + code;
        }
    });
    return '"' + escaped + '"';
}

/**
 * Pads a number to two digits.
 * @param {number} n
 * @return {string}
 */
function pad2(n) {
    return (n < 10 ? "0" : "") + n;
}

/**
 * Builds the token map for filename templates from a date and a base name.
 * @param {Date} d
 * @param {string} baseName Document name without extension.
 * @return {Object} Map of token -> resolved string.
 */
function buildTokenMap(d, baseName) {
    return {
        "$filename": baseName,
        "$hh": pad2(d.getHours()),
        "$mm": pad2(d.getMinutes()),
        "$ss": pad2(d.getSeconds()),
        "$dd": pad2(d.getDate()),
        "$MM": pad2(d.getMonth() + 1),
        "$YYYY": String(d.getFullYear()),
        "$YY": String(d.getFullYear()).slice(-2),
        "$date": String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()),
        "$time": pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()),
        "$counter": ""
    };
}

/**
 * Resolves a filename template against a token map.
 * Tokens are matched longest-first to avoid $MM colliding inside $mm, etc.
 * @param {string} template
 * @param {Object} tokens
 * @return {string}
 */
function resolveTemplate(template, tokens) {
    var keys = [];
    for (var k in tokens) {
        if (tokens.hasOwnProperty(k)) keys.push(k);
    }
    keys.sort(function (a, b) {
        return b.length - a.length;
    });
    var result = template;
    for (var i = 0; i < keys.length; i++) {
        var token = keys[i];
        var safeValue = String(tokens[token]).replace(/[\\\/:\*\?"<>\|]/g, "-");
        result = result.split(token).join(safeValue);
    }
    return result;
}

/**
 * Produces a lightweight content fingerprint for the active document.
 * This does not rely on app.activeDocument.saved alone, since that flag
 * does not reliably survive script-driven edits or template-based
 * comparisons across dejavu cycles. Instead we hash structural facts
 * that change whenever artwork changes.
 * @param {Document} doc
 * @return {string}
 */
function fingerprintHashText(hash, value) {
    var text = String(value === undefined || value === null ? "" : value);
    for (var iHash = 0; iHash < text.length; iHash++) {
        hash = ((hash << 5) - hash + text.charCodeAt(iHash)) & 0x7fffffff;
    }
    return hash;
}

function fingerprintSampleText(value) {
    var text = String(value || "");
    if (text.length <= 384) return text;
    var middle = Math.max(0, Math.floor(text.length / 2) - 64);
    return text.slice(0, 128) + text.slice(middle, middle + 128) +
        text.slice(-128) + "#" + text.length;
}

function fingerprintColor(color) {
    if (!color) return "";
    var values = [];
    try { values.push(color.typename || "Color"); } catch (eType) {}
    var channels = [
        "red", "green", "blue", "cyan", "magenta", "yellow", "black",
        "gray", "tint"
    ];
    for (var iChannel = 0; iChannel < channels.length; iChannel++) {
        try {
            if (color[channels[iChannel]] !== undefined) {
                values.push(
                    channels[iChannel] + ":" +
                    Math.round(Number(color[channels[iChannel]]) * 100)
                );
            }
        } catch (eChannel) {}
    }
    return values.join(",");
}

function fingerprintDocument(doc) {
    var parts = [];
    var hash = 5381;
    try {
        // Cache each collection length once. In ExtendScript every
        // collection-length access is a live DOM query, so reusing a
        // single read (especially for pathItems, hit three times
        // below) avoids redundant round-trips on large documents.
        var pathItems = doc.pathItems;
        var pathCount = pathItems.length;

        parts.push("layers:" + doc.layers.length);
        parts.push("items:" + doc.pageItems.length);
        parts.push("paths:" + pathCount);
        parts.push("groups:" + doc.groupItems.length);
        parts.push("compounds:" + doc.compoundPathItems.length);
        parts.push("text:" + doc.textFrames.length);
        parts.push("rasters:" + doc.rasterItems.length);
        parts.push("placed:" + doc.placedItems.length);
        parts.push("symbols:" + doc.symbolItems.length);
        parts.push("swatches:" + doc.swatches.length);
        // NB: doc.saved is deliberately NOT part of the fingerprint — it
        // flips as a side effect of autosaving (saveAs/clean state), so
        // including it made "only save when changed" fire every cycle on
        // unchanged artwork. The fingerprint must reflect content only.
        try { parts.push("artboards:" + doc.artboards.length); } catch (eArtboards) {}

        var sampleCount = Math.min(pathCount, 40);
        var coordAccum = 0;
        for (var i = 0; i < sampleCount; i++) {
            var pi = pathItems[i];
            try {
                var bounds = pi.geometricBounds;
                for (var b = 0; b < bounds.length; b++) {
                    coordAccum += Math.round(bounds[b] * 100);
                }
                hash = fingerprintHashText(hash,
                    "p:" + pi.closed + ":" + pi.filled + ":" + pi.stroked +
                    ":" + Math.round(Number(pi.strokeWidth || 0) * 100) +
                    ":" + fingerprintColor(pi.fillColor) +
                    ":" + fingerprintColor(pi.strokeColor)
                );
                var pointCount = Math.min(pi.pathPoints.length, 12);
                for (var p = 0; p < pointCount; p++) {
                    var point = pi.pathPoints[p];
                    hash = fingerprintHashText(
                        hash,
                        point.anchor.join(",") + ":" +
                            point.leftDirection.join(",") + ":" +
                            point.rightDirection.join(",")
                    );
                }
            } catch (eBounds) {
                // Item without geometric bounds (rare); skip silently.
            }
        }
        parts.push("coord:" + coordAccum);

        // Counts and bounds alone miss important edits such as replacing text
        // with similarly-sized text. Sample actual text contents and common
        // page-item properties so "Only save when changed" errs on the safe
        // side without traversing every object in a large illustration.
        var textFrames = doc.textFrames;
        var textCount = Math.min(textFrames.length, 60);
        for (var t = 0; t < textCount; t++) {
            try {
                hash = fingerprintHashText(
                    hash,
                    "t:" + fingerprintSampleText(textFrames[t].contents)
                );
            } catch (eText) {}
        }

        var pageItems = doc.pageItems;
        var itemCount = Math.min(pageItems.length, 80);
        for (var j = 0; j < itemCount; j++) {
            try {
                var item = pageItems[j];
                hash = fingerprintHashText(
                    hash,
                    "i:" + item.typename + ":" + (item.name || "") + ":" +
                        (item.note || "") + ":" +
                        Math.round(Number(item.opacity || 0) * 100) + ":" +
                        item.hidden + ":" + item.locked + ":" +
                        item.geometricBounds.join(",")
                );
            } catch (eItem) {}
        }
        parts.push("content:" + hash);
    } catch (e) {
        parts.push("err:" + e.message);
    }
    return parts.join("|");
}

/**
 * Returns JSON-safe info about the currently active document, or null
 * if there is no open document.
 *
 * @param {boolean} includeFingerprint When false, the (relatively
 *     expensive) structural fingerprint is skipped. Status-bar
 *     refreshes pass false since they only need the name/path/format;
 *     the dejavu cycle passes true (the default) because it needs
 *     the fingerprint to decide whether content changed. Skipping it
 *     avoids up to 40 geometricBounds queries on every periodic
 *     refresh of a complex document.
 * @return {string} JSON string.
 */
function dejavu_getActiveDocInfo(includeFingerprint) {
    if (app.documents.length === 0) {
        return JSON.stringify({ hasDoc: false });
    }
    var doc = app.activeDocument;
    var pathInfo = getDocumentPathInfo(doc);
    var hasPath = pathInfo.hasPath;
    var fullPath = pathInfo.fullPath;
    var baseName = doc.name.replace(/\.[^\.]+$/, "");

    var info = {
        hasDoc: true,
        docName: doc.name,
        baseName: baseName,
        documentSessionId: getDocumentSessionId(doc),
        openedDejavu: isDocumentOpenedDejavu(doc),
        hasPath: hasPath,
        fullPath: fullPath,
        dejavuFormat: hasPath ? detectDejavuExtension(fullPath) : "pdf",
        saved: doc.saved
    };
    // Default to including the fingerprint when the flag is omitted,
    // preserving the original behavior for any caller that doesn't
    // pass it.
    if (includeFingerprint !== false) {
        info.fingerprint = fingerprintDocument(doc);
    }
    return JSON.stringify(info);
}

/**
 * Lists every open Illustrator document with the identity the panel
 * needs to show a multi-document dejavu overview and act on each one
 * (switch to it, toggle its rule, save it). Cheap: no fingerprinting.
 * @return {string} JSON { ok, documents: [ {index, name, baseName,
 *     documentSessionId, hasPath, fullPath, saved, isActive} ] }.
 */
function dejavu_listOpenDocuments() {
    try {
        var active = null;
        try { active = app.activeDocument; } catch (eActive) { active = null; }
        var docs = [];
        for (var i = 0; i < app.documents.length; i++) {
            var doc = app.documents[i];
            var pathInfo = getDocumentPathInfo(doc);
            var diskModified = 0;
            if (pathInfo.hasPath && pathInfo.fullPath) {
                try {
                    var diskFile = new File(pathInfo.fullPath);
                    if (diskFile.exists && diskFile.modified) {
                        diskModified = diskFile.modified.getTime();
                    }
                } catch (eDiskModified) {
                    diskModified = 0;
                }
            }
            var isActive = false;
            try { isActive = (active && doc === active); } catch (eCmp) {}
            docs.push({
                index: i,
                name: doc.name,
                baseName: doc.name.replace(/\.[^\.]+$/, ""),
                documentSessionId: getDocumentSessionId(doc),
                hasPath: pathInfo.hasPath,
                fullPath: pathInfo.fullPath,
                diskModified: diskModified,
                modified: diskModified,
                saved: doc.saved,
                isActive: isActive
            });
        }
        return JSON.stringify({ ok: true, documents: docs });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Makes the document with the given session id the active document, so
 * the panel's active-document dejavu operates on it next.
 * @param {string} sessionId
 * @return {string} JSON result.
 */
function dejavu_activateDocument(sessionId) {
    try {
        var target = String(sessionId == null ? "" : sessionId);
        for (var i = 0; i < app.documents.length; i++) {
            var doc = app.documents[i];
            if (getDocumentSessionId(doc) === target) {
                app.activeDocument = doc;
                try { doc.activate(); } catch (eAct) {}
                return JSON.stringify({
                    ok: true, documentSessionId: target, name: doc.name
                });
            }
        }
        return JSON.stringify({
            ok: false,
            error: "That document is no longer open."
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Closes the document with the given session id. If the document has
 * unsaved changes, it will be closed without saving (user is responsible
 * for saving first via the panel's save functions).
 * @param {string} sessionId
 * @return {string} JSON result.
 */
function dejavu_closeDocument(sessionId) {
    try {
        var target = String(sessionId == null ? "" : sessionId);
        for (var i = 0; i < app.documents.length; i++) {
            var doc = app.documents[i];
            if (getDocumentSessionId(doc) === target) {
                var docName = doc.name;
                doc.close(SaveOptions.DONOTSAVECHANGES);
                return JSON.stringify({
                    ok: true, documentSessionId: target, name: docName
                });
            }
        }
        return JSON.stringify({
            ok: false,
            error: "That document is no longer open."
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Given a folder and a desired base filename (no extension), returns
 * a File reference that does not already exist on disk. The plain
 * resolved filename is always used first; only if that exact file
 * already exists is "_1", "_2", etc. appended. This means templates
 * with second-level timestamps normally keep their natural filename
 * without receiving an unnecessary suffix.
 * @param {Folder} folder
 * @param {string} baseName Filename without extension.
 * @param {string} extension Extension without the dot, e.g. "ai".
 * @return {File}
 */
function findUniqueFile(folder, baseName, extension) {
    var candidate = new File(
        folder.fsName + "/" + baseName + "." + extension
    );
    if (!candidate.exists) {
        return candidate;
    }
    var suffix = 1;
    var maxAttempts = 9999;
    while (suffix <= maxAttempts) {
        var numbered = new File(
            folder.fsName + "/" + baseName + "_" + suffix + "." + extension
        );
        if (!numbered.exists) {
            return numbered;
        }
        suffix++;
    }
    // Exhausted the numeric range (extremely unlikely) — fall back to
    // a timestamp suffix so we still never silently overwrite.
    return new File(
        folder.fsName + "/" + baseName + "_" + new Date().getTime() +
            "." + extension
    );
}



/**
 * Determines the dejavu file format for a document, derived from
 * its real filename extension so a .pdf stays .pdf, .eps stays .eps,
 * .svg stays .svg, etc. Recognized formats are the ones Illustrator
 * can round-trip with editable artwork: ai/pdf/eps (saved in place and
 * copied) and svg (via exportFile with editability preserved). Unknown
 * saved-file extensions fall back to "ai".
 *
 * @param {string} sourceName A filename or document name that may
 *     include an extension (e.g. "Logo.pdf", "Untitled-1").
 * @return {string} A lowercase extension without the dot: one of
 *     "ai", "pdf", "eps", or "svg".
 */
function detectDejavuExtension(sourceName) {
    var name = String(sourceName || "");
    var match = name.match(/\.([^.\\\/]+)$/);
    if (!match) return "ai";
    var ext = match[1].toLowerCase();
    if (ext === "pdf") return "pdf";
    if (ext === "eps") return "eps";
    if (ext === "svg") return "svg";
    return "ai";
}

/**
 * Returns true if a format is written with doc.exportFile(). SVG is
 * the editable format Illustrator exposes through exportFile; native
 * ai/pdf/eps documents use the save-in-place-and-copy path instead.
 *
 * @param {string} extension Lowercase extension without the dot.
 * @return {boolean}
 */
function isExportFormat(extension) {
    return extension === "svg";
}

/**
 * Builds the ExportOptionsSVG object for an SVG dejavu. Editability
 * is preserved so the exported SVG reopens in Illustrator as workable
 * artwork (matching a "Save As SVG" with editability on), and raster
 * images are embedded so the dejavu copy is self-contained rather
 * than referencing external files that may move.
 *
 * Note: scripted SVG export in ExtendScript runs the "Save As SVG"
 * engine, which can differ slightly from the modern UI "Export As"
 * (e.g. some blend-mode attributes), but it round-trips editable
 * artwork correctly, which is what matters for a recovery copy.
 *
 * @return {Object} An ExportOptionsSVG instance for doc.exportFile().
 */
function buildExportOptionsForSvg() {
    var svgOpts = new ExportOptionsSVG();
    try {
        svgOpts.embedRasterImages = true;
    } catch (eRaster) {
        // Property unavailable on very old hosts; ignore.
    }
    try {
        // Keep Illustrator editing data so the SVG reopens editable.
        svgOpts.preserveEditability = true;
    } catch (eEdit) {
        // Not all host versions expose this on the SVG options.
    }
    try {
        svgOpts.coordinatePrecision = 3;
    } catch (ePrec) {
        // Leave default precision if unavailable.
    }
    return svgOpts;
}

/**
 * Matches the filename extensions DejaVu can produce — the
 * editable formats it round-trips (native formats via save/copy or the
 * temporary conversion document, svg via exportFile). Used wherever
 * dejavu files are listed, counted, or
 * renamed so .pdf/.eps/.svg dejavus are recognized alongside .ai
 * rather than being ignored.
 * @type {RegExp}
 */
var DEJAVU_EXTENSION_PATTERN = /\.(ai|pdf|eps|svg)$/i;

/**
 * Sanitizes a document-derived name for safe filesystem use.
 * @param {string} name Raw document/file base name.
 * @return {string}
 */
function sanitizeFilesystemName(name) {
    var safe = String(name || "Untitled-1")
        .replace(/[\\\/:\*\?"<>\|]/g, "-")
        .replace(/^\s+|\s+$/g, "");
    if (!safe) safe = "Untitled-1";
    return safe;
}

/**
 * Returns the base filename from a File object or path string.
 * @param {*} value File or path string.
 * @return {string}
 */
function getPathBaseName(value) {
    var name = "";
    try {
        name = value && value.name ? String(value.name) : String(value || "");
        name = name.replace(/^.*[\\\/]/, "");
    } catch (e) {
        name = String(value || "").replace(/^.*[\\\/]/, "");
    }
    return sanitizeFilesystemName(name.replace(/\.[^\.]+$/, ""));
}

/**
 * Returns true when childPath is inside parentPath, or is the same path.
 * @param {string} childPath Candidate child path.
 * @param {string} parentPath Candidate parent path.
 * @return {boolean}
 */
function pathIsInside(childPath, parentPath) {
    if (!childPath || !parentPath) return false;
    var child = String(childPath).replace(/\\/g, "/");
    var parent = String(parentPath).replace(/\\/g, "/");
    if (child === parent) return true;
    if (parent.charAt(parent.length - 1) !== "/") parent += "/";
    return child.indexOf(parent) === 0;
}

/**
 * Returns the document's real source path when one exists on disk.
 *
 * Most Illustrator versions throw when doc.fullName is read for a new,
 * never-saved document. Some versions instead return a synthetic File such
 * as "/Untitled-1", whose fsName can resolve to "/Volumes/Untitled-1" on
 * macOS. A non-empty fsName therefore does not prove that the document was
 * saved. Requiring File.exists distinguishes a real source file from that
 * synthetic value and keeps unsaved documents rooted at the configured
 * default dejavu folder.
 *
 * @param {Document} doc Illustrator document.
 * @return {Object} hasPath, fullPath, and ownFolderPath.
 */
function getDocumentPathInfo(doc) {
    var info = {
        hasPath: false,
        fullPath: "",
        ownFolderPath: ""
    };
    try {
        var candidate = doc.fullName;
        if (!candidate || !candidate.fsName || !candidate.exists) return info;
        var candidatePath = String(candidate.fsName);
        var parent = candidate.parent;
        if (!candidatePath || !parent || !parent.fsName) return info;
        info.hasPath = true;
        info.fullPath = candidatePath;
        info.ownFolderPath = String(parent.fsName);
    } catch (eDocumentPath) {
        // Never-saved documents normally arrive here.
    }
    return info;
}


function dejavuGetLogFile() {
    var root = Folder.userData;
    var folder = new Folder(root.fsName + "/DejaVu");
    if (!folder.exists) folder.create();
    return new File(folder.fsName + "/dejavu-log.txt");
}

function dejavuLog(message) {
    try {
        var file = dejavuGetLogFile();
        file.encoding = "UTF-8";
        file.open("a");
        file.writeln("[" + new Date().toUTCString() + "] " + message);
        file.close();
    } catch (e) {
    }
}

function dejavu_getLogPath() {
    try {
        var file = dejavuGetLogFile();
        if (!file.exists) {
            file.open("w");
            file.writeln("DejaVu log");
            file.close();
        }
        return JSON.stringify({ ok: true, path: file.fsName });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Returns a filesystem-based signature for this installed extension.
 * CEP localStorage can survive extension reinstalls, so the panel uses
 * this signature to detect a new copy and show the one-time splash again.
 * @return {string} JSON with the install signature.
 */
function dejavu_getInstallSignature() {
    try {
        var hostFile = new File($.fileName);
        var hostFolder = hostFile.parent;
        var rootFolder = hostFolder.parent;
        var manifestFile = new File(rootFolder.fsName + "/CSXS/manifest.xml");
        var indexFile = new File(rootFolder.fsName + "/client/index.html");
        var files = [hostFile, manifestFile, indexFile];
        var parts = [rootFolder.fsName];
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            var created = file.created ? file.created.getTime() : 0;
            var modified = file.modified ? file.modified.getTime() : 0;
            var length = file.exists ? file.length : -1;
            parts.push(file.name + ":" + created + ":" + modified + ":" + length);
        }
        return JSON.stringify({
            ok: true,
            signature: parts.join("|"),
            rootPath: rootFolder.fsName
        });
    } catch (err) {
        return JSON.stringify({
            ok: false,
            error: String(err.message || err)
        });
    }
}

function dejavuGetManifestFile(folder) {
    return new File(folder.fsName + "/dejavu-manifest.jsonl");
}

function appendManifestEntry(folder, entry) {
    try {
        var manifest = dejavuGetManifestFile(folder);
        manifest.encoding = "UTF-8";
        manifest.open("a");
        manifest.writeln(JSON.stringify(entry));
        manifest.close();
    } catch (eManifest) {
        dejavuLog("Manifest write failed: " + String(eManifest.message || eManifest));
    }
}

function readManifestEntries(folder) {
    var entries = [];
    try {
        var manifest = dejavuGetManifestFile(folder);
        if (!manifest.exists) return entries;
        manifest.encoding = "UTF-8";
        manifest.open("r");
        var line;
        while (!manifest.eof) {
            line = manifest.readln();
            if (line) {
                try {
                    entries.push(JSON.parse(line));
                } catch (eParse) {
                    dejavuLog("Failed to parse manifest line: " + String(line));
                }
            }
        }
        manifest.close();
    } catch (eRead) {
        dejavuLog("Manifest read failed: " + String(eRead.message || eRead));
    }
    return entries;
}

function removeManifestEntries(folder, pathsToRemove) {
    try {
        var manifest = dejavuGetManifestFile(folder);
        if (!manifest.exists) return;
        
        var entries = readManifestEntries(folder);
        var kept = [];
        var removeMap = {};
        for (var i = 0; i < pathsToRemove.length; i++) {
            removeMap[pathsToRemove[i]] = true;
        }
        for (var i = 0; i < entries.length; i++) {
            if (!removeMap[entries[i].dejavuPath]) {
                kept.push(entries[i]);
            }
        }
        
        // Delete and recreate to force file refresh
        manifest.remove();
        manifest = dejavuGetManifestFile(folder);
        manifest.encoding = "UTF-8";
        manifest.open("w");
        for (var j = 0; j < kept.length; j++) {
            manifest.writeln(JSON.stringify(kept[j]));
        }
        manifest.close();
    } catch (eRemove) {
        dejavuLog("Manifest remove failed: " + String(eRemove.message || eRemove));
    }
}

function removeMissingManifestEntries(folder) {
    try {
        var entries = readManifestEntries(folder);
        var missingPaths = [];
        for (var i = 0; i < entries.length; i++) {
            var file = new File(entries[i].dejavuPath);
            if (!file.exists) {
                missingPaths.push(entries[i].dejavuPath);
            }
        }
        if (missingPaths.length > 0) {
            removeManifestEntries(folder, missingPaths);
        }
        return missingPaths.length;
    } catch (eMissing) {
        dejavuLog("Remove missing manifest entries failed: " + String(eMissing.message || eMissing));
        return 0;
    }
}

function removeManifestEntry(folder, path) {
    try {
        var manifest = dejavuGetManifestFile(folder);
        if (!manifest.exists) return { ok: true, removed: false };
        
        var entries = readManifestEntries(folder);
        var found = false;
        var kept = [];
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].dejavuPath === path) {
                found = true;
            } else {
                kept.push(entries[i]);
            }
        }
        
        if (found) {
            manifest.encoding = "UTF-8";
            manifest.open("w");
            for (var j = 0; j < kept.length; j++) {
                manifest.writeln(JSON.stringify(kept[j]));
            }
            manifest.close();
        }
        
        return { ok: true, removed: found };
    } catch (eRemove) {
        dejavuLog("Remove manifest entry failed: " + String(eRemove.message || eRemove));
        return { ok: false, error: String(eRemove.message || eRemove) };
    }
}

function verifyDejavuFile(file) {
    if (!file || !file.exists) {
        return { ok: false, error: "Dejavu file was not created." };
    }
    if (file.length <= 0) {
        return { ok: false, error: "Dejavu file was created but is empty." };
    }
    return { ok: true, size: file.length };
}

function checkFolderWritable(folder) {
    try {
        if (!folder.exists && !folder.create()) return false;
        var test = new File(folder.fsName + "/.dejavuai-write-test");
        test.open("w");
        test.write("ok");
        test.close();
        var ok = test.exists;
        if (ok) test.remove();
        return ok;
    } catch (eWritable) {
        return false;
    }
}

/**
 * Adjusts a folder template for the current document. For a document
 * that has already been saved, $defaultFolder behaves as $documentFolder
 * so dejavus live beside the document itself rather than in the
 * default folder (which is only the fallback for unsaved documents).
 * @param {string} template
 * @param {boolean} hasPath True when the document has a file on disk.
 * @return {string}
 */
function templateForDocument(template, hasPath) {
    var t = String(template || "$documentFolder/$filename");
    if (hasPath) {
        t = t.split("$defaultFolder").join("$documentFolder");
    }
    return t;
}

function resolveFolderTemplate(template, defaultFolder, documentFolder, baseName) {
    var value = String(template || "$documentFolder/$filename");
    value = value.split("$documentFolder").join(documentFolder || defaultFolder || "");
    value = value.split("$defaultFolder").join(defaultFolder || documentFolder || "");
    value = value.split("$filename").join(sanitizeFilesystemName(baseName));
    value = value.split("$dejavus").join("Dejavus");
    return value.replace(/\/+/g, "/");
}

function getActiveDocumentContext(
    defaultFolder,
    folderPerDocument,
    unsavedFolderPath,
    folderTemplate,
    pendingDocumentSessionId
) {
    if (app.documents.length === 0) {
        return { ok: false, error: "No active document." };
    }
    var doc = app.activeDocument;
    var baseName = sanitizeFilesystemName(doc.name.replace(/\.[^\.]+$/, ""));
    var pathInfo = getDocumentPathInfo(doc);
    var hasPath = pathInfo.hasPath;
    var ownFolderPath = pathInfo.ownFolderPath;
    var fullPath = pathInfo.fullPath;
    var currentDocumentSessionId = getDocumentSessionId(doc);
    var pendingMatchesDocument = !!(
        pendingDocumentSessionId &&
        pendingDocumentSessionId === currentDocumentSessionId
    );
    var pending = pendingMatchesDocument &&
        isValidHostFolderPath(unsavedFolderPath)
        ? String(unsavedFolderPath)
        : "";
    if (pending && pathIsInside(fullPath, pending)) {
        hasPath = false;
        ownFolderPath = "";
    }
    var targetFolderPath = "";
    if (folderPerDocument) {
        if (hasPath) {
            targetFolderPath = resolveFolderTemplate(
                folderTemplate || "$documentFolder/$filename",
                defaultFolder,
                ownFolderPath,
                baseName
            );
        } else {
            // Mirror the hardened save-path resolution: root at the
            // default folder (never an empty string, which would make
            // new Folder("/" + baseName) resolve a bogus boot-volume
            // path like "/Volumes/Untitled-1"). Only reuse a remembered
            // pending folder when it still exists on disk.
            if (!isValidHostFolderPath(defaultFolder)) {
                return { ok: false, error: "No default folder selected." };
            }
            if (isValidHostFolderPath(pending) && new Folder(pending).exists) {
                targetFolderPath = pending;
            } else {
                targetFolderPath = findUniqueFolder(
                    new Folder(defaultFolder),
                    baseName,
                    2
                ).fsName;
            }
        }
    } else {
        // Honour the folder template even without per-document mode so
        // the timeline/status folder matches where saves actually land.
        targetFolderPath = resolveFolderTemplate(
            templateForDocument(folderTemplate, hasPath),
            defaultFolder,
            hasPath ? ownFolderPath : defaultFolder,
            baseName
        );
    }
    return {
        ok: true,
        doc: doc,
        baseName: baseName,
        hasPath: hasPath,
        ownFolderPath: ownFolderPath,
        fullPath: fullPath,
        folderPath: targetFolderPath,
        newUnsavedDocument: !hasPath && !pending
    };
}

function getFilesSortedByModified(folder) {
    var out = [];
    if (!folder || !folder.exists) return out;
    var entries = folder.getFiles(function (f) {
        return f instanceof File && DEJAVU_EXTENSION_PATTERN.test(f.name);
    });
    for (var i = 0; i < entries.length; i++) out.push(entries[i]);
    out.sort(function (a, b) {
        return b.modified.getTime() - a.modified.getTime();
    });
    return out;
}

function dejavu_listDejavus(
    defaultFolder,
    folderPerDocument,
    unsavedFolderPath,
    folderTemplate,
    pendingDocumentSessionId
) {
    try {
        var ctx = getActiveDocumentContext(
            defaultFolder,
            folderPerDocument,
            unsavedFolderPath,
            folderTemplate,
            pendingDocumentSessionId
        );
        if (!ctx.ok) return JSON.stringify(ctx);
        var folder = new Folder(ctx.folderPath);
        
        // Read manifest entries for persistent history
        var manifestEntries = readManifestEntries(folder);
        var manifestPaths = {};
        for (var i = 0; i < manifestEntries.length; i++) {
            manifestPaths[manifestEntries[i].dejavuPath] = manifestEntries[i];
        }
        
        // Get current files on disk
        var files = getFilesSortedByModified(folder);
        var diskPaths = {};
        for (var j = 0; j < files.length; j++) {
            diskPaths[files[j].fsName] = true;
        }
        
        // Combine manifest entries with current files
        var items = [];
        var seen = {};
        
        // First add manifest entries (includes deleted files)
        for (var k = 0; k < manifestEntries.length; k++) {
            var entry = manifestEntries[k];
            var path = entry.dejavuPath;
            if (!seen[path]) {
                seen[path] = true;
                var exists = !!diskPaths[path];
                items.push({
                    name: entry.document || (new File(path)).name,
                    path: path,
                    size: entry.size || 0,
                    modified: entry.timestamp || 0,
                    exists: exists,
                    fromManifest: true
                });
            }
        }
        
        // Then add any files on disk not in manifest
        for (var m = 0; m < files.length; m++) {
            var filePath = files[m].fsName;
            if (!seen[filePath]) {
                seen[filePath] = true;
                items.push({
                    name: files[m].name,
                    path: filePath,
                    size: files[m].length,
                    modified: files[m].modified.getTime(),
                    exists: true,
                    fromManifest: false
                });
            }
        }
        
        // Sort by modified time
        items.sort(function (a, b) {
            return (b.modified || 0) - (a.modified || 0);
        });

        var totalBytes = 0;
        var missingCount = 0;
        var existingCount = 0;
        for (var s = 0; s < items.length; s++) {
            if (items[s].exists === false) {
                missingCount++;
            } else {
                existingCount++;
                totalBytes += Number(items[s].size || 0);
            }
        }
        
        return JSON.stringify({
            ok: true,
            folder: folder.fsName,
            files: items,
            stats: {
                totalBytes: totalBytes,
                missingCount: missingCount,
                existingCount: existingCount,
                manifestCount: manifestEntries.length
            }
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

function dejavu_healthCheck(
    defaultFolder,
    folderPerDocument,
    unsavedFolderPath,
    folderTemplate,
    pendingDocumentSessionId
) {
    try {
        var info = JSON.parse(dejavu_getActiveDocInfo(false));
        if (info.ok === false || !info.hasDoc) {
            return JSON.stringify({ ok: false, error: info.error || "No active document." });
        }
        var ctx = getActiveDocumentContext(
            defaultFolder,
            folderPerDocument,
            unsavedFolderPath,
            folderTemplate,
            pendingDocumentSessionId
        );
        if (!ctx.ok) return JSON.stringify(ctx);
        var folder = new Folder(ctx.folderPath);
        var writable = checkFolderWritable(folder);
        var files = getFilesSortedByModified(folder);
        var folderBytes = 0;
        for (var i = 0; i < files.length; i++) {
            folderBytes += Number(files[i].length || 0);
        }
        return JSON.stringify({
            ok: true,
            document: info.docName,
            hasPath: info.hasPath,
            format: info.dejavuFormat || "ai",
            folder: folder.fsName,
            folderExists: folder.exists,
            folderWritable: writable,
            fileCount: files.length,
            folderBytes: folderBytes,
            nonSwitchingRecommended: info.hasPath
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

function dejavu_removeManifestEntry(folderPath, path) {
    try {
        if (!isValidHostFolderPath(folderPath)) return JSON.stringify({ ok: false, error: "Invalid folder" });
        var folder = new Folder(folderPath);
        if (!folder.exists) return JSON.stringify({ ok: false, error: "Folder not found" });
        return JSON.stringify(removeManifestEntry(folder, path));
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

function dejavu_cleanupDejavus(
    folderPath,
    keepCount,
    keepDays,
    maxFolderSizeMb,
    protectedPaths
) {
    try {
        if (!isValidHostFolderPath(folderPath)) return JSON.stringify({ ok: true, deleted: 0 });
        var folder = new Folder(folderPath);
        if (!folder.exists) return JSON.stringify({ ok: true, deleted: 0 });
        var files = getFilesSortedByModified(folder);
        var deleted = 0;
        var now = new Date().getTime();
        var keep = Number(keepCount || 0);
        var days = Number(keepDays || 0);
        var maxBytes = Number(maxFolderSizeMb || 0) * 1024 * 1024;
        var protectedMap = {};
        var protectedList = protectedPaths || [];
        for (var p = 0; p < protectedList.length; p++) {
            try {
                protectedMap[(new File(protectedList[p])).fsName] = true;
            } catch (eProtectedPath) {}
        }
        var protectedSkipped = 0;
        var remaining = [];
        for (var i = 0; i < files.length; i++) {
            if (protectedMap[files[i].fsName]) {
                remaining.push(files[i]);
                protectedSkipped++;
                continue;
            }
            var removeByCount = keep > 0 && i >= keep;
            var removeByAge = days > 0 && now - files[i].modified.getTime() > days * 86400000;
            if (removeByCount || removeByAge) {
                if (files[i].remove()) deleted++;
            } else {
                remaining.push(files[i]);
            }
        }
        if (maxBytes > 0) {
            var total = 0;
            for (var j = 0; j < remaining.length; j++) total += remaining[j].length;
            for (var k = remaining.length - 1; k >= 0 && total > maxBytes; k--) {
                if (protectedMap[remaining[k].fsName]) continue;
                var size = remaining[k].length;
                if (remaining[k].remove()) {
                    total -= size;
                    deleted++;
                }
            }
        }
        dejavuLog("Cleanup in " + folder.fsName + ": deleted " + deleted + " file(s)");
        
        // Also remove missing entries from manifest
        var missingRemoved = removeMissingManifestEntries(folder);
        
        return JSON.stringify({
            ok: true,
            deleted: deleted,
            "protected": protectedSkipped,
            "missingRemoved": missingRemoved
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Opens the OS file browser (Finder / Explorer) for a path. For a
 * folder, the folder itself is opened; for a file, its containing
 * folder is opened.
 *
 * Implementation note: this uses Folder.execute() directly, which
 * asks the OS to open the folder in the default file browser. An
 * earlier version wrote a temporary `open -R` / `explorer /select`
 * shell script and ran it via File.execute() to also *select* the
 * file — but on recent macOS, File.execute() on a .sh opens it in a
 * text editor instead of running it, so the command never executed
 * and nothing happened. Opening the containing folder via execute()
 * is the reliable behaviour across versions, even though it doesn't
 * pre-select the file.
 *
 * @param {string} path Absolute path to a file or folder.
 * @return {string} JSON result; ok:false (with reason) if the OS
 *     refused to open it, so the panel can surface a real message
 *     instead of silently doing nothing.
 */
function dejavu_revealPath(path) {
    try {
        if (!isValidHostFolderPath(path)) {
            return JSON.stringify({ ok: false, error: "No path to reveal." });
        }

        // Resolve to the folder we should open: the path itself if it
        // is a folder, otherwise the file's parent folder.
        var folderToOpen = null;
        var fileTarget = new File(path);
        if (fileTarget.exists) {
            folderToOpen = fileTarget.parent;
        } else {
            var folderTarget = new Folder(path);
            if (folderTarget.exists) {
                folderToOpen = folderTarget;
            }
        }

        if (!folderToOpen || !folderToOpen.exists) {
            return JSON.stringify({
                ok: false,
                error: "Path does not exist on disk: " + String(path)
            });
        }

        var opened = folderToOpen.execute();
        if (!opened) {
            return JSON.stringify({
                ok: false,
                error: "The OS could not open: " + folderToOpen.fsName
            });
        }
        return JSON.stringify({ ok: true, path: folderToOpen.fsName });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

function dejavu_openPath(path) {
    try {
        var file = new File(path);
        if (!file.exists) return JSON.stringify({ ok: false, error: "File not found." });
        var openedDoc = app.open(file);
        var openedSessionId = markDocumentAsOpenedDejavu(openedDoc);
        dejavuLog("Opened dejavu " + file.fsName);
        return JSON.stringify({
            ok: true,
            path: file.fsName,
            documentSessionId: openedSessionId,
            openedDejavu: true
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

function dejavu_deletePath(path) {
    try {
        var file = new File(path);
        if (!file.exists) return JSON.stringify({ ok: false, error: "File not found." });
        var removed = file.remove();
        if (removed) dejavuLog("Deleted dejavu " + file.fsName);
        return JSON.stringify({ ok: removed, error: removed ? "" : "Could not delete file." });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

function dejavu_duplicateRecovery(path) {
    try {
        var file = new File(path);
        if (!file.exists) return JSON.stringify({ ok: false, error: "File not found." });
        var stem = file.name.replace(/\.[^\.]+$/, "") + "_recovery";
        var target = findUniqueFile(file.parent, stem, "ai");
        if (!file.copy(target.fsName)) {
            return JSON.stringify({ ok: false, error: "Could not duplicate file." });
        }
        dejavuLog("Created recovery copy " + target.fsName);
        return JSON.stringify({ ok: true, path: target.fsName });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

function dejavu_getRecoveryWarning(
    defaultFolder,
    folderPerDocument,
    unsavedFolderPath,
    folderTemplate,
    pendingDocumentSessionId
) {
    try {
        var ctx = getActiveDocumentContext(
            defaultFolder,
            folderPerDocument,
            unsavedFolderPath,
            folderTemplate,
            pendingDocumentSessionId
        );
        if (!ctx.ok || !ctx.hasPath) return JSON.stringify({ ok: true, hasNewerDejavu: false });
        if (isDocumentOpenedDejavu(ctx.doc)) {
            return JSON.stringify({
                ok: true,
                hasNewerDejavu: false,
                openedDejavu: true
            });
        }
        var folder = new Folder(ctx.folderPath);
        var files = getFilesSortedByModified(folder);
        if (files.length === 0) return JSON.stringify({ ok: true, hasNewerDejavu: false });
        var docFile = new File(ctx.fullPath);
        var docModified = docFile.exists ? docFile.modified.getTime() : 0;
        var latest = files[0];
        var newer = latest.modified.getTime() > docModified;
        return JSON.stringify({
            ok: true,
            hasNewerDejavu: newer,
            latestName: latest.name,
            latestPath: latest.fsName,
            latestModified: latest.modified.getTime(),
            documentModified: docModified
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

function backupOriginalIfNeeded(fullPath, folder, baseName) {
    if (!fullPath) return "";
    var original = new File(fullPath);
    if (!original.exists) return "";
    // The backup is a byte-for-byte copy of the real file, so it must
    // keep that file's own extension (a .pdf backup stays .pdf) rather
    // than being mislabeled .ai.
    var backupExtension = detectDejavuExtension(fullPath);
    var target = findUniqueFile(
        folder,
        baseName + "_before_dejavu",
        backupExtension
    );
    if (original.copy(target.fsName)) {
        dejavuLog("Backed up original before dejavu: " + target.fsName);
        return target.fsName;
    }
    return "";
}

/**
 * Creates a folder if missing.
 * @param {Folder} folder Folder to ensure.
 * @return {boolean}
 */
function ensureFolderExists(folder) {
    if (folder.exists) return true;
    return folder.create();
}

/**
 * Finds a unique folder under parent, suffixing _1, _2, ... if needed.
 * @param {Folder} parent Parent folder.
 * @param {string} baseName Desired folder base name.
 * @return {Folder}
 */
function findUniqueFolder(parent, baseName, firstSuffix) {
    var safeName = sanitizeFilesystemName(baseName);
    // Defend against a parent that resolved to an empty fsName, which
    // would otherwise build a boot-volume-relative "/name" path.
    var parentPath = parent && parent.fsName ? String(parent.fsName) : "";
    if (!parentPath) {
        throw new Error("Cannot create a folder: parent path is empty.");
    }
    var candidate = new Folder(parentPath + "/" + safeName);
    if (!candidate.exists) return candidate;
    var suffix = typeof firstSuffix === "number" ? firstSuffix : 1;
    while (suffix < 10000) {
        candidate = new Folder(parentPath + "/" + safeName + "_" + suffix);
        if (!candidate.exists) return candidate;
        suffix++;
    }
    return new Folder(parentPath + "/" + safeName + "_" + new Date().getTime());
}

/**
 * Copies a folder recursively.
 * @param {Folder} source Source folder.
 * @param {Folder} destination Destination folder.
 * @return {boolean}
 */
function copyFolderRecursive(source, destination) {
    if (!ensureFolderExists(destination)) return false;
    var entries = source.getFiles();
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry instanceof Folder) {
            var childFolder = new Folder(destination.fsName + "/" + entry.name);
            if (!copyFolderRecursive(entry, childFolder)) return false;
        } else {
            var childFile = new File(destination.fsName + "/" + entry.name);
            if (childFile.exists) childFile.remove();
            if (!entry.copy(childFile.fsName)) return false;
        }
    }
    return true;
}

/**
 * Removes a folder recursively.
 * @param {Folder} folder Folder to remove.
 */
function removeFolderRecursive(folder) {
    if (!folder.exists) return;
    var entries = folder.getFiles();
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry instanceof Folder) {
            removeFolderRecursive(entry);
        } else {
            try {
                entry.remove();
            } catch (eFile) {
                // Best-effort cleanup only.
            }
        }
    }
    try {
        folder.remove();
    } catch (eFolder) {
        // Best-effort cleanup only.
    }
}


/**
 * Copies a file and optionally replaces an existing destination first.
 * @param {File} source Existing source file.
 * @param {File} destination Destination file.
 * @param {boolean} overwriteExisting Whether the destination may be replaced.
 * @return {boolean}
 */
function copyFileWithOptionalOverwrite(source, destination, overwriteExisting) {
    if (!source || !source.exists) return false;
    if (destination.exists) {
        if (!overwriteExisting) return false;
        try {
            if (!destination.remove()) return false;
        } catch (eRemoveExistingCopy) {
            return false;
        }
    }
    return source.copy(destination.fsName);
}

/**
 * Saves the active document without letting the active document become the
 * dejavu file. Illustrator does not expose a direct silent "save a copy"
 * DOM method for native .ai files, so the safe non-switching strategy is:
 * save the current document at its real path, then copy that disk file to
 * the dejavu destination. This keeps the document name/path stable and
 * avoids the old saveAs(target) behavior that made the dejavu copy become
 * the active document.
 *
 * Unsaved documents cannot use this non-switching native-AI path because
 * there is no real document path to restore/copy from. In that case we fail
 * safely instead of silently converting the working document into an
 * dejavu file.
 *
 * @param {Document} doc Active Illustrator document.
 * @param {string} fullPath Current document path.
 * @param {File} targetFile Dejavu destination file.
 * @param {boolean} overwriteExisting Whether an existing target may be
 *     replaced.
 * @return {Object} Result object.
 */
function saveNonSwitchingDejavu(doc, fullPath, targetFile, overwriteExisting) {
    var originalFile = new File(fullPath);
    if (!originalFile.exists) {
        return {
            ok: false,
            error: "Save the document once before non-switching dejavu."
        };
    }

    try {
        doc.save();
    } catch (eSaveOriginal) {
        return {
            ok: false,
            error: "Could not save the current document before dejavu: " +
                String(eSaveOriginal.message || eSaveOriginal)
        };
    }

    if (!copyFileWithOptionalOverwrite(originalFile, targetFile, overwriteExisting)) {
        return {
            ok: false,
            error: "Could not copy the saved document to the dejavu file."
        };
    }

    return { ok: true };
}

/**
 * Copies a source layer tree into a disposable document. Only page items whose
 * direct parent is the current layer are duplicated, preventing grouped or
 * nested artwork from being copied more than once.
 * @param {Layer} sourceLayer
 * @param {Document|Layer} targetParent
 */
function copyLayerTree(sourceLayer, targetParent) {
    var targetLayer = targetParent.layers.add();
    try {
        targetLayer.name = sourceLayer.name;
    } catch (eLayerName) {
        // Keep Illustrator's generated layer name.
    }

    for (var iItem = sourceLayer.pageItems.length - 1; iItem >= 0; iItem--) {
        var item = sourceLayer.pageItems[iItem];
        try {
            if (item.parent === sourceLayer) {
                item.duplicate(targetLayer, ElementPlacement.PLACEATEND);
            }
        } catch (eDuplicateItem) {
            throw new Error(
                "Could not duplicate artwork from layer " + sourceLayer.name +
                    ": " + String(eDuplicateItem.message || eDuplicateItem)
            );
        }
    }

    for (var iLayer = sourceLayer.layers.length - 1; iLayer >= 0; iLayer--) {
        copyLayerTree(sourceLayer.layers[iLayer], targetLayer);
    }

    try {
        targetLayer.opacity = sourceLayer.opacity;
        targetLayer.visible = sourceLayer.visible;
        targetLayer.printable = sourceLayer.printable;
        targetLayer.locked = sourceLayer.locked;
    } catch (eLayerProperties) {
        // These properties vary slightly between Illustrator releases.
    }
}

/**
 * Produces an editable PDF recovery copy for a never-saved document without
 * invoking save/export/close on that working document. A new document is
 * created with matching artboards, populated from the layer tree, saved as
 * PDF, closed, and the original document is reactivated.
 *
 * @param {Document} originalDoc Never-saved working document.
 * @param {File} targetFile Final PDF recovery file.
 * @return {Object} Result object.
 */
function saveUnsavedDocumentAsPdf(originalDoc, targetFile) {
    var duplicateDoc = null;
    var duplicateCanBeClosed = false;
    var previousInteractionLevel = null;
    var countBefore = app.documents.length;

    try {
        try {
            previousInteractionLevel = app.userInteractionLevel;
            app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
        } catch (eInteractionLevel) {
            previousInteractionLevel = null;
        }

        var artboardCount = Math.max(1, originalDoc.artboards.length);
        duplicateDoc = app.documents.add(
            originalDoc.documentColorSpace,
            originalDoc.width,
            originalDoc.height,
            artboardCount
        );
        if (
            !duplicateDoc ||
            duplicateDoc === originalDoc ||
            app.documents.length <= countBefore
        ) {
            duplicateDoc = null;
            throw new Error("Illustrator did not create a distinct PDF copy.");
        }
        duplicateCanBeClosed = true;

        for (var iArtboard = 0; iArtboard < artboardCount; iArtboard++) {
            duplicateDoc.artboards[iArtboard].artboardRect =
                originalDoc.artboards[iArtboard].artboardRect;
        }

        var defaultLayer = duplicateDoc.layers.length > 0
            ? duplicateDoc.layers[0]
            : null;
        for (var iSourceLayer = originalDoc.layers.length - 1;
            iSourceLayer >= 0;
            iSourceLayer--) {
            copyLayerTree(originalDoc.layers[iSourceLayer], duplicateDoc);
        }
        if (defaultLayer && duplicateDoc.layers.length > 1) {
            try {
                defaultLayer.remove();
            } catch (eRemoveDefaultLayer) {
                // An empty default layer does not affect the PDF recovery.
            }
        }

        var pdfOptions = new PDFSaveOptions();
        pdfOptions.preserveEditability = true;
        pdfOptions.generateThumbnails = true;
        try {
            pdfOptions.compatibility = PDFCompatibility.ACROBAT7;
        } catch (ePdfCompatibility) {
            // Use the host default when ACROBAT7 is unavailable.
        }
        duplicateDoc.saveAs(targetFile, pdfOptions);
        duplicateDoc.close(SaveOptions.DONOTSAVECHANGES);
        duplicateDoc = null;
        duplicateCanBeClosed = false;
        originalDoc.activate();

        return verifyDejavuFile(targetFile);
    } catch (err) {
        if (duplicateDoc && duplicateCanBeClosed) {
            try {
                duplicateDoc.close(SaveOptions.DONOTSAVECHANGES);
            } catch (eCloseDuplicate) {
                // Continue restoring the original document.
            }
        }
        try {
            originalDoc.activate();
        } catch (eReactivateOriginal) {
            // Preserve the useful PDF creation error below.
        }
        return {
            ok: false,
            error: "Could not create PDF recovery copy: " +
                String(err.message || err)
        };
    } finally {
        if (previousInteractionLevel !== null) {
            try {
                app.userInteractionLevel = previousInteractionLevel;
            } catch (eRestoreInteractionLevel) {
                // Do not turn a successful recovery save into an error.
            }
        }
    }
}

/**
 * Renames dejavu files inside a folder so their names match the final
 * document name while preserving suffixes/time tokens where possible.
 * @param {Folder} folder Folder containing dejavu files.
 * @param {string} oldBaseName Previous document/folder base name.
 * @param {string} newBaseName Final document base name.
 */
function renameDejavuFilesInFolder(folder, oldBaseName, newBaseName) {
    var entries = folder.getFiles();
    var oldSafe = sanitizeFilesystemName(oldBaseName);
    var newSafe = sanitizeFilesystemName(newBaseName);
    var counter = 1;
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry instanceof Folder) {
            renameDejavuFilesInFolder(entry, oldSafe, newSafe);
            continue;
        }
        var originalName = String(entry.name || "");
        if (!DEJAVU_EXTENSION_PATTERN.test(originalName)) continue;
        var extension = originalName.replace(/^.*(\.[^\.]*)$/, "$1");
        var stem = originalName.replace(/\.[^\.]*$/, "");
        var newStem = stem;
        if (stem.indexOf(oldSafe) === 0) {
            newStem = newSafe + stem.slice(oldSafe.length);
        } else if (stem.indexOf(oldSafe) >= 0) {
            newStem = stem.split(oldSafe).join(newSafe);
        } else if (stem.indexOf(newSafe) !== 0) {
            newStem = newSafe + "_" + counter;
            counter++;
        }
        var target = new File(folder.fsName + "/" + newStem + extension);
        var uniqueCounter = 1;
        while (target.exists && target.fsName !== entry.fsName) {
            target = new File(folder.fsName + "/" + newStem + "_" + uniqueCounter + extension);
            uniqueCounter++;
        }
        if (target.fsName !== entry.fsName) {
            try {
                entry.rename(target.name);
            } catch (eRename) {
                // Leave the file untouched if Illustrator refuses a rename.
            }
        }
    }
}

/**
 * Moves an dejavu folder beside the final document, renames the folder
 * to the document base name, and renames dejavu files inside it.
 * @param {string} sourceFolderPath Existing temporary dejavu folder.
 * @param {string} finalFilePath Final saved document path.
 * @param {string} oldBaseName Old document/folder base name.
 * @return {string} JSON result.
 */
function dejavu_finalizeDejavuFolder(sourceFolderPath, finalFilePath, oldBaseName) {
    try {
        var source = new Folder(sourceFolderPath);
        if (!source.exists) {
            return JSON.stringify({ ok: false, error: "Dejavu folder not found." });
        }
        var finalFile = new File(finalFilePath);
        var finalParent = finalFile.parent;
        if (!finalParent || !finalParent.fsName) {
            return JSON.stringify({ ok: false, error: "Final document folder not found." });
        }
        var finalBaseName = getPathBaseName(finalFile);
        var target = new Folder(finalParent.fsName + "/" + finalBaseName);
        if (source.fsName === target.fsName) {
            renameDejavuFilesInFolder(source, oldBaseName, finalBaseName);
            return JSON.stringify({ ok: true, path: source.fsName });
        }
        if (target.exists) target = findUniqueFolder(finalParent, finalBaseName);
        if (pathIsInside(target.fsName, source.fsName)) {
            return JSON.stringify({ ok: false, error: "Destination is inside source folder." });
        }

        var sameParent = source.parent && source.parent.fsName === finalParent.fsName;
        var moved = false;
        if (sameParent) {
            try {
                moved = source.rename(target.name);
            } catch (eRenameFolder) {
                moved = false;
            }
            if (moved) target = new Folder(finalParent.fsName + "/" + target.name);
        }
        if (!moved) {
            if (!copyFolderRecursive(source, target)) {
                return JSON.stringify({ ok: false, error: "Could not move dejavu folder." });
            }
            removeFolderRecursive(source);
        }
        renameDejavuFilesInFolder(target, oldBaseName, finalBaseName);
        return JSON.stringify({ ok: true, path: target.fsName });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Saves an dejavu copy of the active document using the resolved
 * filename template. By default the active document is kept attached
 * to its real file path: Illustrator's native save is performed first
 * and that disk file is copied to the dejavu destination. This avoids
 * the old saveAs(target) behavior where the active document became the
 * dejavu file.
 *
 * Where the copy is saved:
 * - If the document already has a path on disk, the copy is saved
 *   alongside it, in that document's own containing folder — the
 *   configured default folder is ignored entirely in this case.
 * - If the document has never been saved, there is no "document's
 *   own folder" to use, so the configured default folder is
 *   required and used instead.
 *
 * - If overwriteExisting is true, repeated dejavu cycles that
 *   resolve to the same filename (e.g. a template with coarse time
 *   tokens, or no time tokens at all) overwrite that same dejavu
 *   copy each time, rather than accumulating one file per cycle.
 * - If overwriteExisting is false, the plain resolved filename is used
 *   first. A numbered suffix is appended only when that exact filename
 *   already exists, so timestamped names normally remain unchanged
 *   (`document_121232_01122025.ai`, not
 *   `document_121232_01122025_1.ai`).
 *
 * @param {string} defaultFolder Absolute folder path, used only
 *     when the document has never been saved.
 * @param {string} template Filename template, extension-less.
 * @param {boolean} overwriteExisting If true, reuse the same
 *     resolved filename across cycles instead of uniquely suffixing.
 * @return {string} JSON result.
 */
function dejavu_dejavu(
    defaultFolder,
    template,
    overwriteExisting,
    folderPerDocument,
    unsavedFolderPath,
    pendingBaseName,
    options
) {
    if (app.documents.length === 0) {
        return JSON.stringify({ ok: false, error: "No active document." });
    }

    var doc = app.activeDocument;
    var now = new Date();
    var baseName = sanitizeFilesystemName(doc.name.replace(/\.[^\.]+$/, ""));
    var originalPendingBaseName = sanitizeFilesystemName(pendingBaseName || "");
    var hostOptions = options || {};
    var folderTemplate = hostOptions.folderTemplate || "$documentFolder/$filename";
    var backupOriginal = !!hostOptions.backupOriginalBeforeDejavu;
    var currentDocumentSessionId = getDocumentSessionId(doc);
    var pendingMatchesDocument = !!(
        hostOptions.pendingDocumentSessionId &&
        hostOptions.pendingDocumentSessionId === currentDocumentSessionId
    );

    var pathInfo = getDocumentPathInfo(doc);
    var hasPath = pathInfo.hasPath;
    var ownFolderPath = pathInfo.ownFolderPath;
    var fullPath = pathInfo.fullPath;

    var pendingUnsavedFolder = pendingMatchesDocument &&
        isValidHostFolderPath(unsavedFolderPath)
        ? String(unsavedFolderPath)
        : "";
    var usingPendingUnsavedFolder = pendingUnsavedFolder &&
        pathIsInside(fullPath, pendingUnsavedFolder);

    if (usingPendingUnsavedFolder) {
        hasPath = false;
        ownFolderPath = "";
        if (originalPendingBaseName) baseName = originalPendingBaseName;
    }

    var targetFolderPath = "";
    var createdDocumentFolder = false;
    var pendingUnsaved = false;

    if (folderPerDocument) {
        if (hasPath) {
            var savedParent = new Folder(ownFolderPath);
            targetFolderPath = resolveFolderTemplate(
                folderTemplate,
                defaultFolder,
                savedParent.fsName,
                baseName
            );
        } else {
            // The chosen default folder is always the authoritative
            // root for an unsaved document. Earlier versions used
            // `pendingUnsavedFolder || defaultFolder` here, which let a
            // *remembered* per-document folder take priority over the
            // default folder. The problem: that pending value is
            // persisted in the panel's settings, so a stale one — e.g.
            // a folder on a volume that is no longer mounted, or one
            // left over from before a real default folder was chosen —
            // would keep being retried on every cycle, even after a
            // perfectly good default folder was selected. That surfaced
            // as the repeating "Could not create folder:
            // /Volumes/Untitled-1": a bare "/Untitled-1" resolved
            // against the boot volume because the remembered path could
            // not be created. Rooting at the default folder (and only
            // *reusing* a pending folder that still exists, below) means
            // a bad pending value is self-healing rather than sticky.
            var rootPath = defaultFolder;
            if (!isValidHostFolderPath(rootPath)) {
                return JSON.stringify({
                    ok: false,
                    error: "No valid default folder is set. Choose a " +
                        "default save folder for unsaved documents."
                });
            }
            var rootFolder = new Folder(rootPath);
            if (!rootFolder.fsName) {
                return JSON.stringify({
                    ok: false,
                    error: "Default folder path could not be resolved: " +
                        rootPath
                });
            }
            if (!rootFolder.exists && !rootFolder.create()) {
                return JSON.stringify({
                    ok: false,
                    error: "Could not create folder: " + rootFolder.fsName +
                        " [host " + DEJAVU_HOST_VERSION +
                        "; defaultFolder=" + String(defaultFolder) +
                        "; baseName=" + String(baseName) + "]"
                });
            }
            // Reuse the remembered per-document folder only when it
            // still exists on disk. A missing or unreachable pending
            // value (stale settings, unmounted volume, deleted folder)
            // is discarded and a fresh folder is created under the
            // current default folder instead of erroring out forever.
            var pendingFolder = pendingUnsavedFolder
                ? new Folder(pendingUnsavedFolder)
                : null;
            if (pendingFolder && pendingFolder.exists) {
                targetFolderPath = pendingFolder.fsName;
            } else {
                // The visible Illustrator names already end in a document
                // number (Untitled-1, Untitled-2). Collision folders therefore
                // continue at _2, _3, ... rather than reusing the existing
                // folder or producing the confusing Untitled-1_1.
                var uniqueFolder = findUniqueFolder(rootFolder, baseName, 2);
                targetFolderPath = uniqueFolder.fsName;
                createdDocumentFolder = true;
            }
            pendingUnsaved = true;
        }
    } else {
        // Even without per-document mode, honour the Dejavu folder
        // template — it is the definition of where dejavus are placed.
        // For a saved document $defaultFolder behaves as $documentFolder
        // (dejavu beside the file); an unsaved one uses the default.
        targetFolderPath = resolveFolderTemplate(
            templateForDocument(folderTemplate, hasPath),
            defaultFolder,
            hasPath ? ownFolderPath : defaultFolder,
            baseName
        );
    }

    // Final guard: never proceed with an empty or unresolved target
    // folder path. This is the single choke point that prevents any
    // bogus boot-volume-relative path from reaching a create/save.
    if (!isValidHostFolderPath(targetFolderPath)) {
        return JSON.stringify({
            ok: false,
            error: hasPath
                ? "Could not determine the document's own folder."
                : "No valid default folder is set. Choose a default " +
                    "save folder for unsaved documents."
        });
    }

    // Containment guard: the resolved target must live under the
    // document's own folder (saved docs) or the default folder (unsaved
    // docs). A mis-resolved folder template — e.g. one that dropped the
    // $documentFolder anchor — can otherwise yield a boot-volume path
    // like "/Volumes/Untitled-1" (a doc named Untitled-1 against an
    // empty root). When that happens, fall back to a guaranteed-safe
    // folder instead of trying to create a bogus top-level path.
    var resolvedFsName = (new Folder(targetFolderPath)).fsName;
    var containmentRoots = [];
    if (hasPath && isValidHostFolderPath(ownFolderPath)) {
        containmentRoots.push((new Folder(ownFolderPath)).fsName);
    }
    if (isValidHostFolderPath(defaultFolder)) {
        containmentRoots.push((new Folder(defaultFolder)).fsName);
    }
    if (containmentRoots.length > 0) {
        var contained = false;
        for (var cri = 0; cri < containmentRoots.length; cri++) {
            if (pathIsInside(resolvedFsName, containmentRoots[cri])) {
                contained = true;
                break;
            }
        }
        if (!contained) {
            dejavuLog(
                "Rejected out-of-bounds dejavu folder " + resolvedFsName +
                " (defaultFolder=" + String(defaultFolder) +
                ", ownFolder=" + String(ownFolderPath) +
                ", baseName=" + String(baseName) + "); falling back."
            );
            targetFolderPath = hasPath && isValidHostFolderPath(ownFolderPath)
                ? ownFolderPath
                : defaultFolder;
        }
    }

    if (!targetFolderPath) {
        return JSON.stringify({
            ok: false,
            error: "No default folder selected."
        });
    }

    try {
        var folder = new Folder(targetFolderPath);
        if (!folder.exists) {
            var created = folder.create();
            if (!created) {
                return JSON.stringify({
                    ok: false,
                    error: "Could not create folder: " + folder.fsName +
                        " [host " + DEJAVU_HOST_VERSION +
                        "; defaultFolder=" + String(defaultFolder) +
                        "; perDoc=" + String(folderPerDocument) +
                        "; hasPath=" + String(hasPath) +
                        "; baseName=" + String(baseName) +
                        "; pending=" + String(pendingUnsavedFolder) + "]"
                });
            }
        }

        var tokens = buildTokenMap(now, baseName);
        var resolvedName = resolveTemplate(template, tokens);

        // Respect the document's own file format: a .pdf dejavus as
        // .pdf, a .eps as .eps, and unknown saved formats use .ai. The
        // extension is taken from the real document path when it has
        // one, so the dejavu copy matches the file the user is
        // actually working in. Never-saved documents use a PDF created from
        // a disposable duplicate; the working document itself is untouched.
        var dejavuExtension = hasPath
            ? detectDejavuExtension(fullPath)
            : "pdf";

        var targetFile;
        if (overwriteExisting) {
            targetFile = new File(
                folder.fsName + "/" + resolvedName + "." + dejavuExtension
            );
        } else {
            targetFile = findUniqueFile(
                folder,
                resolvedName,
                dejavuExtension
            );
        }

        var backupPath = "";
        if (backupOriginal && hasPath) {
            backupPath = backupOriginalIfNeeded(fullPath, folder, baseName);
        }

        var isExport = isExportFormat(dejavuExtension);
        var saveResult;

        if (!hasPath) {
            saveResult = saveUnsavedDocumentAsPdf(doc, targetFile);
            if (!saveResult.ok) return JSON.stringify(saveResult);
        } else if (isExport) {
            // SVG (and any future exportFile-based format) is written
            // with doc.exportFile(), which does NOT switch the active
            // document to the exported file.
            //
            // exportFile auto-appends the extension, so the File handed
            // to it must NOT already end in ".svg" or the result would
            // be "name.svg.svg". We strip the extension for the call,
            // then confirm the expected final file exists.
            var exportOpts = buildExportOptionsForSvg();
            var exportBasePath = targetFile.fsName.replace(
                /\.svg$/i,
                ""
            );
            doc.exportFile(
                new File(exportBasePath),
                ExportType.SVG,
                exportOpts
            );
            var producedFile = new File(exportBasePath + ".svg");
            if (!producedFile.exists) {
                return JSON.stringify({
                    ok: false,
                    error: "SVG export did not produce the expected " +
                        "file: " + producedFile.fsName
                });
            }
            // Keep targetFile pointing at the real produced .svg so the
            // success result and logging below report the correct path.
            targetFile = producedFile;
        } else {
            // Copy the real file on disk byte for byte, so the dejavu
            // copy is already in the document's true format. The active
            // document remains attached to its original path.
            saveResult = saveNonSwitchingDejavu(
                doc,
                fullPath,
                targetFile,
                overwriteExisting
            );
            if (!saveResult.ok) {
                return JSON.stringify(saveResult);
            }
        }
        var verified = verifyDejavuFile(targetFile);
        if (!verified.ok) return JSON.stringify(verified);

        var fingerprint = fingerprintDocument(doc);
        appendManifestEntry(folder, {
            timestamp: now.getTime(),
            document: doc.name,
            sourcePath: fullPath,
            dejavuPath: targetFile.fsName,
            dejavuFormat: dejavuExtension,
            size: targetFile.length,
            backupPath: backupPath,
            fingerprint: fingerprint
        });
        dejavuLog("Dejavud " + targetFile.fsName + " (" + targetFile.length + " bytes)");

        return JSON.stringify({
            ok: true,
            path: targetFile.fsName,
            dejavuFolder: folder.fsName,
            dejavuFormat: dejavuExtension,
            createdDocumentFolder: createdDocumentFolder,
            pendingUnsavedFolder: pendingUnsaved ? folder.fsName : "",
            backupPath: backupPath,
            usedOwnFolder: hasPath,
            size: targetFile.length,
            fingerprint: fingerprint,
            timestamp: now.getTime()
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Host-side folder path validator used by dejavu state restoration.
 * @param {string} value Candidate folder path.
 * @return {boolean}
 */
function isValidHostFolderPath(value) {
    if (typeof value !== "string") return false;
    var trimmed = value.replace(/^\s+|\s+$/g, "");
    if (!trimmed) return false;
    return trimmed !== "null" && trimmed !== "undefined" &&
        trimmed !== "__CANCELLED__";
}

/**
 * Lets the user pick a default save folder via native OS dialog.
 * Returns {ok:false} on cancel (Folder.selectDialog returns null in
 * that case) — never an empty string or a sentinel value — so the
 * panel-side check only needs to handle {ok:false} plus its own
 * defensive validation of whatever string does come back.
 * @return {string} JSON with chosen path, or {ok:false} if cancelled.
 */
/**
 * Lightweight existence check for a typed folder path, used for live
 * validation of the default-folder field. Resolves "~" to the home
 * folder. Does not write anything (so it is safe to call on each
 * keystroke); writability is not probed here to avoid temp-file churn.
 * @param {string} path Candidate folder path.
 * @return {string} JSON: { ok, empty, exists, resolved }.
 */
function dejavu_checkFolder(path) {
    try {
        var p = String(path == null ? "" : path);
        if (p.replace(/^\s+|\s+$/g, "").length === 0) {
            return JSON.stringify({ ok: true, empty: true, exists: false });
        }
        var folder = new Folder(p);
        return JSON.stringify({
            ok: true,
            empty: false,
            exists: folder.exists,
            resolved: folder.fsName
        });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

function dejavu_chooseFolder(currentFolder) {
    try {
        var prompt = "Choose default dejavu folder";
        var startPath = String(currentFolder == null ? "" : currentFolder);
        var startFolder;
        // "~" / "~/..." (and an empty value) start at the user's home
        // folder; an existing absolute path starts there.
        if (startPath.charAt(0) === "~") {
            startFolder = new Folder(startPath);
        } else if (startPath.length > 0 && (new Folder(startPath)).exists) {
            startFolder = new Folder(startPath);
        } else {
            startFolder = new Folder("~");
        }
        // Re-anchor on the resolved absolute path: selectDlg seeds its
        // starting directory far more reliably from an absolute fsName
        // than from a "~"-relative or non-existent path.
        if (startFolder && startFolder.fsName) {
            var resolvedStart = new Folder(startFolder.fsName);
            if (resolvedStart.exists) startFolder = resolvedStart;
        }
        var folder = (startFolder && typeof startFolder.selectDlg === "function")
            ? startFolder.selectDlg(prompt)
            : Folder.selectDialog(prompt);
        if (!folder) {
            return JSON.stringify({ ok: false });
        }
        return JSON.stringify({ ok: true, path: folder.fsName });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Writes a text payload to a user-chosen file via the native Save
 * dialog, so the user picks both the destination folder and the file
 * name. Used by the panel's "Export settings". Returns {ok:false,
 * cancelled:true} if the user dismisses the dialog.
 * @param {string} defaultName Suggested file name (with extension).
 * @param {string} content The text to write.
 * @return {string} JSON result with the chosen path on success.
 */
function dejavu_saveTextFile(defaultName, content) {
    try {
        var safeName = String(defaultName || "dejavuai-settings.json");
        // Seed the dialog with a sensible name + starting location.
        var seed = new File(Folder.desktop.fsName + "/" + safeName);
        var file = seed.saveDlg("Export DejaVu settings");
        if (!file) {
            return JSON.stringify({ ok: false, cancelled: true });
        }
        file.encoding = "UTF-8";
        if (!file.open("w")) {
            return JSON.stringify({
                ok: false,
                error: "Could not open the chosen file for writing."
            });
        }
        file.write(String(content == null ? "" : content));
        file.close();
        return JSON.stringify({ ok: true, path: file.fsName });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Saves a copy of the active document to a user-chosen location via the
 * native Save dialog, without switching the active document. The copy
 * is made from the document's file on disk (so it requires a saved
 * document); if the document has unsaved edits, the returned `dirty`
 * flag lets the panel say the copy reflects the last saved state.
 * @return {string} JSON result with the chosen path on success.
 */
function dejavu_saveCopyToChosenLocation() {
    try {
        if (app.documents.length === 0) {
            return JSON.stringify({ ok: false, error: "No active document." });
        }
        var doc = app.activeDocument;
        var baseName = sanitizeFilesystemName(doc.name.replace(/\.[^\.]+$/, ""));
        var hasPath = false;
        var sourcePath = "";
        var ext = "ai";
        try {
            var fn = doc.fullName;
            if (fn && fn.fsName && String(fn.fsName).length > 0 &&
                fn.parent && fn.parent.fsName) {
                hasPath = true;
                sourcePath = String(fn.fsName);
                ext = detectDejavuExtension(sourcePath);
            }
        } catch (eFullName) {
            hasPath = false;
        }
        if (!hasPath) {
            return JSON.stringify({
                ok: false,
                error: "Save the document once first — a copy is made " +
                    "from the document's file on disk."
            });
        }
        var src = new File(sourcePath);
        if (!src.exists) {
            return JSON.stringify({
                ok: false,
                error: "The document's file was not found on disk."
            });
        }
        var seedFolder = src.parent || Folder.desktop;
        var seed = new File(
            seedFolder.fsName + "/" + baseName + "_copy." + ext
        );
        var chosen = seed.saveDlg("Save a copy of the document");
        if (!chosen) {
            return JSON.stringify({ ok: false, cancelled: true });
        }
        if (!src.copy(chosen.fsName)) {
            return JSON.stringify({
                ok: false,
                error: "Could not write the copy to the chosen location."
            });
        }
        var dirty = false;
        try {
            dirty = (doc.saved === false);
        } catch (eDirty) {
            dirty = false;
        }
        dejavuLog("Saved a copy to " + chosen.fsName +
            (dirty ? " (from last saved state)" : ""));
        return JSON.stringify({ ok: true, path: chosen.fsName, dirty: dirty });
    } catch (err) {
        return JSON.stringify({ ok: false, error: String(err.message || err) });
    }
}

/**
 * Reads Illustrator's uiBrightness preference for theme detection.
 * @return {string} JSON result with brightness value (0-4 integer or 0.0-1.0 float).
 */
function dejavu_getUiBrightness() {
    try {
        if (!app || !app.preferences) {
            return JSON.stringify({
                ok: false,
                brightness: null,
                source: "no-preferences"
            });
        }
        var brightness = app.preferences.getRealPreference("uiBrightness");
        return JSON.stringify({
            ok: true,
            brightness: brightness,
            source: "illustrator-uiBrightness"
        });
    } catch (err) {
        return JSON.stringify({
            ok: false,
            brightness: null,
            source: "error",
            error: String(err.message || err)
        });
    }
}
