function SVGSim_bridgeVersion() {
    return 4;
}

function SVGSim_escapeJSONString(value) {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/\"/g, "\\\"")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/\f/g, "\\f")
        .replace(/\x08/g, "\\b");
}

function SVGSim_jsonStringify(value) {
    if (typeof JSON !== "undefined" && JSON && JSON.stringify) {
        try { return JSON.stringify(value); } catch (ignoredJSON) {}
    }

    if (value === null) return "null";

    var t = typeof value;

    if (t === "string") {
        return "\"" + SVGSim_escapeJSONString(value) + "\"";
    }

    if (t === "number") {
        return isFinite(value) ? String(value) : "null";
    }

    if (t === "boolean") {
        return value ? "true" : "false";
    }

    if (value instanceof Date) {
        return "\"" + SVGSim_escapeJSONString(value.toUTCString()) + "\"";
    }

    if (value && value.constructor === Array) {
        var arrayParts = [];
        for (var i = 0; i < value.length; i++) {
            var item = SVGSim_jsonStringify(value[i]);
            arrayParts.push(item === undefined ? "null" : item);
        }
        return "[" + arrayParts.join(",") + "]";
    }

    if (t === "object") {
        var objectParts = [];
        for (var key in value) {
            if (value.hasOwnProperty(key)) {
                var child = SVGSim_jsonStringify(value[key]);
                if (child !== undefined) {
                    objectParts.push(
                        "\"" + SVGSim_escapeJSONString(key) + "\":" + child
                    );
                }
            }
        }
        return "{" + objectParts.join(",") + "}";
    }

    return undefined;
}

function SVGSim_jsonParse(text) {
    if (typeof JSON !== "undefined" && JSON && JSON.parse) {
        try { return JSON.parse(text); } catch (ignoredJSONParse) {}
    }

    return eval("(" + String(text) + ")");
}

function SVGSim_jsonOK(payload) {
    return SVGSim_jsonStringify(payload);
}

function SVGSim_jsonError(error) {
    return SVGSim_jsonStringify({ ok: false, error: String(error) });
}


function SVGSim_documentToken(doc) {
    try { return doc && doc.fullName ? String(doc.fullName.fsName) : String(doc && doc.name ? doc.name : ""); } catch (ignored) {}
    try { return String(doc && doc.name ? doc.name : ""); } catch (ignored2) {}
    return "";
}

function SVGSim_restoreOriginalDocument(originalDoc, originalToken) {
    try {
        if (!originalDoc) return;
        var currentToken = SVGSim_documentToken(originalDoc);
        if (currentToken === originalToken && typeof originalDoc.activate === "function") {
            originalDoc.activate();
        }
    } catch (ignored) {}
}

function SVGSim_closeDocumentNoSave(doc) {
    try {
        if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
    } catch (ignored) {}
}

// Return an already-open document whose path matches, or null. Used so the
// scan never re-opens (and then closes) a file the user already has open.
function SVGSim_findOpenDocByPath(path) {
    try {
        if (!path || !app.documents.length) return null;
        for (var i = 0; i < app.documents.length; i += 1) {
            var d = app.documents[i];
            if (String(SVGSim_documentToken(d)) === String(path)) return d;
        }
    } catch (ignored) {}
    return null;
}

// Snapshot of the currently-open documents (by path token), so any document
// that appears afterwards can be identified and closed.
function SVGSim_openDocTokens() {
    var tokens = {};
    try {
        for (var i = 0; i < app.documents.length; i += 1) {
            tokens[String(SVGSim_documentToken(app.documents[i]))] = true;
        }
    } catch (ignored) {}
    return tokens;
}

// Close any document that was NOT in the given snapshot — e.g. the exported
// temp SVG if Illustrator opened it as a side effect of exportFile(). Never
// closes the document matching keepToken (the user's original).
function SVGSim_closeStrayDocuments(knownTokens, keepToken) {
    try {
        for (var i = app.documents.length - 1; i >= 0; i -= 1) {
            var d = app.documents[i];
            var t = String(SVGSim_documentToken(d));
            if (t === String(keepToken)) continue;
            if (!knownTokens[t]) SVGSim_closeDocumentNoSave(d);
        }
    } catch (ignored) {}
}

