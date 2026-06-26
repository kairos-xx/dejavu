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
    var options = new ExportOptionsSVG();
    options.embedRasterImages = true;
    options.fontSubsetting = SVGFontSubsetting.None;
    options.documentEncoding = SVGDocumentEncoding.UTF8;
    options.coordinatePrecision = 5;
    options.cssProperties = SVGCSSPropertyLocation.STYLEATTRIBUTES;
    options.preserveEditability = false;
    try { options.responsive = false; } catch (ignored) {}
    return options;
}

function SVGSim_exportDocumentToFile(doc, outFile) {
    doc.exportFile(outFile, ExportType.SVG, SVGSim_exportOptions());
    return outFile.fsName;
}

function SVGSim_exportCurrentDocumentAsTempSVG() {
    try {
        if (!app.documents.length) return "ERROR: No active document.";
        return SVGSim_exportDocumentToFile(app.activeDocument, SVGSim_tempSVGFile("svgsim_current"));
    } catch (error) {
        return "ERROR: " + error;
    }
}

function SVGSim_convertFileToTempSVG(filePath) {
    var previousInteraction = app.userInteractionLevel;
    var originalDoc = null;
    var originalToken = "";
    var opened = null;
    var out = null;

    try {
        if (app.documents.length) {
            originalDoc = app.activeDocument;
            originalToken = SVGSim_documentToken(originalDoc);
        }

        var input = new File(filePath);
        if (!input.exists) return "ERROR: File not found: " + filePath;

        if (originalDoc && originalToken && String(input.fsName) === String(originalToken)) {
            out = SVGSim_tempSVGFile("svgsim_convert_current");
            SVGSim_exportDocumentToFile(originalDoc, out);
            SVGSim_restoreOriginalDocument(originalDoc, originalToken);
            return out.fsName;
        }

        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
        opened = app.open(input);
        out = SVGSim_tempSVGFile("svgsim_convert");
        SVGSim_exportDocumentToFile(opened, out);
        SVGSim_closeDocumentNoSave(opened);
        opened = null;
        SVGSim_restoreOriginalDocument(originalDoc, originalToken);
        app.userInteractionLevel = previousInteraction;
        return out.fsName;
    } catch (error) {
        try { SVGSim_closeDocumentNoSave(opened); } catch (ignoredClose) {}
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