function SVGSim_withRecentFilesSuppressed(work) {
    var key = "Application/RecentFileCount";
    var originalCount = null;
    var shouldRestore = false;

    try {
        if (app.preferences &&
                app.preferences.getIntegerPreference &&
                app.preferences.setIntegerPreference) {
            originalCount = app.preferences.getIntegerPreference(key);
            app.preferences.setIntegerPreference(key, 0);
            shouldRestore = true;
        }
    } catch (ignoredPreference) {
        shouldRestore = false;
    }

    try {
        return work();
    } finally {
        if (shouldRestore) {
            try {
                app.preferences.setIntegerPreference(key, originalCount);
            } catch (ignoredRestore) {}
        }
    }
}

function SVGSim_openFileSilently(fileRefOrPath) {
    return SVGSim_withRecentFilesSuppressed(function () {
        var fileRef = fileRefOrPath;
        if (!fileRef || !fileRef.exists) fileRef = new File(fileRefOrPath);
        if (fileRef.exists) return app.open(fileRef);
        return null;
    });
}

function SVGSim_removeFile(path) {
    try {
        if (!path) return false;
        var file = new File(path);
        if (file.exists) return file.remove();
    } catch (ignored) {}
    return false;
}

function SVGSim_tempSVGFile(prefix) {
    var folder = Folder.temp;
    return new File(folder.fsName + "/" + prefix + "_" + new Date().getTime() + "_" + Math.round(Math.random() * 1000000000) + ".svg");
}

function SVGSim_exportOptions() {
    // Minimal, defensive options. We only need geometry for fingerprinting,
    // so raster embedding is OFF — embedding fails ("An unknown error
    // occurred") whenever a placed image is linked/missing. Each property is
    // guarded so an unsupported one on a given Illustrator version can't break
    // the whole export.
    var options = new ExportOptionsSVG();
    try { options.embedRasterImages = false; } catch (e1) {}
    try { options.fontSubsetting = SVGFontSubsetting.None; } catch (e2) {}
    try { options.coordinatePrecision = 3; } catch (e3) {}
    try { options.cssProperties = SVGCSSPropertyLocation.STYLEATTRIBUTES; } catch (e4) {}
    try { options.preserveEditability = false; } catch (e5) {}
    return options;
}

function SVGSim_exportDocumentToFile(doc, outFile) {
    // Suppress the modal "unknown error" dialog so a failure never blocks the
    // scan, and try our tuned options first, then fall back to stock defaults
    // (option-specific failures are the most common cause of export errors).
    var prev = null;
    try { prev = app.userInteractionLevel; } catch (eGet) {}
    try {
        try {
            app.userInteractionLevel =
                UserInteractionLevel.DONTDISPLAYALERTS;
        } catch (eSet) {}
        try {
            doc.exportFile(outFile, ExportType.SVG, SVGSim_exportOptions());
        } catch (eFirst) {
            try { if (outFile.exists) outFile.remove(); } catch (eRm) {}
            doc.exportFile(outFile, ExportType.SVG, new ExportOptionsSVG());
        }
    } finally {
        if (prev !== null) {
            try { app.userInteractionLevel = prev; } catch (eRestore) {}
        }
    }
    return outFile.fsName;
}

function SVGSim_exportCurrentDocumentAsTempSVG() {
    var previousInteraction = app.userInteractionLevel;
    var originalDoc = null;
    var originalToken = "";
    var out = null;
    var known = null;

    try {
        if (!app.documents.length) return "ERROR: No active document.";
        originalDoc = app.activeDocument;
        originalToken = SVGSim_documentToken(originalDoc);
        known = SVGSim_openDocTokens();
        out = SVGSim_tempSVGFile("svgsim_current");
        SVGSim_exportDocumentToFile(originalDoc, out);
        // Defensive: some Illustrator setups open the exported file as a new
        // tab. Close anything that appeared, keeping the user's original.
        SVGSim_closeStrayDocuments(known, originalToken);
        SVGSim_restoreOriginalDocument(originalDoc, originalToken);
        app.userInteractionLevel = previousInteraction;
        return out.fsName;
    } catch (error) {
        try { SVGSim_closeStrayDocuments(known || {}, originalToken); } catch (ignoredStray) {}
        try { SVGSim_restoreOriginalDocument(originalDoc, originalToken); } catch (ignoredRestore) {}
        try { app.userInteractionLevel = previousInteraction; } catch (ignoredInteraction) {}
        try { if (out && out.exists) out.remove(); } catch (ignoredRemove) {}
        return "ERROR: Current-document SVG export failed: " + error;
    }
}

function SVGSim_convertFileToTempSVG(filePath) {
    var previousInteraction = app.userInteractionLevel;
    var originalDoc = null;
    var originalToken = "";
    var out = null;
    var known = null;

    try {
        if (app.documents.length) {
            originalDoc = app.activeDocument;
            originalToken = SVGSim_documentToken(originalDoc);
        }

        var input = new File(filePath);
        if (!input.exists) return "ERROR: File not found: " + filePath;

        // Snapshot the open set up front. Anything not in it afterwards (the
        // file we open to convert, plus any temp the export side-opens) is
        // closed at the end; documents already open — including the user's —
        // are in the snapshot and are never touched.
        known = SVGSim_openDocTokens();

        var alreadyOpen = SVGSim_findOpenDocByPath(input.fsName);
        if (alreadyOpen) {
            out = SVGSim_tempSVGFile("svgsim_convert");
            SVGSim_exportDocumentToFile(alreadyOpen, out);
            SVGSim_closeStrayDocuments(known, originalToken);
            SVGSim_restoreOriginalDocument(originalDoc, originalToken);
            app.userInteractionLevel = previousInteraction;
            return out.fsName;
        }

        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
        SVGSim_openFileSilently(input);
        var doc = SVGSim_findOpenDocByPath(input.fsName) || app.activeDocument;
        if (!doc) return "ERROR: Could not open file: " + filePath;
        out = SVGSim_tempSVGFile("svgsim_convert");
        SVGSim_exportDocumentToFile(doc, out);
        SVGSim_closeStrayDocuments(known, originalToken);
        SVGSim_restoreOriginalDocument(originalDoc, originalToken);
        app.userInteractionLevel = previousInteraction;
        return out.fsName;
    } catch (error) {
        try { SVGSim_closeStrayDocuments(known || {}, originalToken); } catch (ignoredStray) {}
        try { SVGSim_restoreOriginalDocument(originalDoc, originalToken); } catch (ignoredRestore) {}
        try { app.userInteractionLevel = previousInteraction; } catch (ignoredInteraction) {}
        try { if (out && out.exists) out.remove(); } catch (ignoredRemove) {}
        return "ERROR: " + error;
    }
}

function SVGSim_batchConvertFilesToTempSVG(jsonPaths) {
    try {
        var paths = SVGSim_jsonParse(jsonPaths);
        var results = [];
        for (var i = 0; i < paths.length; i++) {
            results.push({ path: paths[i], svg: SVGSim_convertFileToTempSVG(paths[i]) });
        }
        return SVGSim_jsonStringify(results);
    } catch (error) {
        return "ERROR: " + error;
    }
}

function SVGSim_cleanupTempFile(filePath) {
    return SVGSim_jsonStringify({ ok: true, removed: SVGSim_removeFile(filePath), path: filePath });
}

function SVGSim_getCurrentDocumentInfo() {
    try {
        if (!app.documents.length) {
            return SVGSim_jsonStringify({ ok: false, error: "No active document." });
        }
        var doc = app.activeDocument;
        var path = null;
        var folder = null;
        var name = doc.name || "Untitled";
        var exists = false;
        var sizeBytes = null;
        var modifiedAt = null;
        var mtimeMs = null;

        try {
            if (doc.fullName) {
                var file = new File(doc.fullName);
                path = file.fsName;
                exists = file.exists;
                if (file.parent) {
                    folder = file.parent.fsName;
                }
                if (file.exists) {
                    try { sizeBytes = file.length; } catch (ignoredLength) {}
                    try {
                        modifiedAt = file.modified ? file.modified.toUTCString() : null;
                        mtimeMs = file.modified ? file.modified.getTime() : null;
                    } catch (ignoredModified) {}
                }
            }
        } catch (unsavedError) {
            path = null;
            folder = null;
        }

        return SVGSim_jsonStringify({
            ok: true,
            name: name,
            path: path,
            folder: folder,
            exists: exists,
            sizeBytes: sizeBytes,
            modifiedAt: modifiedAt,
            mtimeMs: mtimeMs,
            saved: !!path
        });
    } catch (error) {
        return SVGSim_jsonError(error);
    }
}

function SVGSim_exportCurrentDocumentAsTempSVGWithInfo() {
    try {
        var infoText = SVGSim_getCurrentDocumentInfo();
        var svgPath = SVGSim_exportCurrentDocumentAsTempSVG();
        if (!svgPath || String(svgPath).indexOf("ERROR:") === 0) {
            return SVGSim_jsonStringify({ ok: false, error: svgPath || "Illustrator SVG export failed." });
        }
        var info = SVGSim_jsonParse(infoText);
        info.ok = true;
        info.tempSVGPath = svgPath;
        return SVGSim_jsonStringify(info);
    } catch (error) {
        return SVGSim_jsonError(error);
    }
}
