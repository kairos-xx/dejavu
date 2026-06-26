/*
 * DejaVu — UXP host runtime.
 *
 * This file exposes the dejavu_* API surface on window.DejaVuHost so
 * client code can call Illustrator through the UXP runtime.
 */
const log = false;
(() => {
    "use strict";

    if (typeof console !== "undefined" && console.log && log) {
        console.log("[DejaVu host] host.js starting to load");
    }

    if (typeof window !== "undefined" &&
            typeof window.__adobe_cep__ !== "undefined") {
        return;
    }

    const DEJAVU_HOST_VERSION = "2026.06.25-r32";
    const sessionRefs = [];
    const sessionIds = [];
    const openedDejavuSessionIds = new Set();
    let sessionSequence = 0;

    const ok = (data = {}) => ({ ok: true, ...data });
    const fail = (error, data = {}) => ({
        ok: false,
        error: error && error.message ? error.message : String(error),
        ...data
    });

    const requireModule = (name) => {
        if (typeof require !== "function") return null;
        try {
            return require(name);
        } catch (error) {
            return null;
        }
    };

    const uxp = requireModule("uxp");
    const illustrator = requireModule("illustrator") || requireModule("application");
    const storage = uxp && uxp.storage ? uxp.storage.localFileSystem : null;
    const shell = uxp && uxp.shell ? uxp.shell : null;
    const app = illustrator && illustrator.app ? illustrator.app : illustrator;

    const nativePath = (entry) => {
        if (!entry) return "";
        try {
            if (storage && typeof storage.getNativePath === "function") {
                return storage.getNativePath(entry);
            }
        } catch (error) {}
        return entry.nativePath || entry.fullName || entry.name || "";
    };

    const fileUrlFromPath = (value) => {
        const text = String(value || "");
        if (/^[a-z]+:/i.test(text)) return text;
        return `file:${text}`;
    };

    const entryFromPath = async (path) => {
        if (!storage || typeof storage.getEntryWithUrl !== "function") {
            throw new Error("UXP localFileSystem.getEntryWithUrl is unavailable.");
        }
        return storage.getEntryWithUrl(fileUrlFromPath(path));
    };

    const createFileFromPath = async (path, overwrite = true) => {
        if (!storage || typeof storage.createEntryWithUrl !== "function") {
            throw new Error("UXP localFileSystem.createEntryWithUrl is unavailable.");
        }
        return storage.createEntryWithUrl(fileUrlFromPath(path), { overwrite });
    };

    const createFolderFromPath = async (path) => {
        if (!storage || typeof storage.createEntryWithUrl !== "function") {
            throw new Error("UXP localFileSystem.createEntryWithUrl is unavailable.");
        }
        if (uxp && uxp.storage && uxp.storage.types) {
            return storage.createEntryWithUrl(fileUrlFromPath(path), {
                type: uxp.storage.types.folder
            });
        }
        return storage.createEntryWithUrl(fileUrlFromPath(path), { type: "folder" });
    };

    const pathParts = (value) => String(value || "").replace(/\\/g, "/").split("/");
    const baseName = (value) => pathParts(value).pop() || "Untitled";
    const dirName = (value) => pathParts(value).slice(0, -1).join("/") || "/";
    const extName = (value) => {
        const name = baseName(value);
        const dot = name.lastIndexOf(".");
        return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    };
    const stemName = (value) => {
        const name = baseName(value);
        const dot = name.lastIndexOf(".");
        return dot >= 0 ? name.slice(0, dot) : name;
    };

    const pad2 = (value) => (value < 10 ? `0${value}` : String(value));

    const buildTokenMap = (date, name) => ({
        "$filename": stemName(name || "Untitled"),
        "$name": stemName(name || "Untitled"),
        "$ext": extName(name || "ai") || "ai",
        "$yyyy": String(date.getFullYear()),
        "$yy": String(date.getFullYear()).slice(-2),
        "$month": pad2(date.getMonth() + 1),
        "$mmonth": pad2(date.getMonth() + 1),
        "$dd": pad2(date.getDate()),
        "$hh": pad2(date.getHours()),
        "$mm": pad2(date.getMinutes()),
        "$ss": pad2(date.getSeconds()),
        "$timestamp": String(date.getTime()),
        "$dejavus": "Dejavus"
    });

    const resolveTemplate = (template, tokens) => Object.keys(tokens).reduce(
        (value, token) => value.split(token).join(tokens[token]),
        String(template || "$filename_$hh$mm$ss")
    );

    const getDocuments = () => {
        if (!app || !app.documents) return [];
        const docs = app.documents;
        if (Array.isArray(docs)) return docs;
        if (typeof docs.length === "number") {
            return Array.from({ length: docs.length }, (_, index) => docs[index]);
        }
        if (typeof docs.forEach === "function") {
            const result = [];
            docs.forEach((doc) => result.push(doc));
            return result;
        }
        return [];
    };

    const getActiveDocument = () => {
        if (!app) throw new Error("Illustrator UXP app object is unavailable.");
        const docs = getDocuments();
        if (docs.length === 0) throw new Error("No open document.");
        return app.activeDocument || docs[0];
    };

    const getDocumentPath = (doc) => {
        const path = doc.fullName || doc.path || doc.filePath || doc.savedPath || "";
        if (typeof path === "string") return path;
        return nativePath(path);
    };

    const getDocumentName = (doc) => doc.name || doc.title || baseName(getDocumentPath(doc)) || "Untitled";

    const getDocumentSessionId = (doc) => {
        const existing = sessionRefs.indexOf(doc);
        if (existing >= 0) return sessionIds[existing];
        sessionSequence += 1;
        const id = `doc-${Date.now()}-${sessionSequence}`;
        sessionRefs.push(doc);
        sessionIds.push(id);
        return id;
    };

    const fpHashText = (hash, value) => {
        const text = String(value === undefined || value === null ? "" : value);
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash + text.charCodeAt(i)) & 0x7fffffff;
        }
        return hash;
    };

    const fpSampleText = (value) => {
        const text = String(value || "");
        if (text.length <= 384) return text;
        const middle = Math.max(0, Math.floor(text.length / 2) - 64);
        return text.slice(0, 128) + text.slice(middle, middle + 128) +
            text.slice(-128) + "#" + text.length;
    };

    const fpColor = (color) => {
        if (!color) return "";
        const values = [];
        try { values.push(color.typename || "Color"); } catch (eType) {}
        const channels = [
            "red", "green", "blue", "cyan", "magenta", "yellow", "black",
            "gray", "tint"
        ];
        for (let i = 0; i < channels.length; i++) {
            try {
                if (color[channels[i]] !== undefined) {
                    values.push(channels[i] + ":" +
                        Math.round(Number(color[channels[i]]) * 100));
                }
            } catch (eCh) {}
        }
        return values.join(",");
    };

    const collLen = (coll) => {
        try {
            return (coll && typeof coll.length === "number") ? coll.length : 0;
        } catch (e) {
            return 0;
        }
    };

    // Content fingerprint ported from the CEP host (host.jsx) so "only save
    // when changed" behaves the same on both runtimes (B-08). Hashes
    // structural counts plus sampled geometry, path points, text contents and
    // page-item properties, so move/recolor/text edits aren't silently
    // treated as "unchanged". Fully defensive: if a UXP DOM property is
    // unavailable it degrades to the counts portion rather than throwing.
    const fingerprintDocument = (doc) => {
        const parts = [];
        let hash = 5381;
        try {
            const pathItems = doc.pathItems;
            const pathCount = collLen(pathItems);
            parts.push("layers:" + collLen(doc.layers));
            parts.push("items:" + collLen(doc.pageItems));
            parts.push("paths:" + pathCount);
            parts.push("groups:" + collLen(doc.groupItems));
            parts.push("compounds:" + collLen(doc.compoundPathItems));
            parts.push("text:" + collLen(doc.textFrames));
            parts.push("rasters:" + collLen(doc.rasterItems));
            parts.push("placed:" + collLen(doc.placedItems));
            parts.push("symbols:" + collLen(doc.symbolItems));
            parts.push("swatches:" + collLen(doc.swatches));
            try { parts.push("artboards:" + collLen(doc.artboards)); } catch (eAb) {}

            const sampleCount = Math.min(pathCount, 40);
            let coordAccum = 0;
            for (let i = 0; i < sampleCount; i++) {
                try {
                    const pi = pathItems[i];
                    const bounds = pi.geometricBounds;
                    for (let b = 0; b < bounds.length; b++) {
                        coordAccum += Math.round(bounds[b] * 100);
                    }
                    hash = fpHashText(hash,
                        "p:" + pi.closed + ":" + pi.filled + ":" + pi.stroked +
                        ":" + Math.round(Number(pi.strokeWidth || 0) * 100) +
                        ":" + fpColor(pi.fillColor) +
                        ":" + fpColor(pi.strokeColor));
                    const pointCount = Math.min(collLen(pi.pathPoints), 12);
                    for (let p = 0; p < pointCount; p++) {
                        const point = pi.pathPoints[p];
                        hash = fpHashText(hash,
                            point.anchor.join(",") + ":" +
                            point.leftDirection.join(",") + ":" +
                            point.rightDirection.join(","));
                    }
                } catch (eBounds) {}
            }
            parts.push("coord:" + coordAccum);

            const textFrames = doc.textFrames;
            const textCount = Math.min(collLen(textFrames), 60);
            for (let t = 0; t < textCount; t++) {
                try {
                    hash = fpHashText(hash,
                        "t:" + fpSampleText(textFrames[t].contents));
                } catch (eText) {}
            }

            const pageItems = doc.pageItems;
            const itemCount = Math.min(collLen(pageItems), 80);
            for (let j = 0; j < itemCount; j++) {
                try {
                    const item = pageItems[j];
                    hash = fpHashText(hash,
                        "i:" + item.typename + ":" + (item.name || "") + ":" +
                        (item.note || "") + ":" +
                        Math.round(Number(item.opacity || 0) * 100) + ":" +
                        item.hidden + ":" + item.locked + ":" +
                        item.geometricBounds.join(","));
                } catch (eItem) {}
            }
            parts.push("content:" + hash);
        } catch (e) {
            parts.push("err:" + (e && e.message ? e.message : e));
        }
        return parts.join("|");
    };

    const documentInfo = (doc, includeFingerprint = false) => {
        const fullPath = getDocumentPath(doc);
        const hasPath = !!fullPath;
        const sessionId = getDocumentSessionId(doc);
        const docName = getDocumentName(doc);
        return {
            // hasDoc/docName mirror the CEP contract (host.jsx
            // dejavu_getActiveDocInfo); the client gates on exactly these
            // (advanced.js), so they must be present for dejavu to run.
            hasDoc: true,
            docName,
            documentSessionId: sessionId,
            name: docName,
            hasPath,
            fullPath,
            folderPath: hasPath ? dirName(fullPath) : "",
            baseName: stemName(docName),
            extension: hasPath ? extName(fullPath) : "ai",
            dejavuFormat: hasPath ? extName(fullPath) || "ai" : "pdf",
            saved: !!doc.saved,
            openedDejavu: openedDejavuSessionIds.has(sessionId),
            fingerprint: includeFingerprint ? fingerprintDocument(doc) : ""
        };
    };

    const fileModifiedTime = async (path) => {
        if (!path) return 0;
        try {
            const entry = await entryFromPath(path);
            if (entry && typeof entry.getMetadata === "function") {
                const metadata = await entry.getMetadata();
                const modified = metadata && (
                    metadata.modified ||
                    metadata.dateModified ||
                    metadata.modificationDate ||
                    metadata.mtime
                );
                const time = modified && typeof modified.getTime === "function"
                    ? modified.getTime()
                    : Number(new Date(modified).getTime()) || Number(modified) || 0;
                return time > 100000000000 ? time : 0;
            }
        } catch (error) {}
        return 0;
    };

    const documentInfoWithDiskTime = async (doc, includeFingerprint = false) => {
        const info = documentInfo(doc, includeFingerprint);
        const diskModified = info.hasPath
            ? await fileModifiedTime(info.fullPath)
            : 0;
        return {
            ...info,
            diskModified,
            modified: diskModified
        };
    };

    const pathExists = async (path) => {
        try {
            const entry = await entryFromPath(path);
            return ok({ exists: true, path: nativePath(entry) || String(path || "") });
        } catch (error) {
            return ok({ exists: false, path: String(path || "") });
        }
    };

    const readFileBytes = async (entry) => {
        if (!entry || typeof entry.read !== "function") return null;
        const formats = uxp && uxp.storage ? uxp.storage.formats : null;
        if (formats && formats.binary) return entry.read({ format: formats.binary });
        return entry.read();
    };

    const copyPath = async (sourcePath, targetPath, overwrite = true) => {
        const source = await entryFromPath(sourcePath);
        const target = await createFileFromPath(targetPath, overwrite);
        const data = await readFileBytes(source);
        await target.write(data);
        return target;
    };

    const saveDocumentToEntry = async (doc, entry, extension) => {
        if (extension === "svg" && typeof doc.exportFile === "function") {
            return doc.exportFile(entry);
        }
        if (typeof doc.saveACopy === "function") return doc.saveACopy(entry);
        if (typeof doc.saveAs === "function") return doc.saveAs(entry);
        if (typeof doc.save === "function") {
            await doc.save();
            const sourcePath = getDocumentPath(doc);
            if (sourcePath) return copyPath(sourcePath, nativePath(entry), true);
        }
        throw new Error("This Illustrator UXP DOM does not expose save/saveAs/saveACopy.");
    };

    const dejavu_getHostVersion = async () => ok({ version: DEJAVU_HOST_VERSION, runtime: "uxp" });

    const dejavu_getUiBrightness = async () => {
        try {
            if (!app || !app.preferences) {
                return ok({ brightness: null, source: "no-preferences" });
            }
            const getter = app.preferences.getRealPreference;
            if (typeof getter !== "function") {
                return ok({ brightness: null, source: "no-getter" });
            }
            const brightness = getter.call(app.preferences, "uiBrightness");
            return ok({ brightness, source: "illustrator-uiBrightness" });
        } catch (error) {
            return fail(error, { brightness: null, source: "error" });
        }
    };

    const dejavu_pathExists = async (path) => pathExists(path);

    const dejavu_getFileSize = async (path) => {
        try {
            const entry = await entryFromPath(path);
            let size = 0;
            if (typeof entry.getMetadata === "function") {
                const metadata = await entry.getMetadata();
                size = metadata.size || 0;
            } else {
                const data = await readFileBytes(entry);
                size = data && data.byteLength ? data.byteLength : 0;
            }
            return ok({ size });
        } catch (error) {
            return fail(error);
        }
    };

    const dejavu_getActiveDocInfo = async (includeFingerprint) => {
        try {
            // Match CEP: no open document is a normal state, not an error.
            if (getDocuments().length === 0) {
                return ok({ hasDoc: false });
            }
            return ok(await documentInfoWithDiskTime(
                getActiveDocument(),
                !!includeFingerprint
            ));
        } catch (error) {
            return fail(error, { hasDoc: false });
        }
    };

    const dejavu_listOpenDocuments = async () => {
        try {
            const active = app && app.activeDocument;
            const documents = await Promise.all(getDocuments().map(async (doc) => ({
                ...(await documentInfoWithDiskTime(doc, false)),
                isActive: doc === active
            })));
            return ok({ documents });
        } catch (error) {
            return fail(error, { documents: [] });
        }
    };

    const dejavu_activateDocument = async (sessionId) => {
        try {
            const index = sessionIds.indexOf(String(sessionId));
            if (index < 0) return fail("Document session not found.");
            if (app) app.activeDocument = sessionRefs[index];
            return ok(await documentInfoWithDiskTime(sessionRefs[index], false));
        } catch (error) {
            return fail(error);
        }
    };

    const dejavu_checkFolder = async (path) => {
        try {
            const entry = await entryFromPath(path);
            return ok({ exists: true, path: nativePath(entry), writable: true });
        } catch (error) {
            try {
                const entry = await createFolderFromPath(path);
                return ok({ exists: true, path: nativePath(entry), writable: true });
            } catch (createError) {
                return fail(createError, { exists: false, writable: false });
            }
        }
    };

    const dejavu_chooseFolder = async () => {
        try {
            if (!storage || typeof storage.getFolder !== "function") {
                throw new Error("UXP folder picker is unavailable.");
            }
            const folder = await storage.getFolder();
            return ok({ path: nativePath(folder), folder: nativePath(folder) });
        } catch (error) {
            return ok({ cancelled: true, path: "__CANCELLED__" });
        }
    };

    // Signature mirrors the client call (advanced.js) and CEP host.jsx:
    // (defaultFolder, filenameTemplate, overwriteExisting, folderPerDocument,
    //  unsavedFolderPath, unsavedBaseName, folderTemplate, options).
    // The previous order put booleans where templates were expected, which
    // corrupted folder/filename resolution on UXP (B-03).
    const dejavu_dejavu = async (
        defaultFolder,
        filenameTemplate,
        overwriteExisting,
        folderPerDocument,
        unsavedFolderPath,
        unsavedBaseName,
        folderTemplate,
        options
    ) => {
        try {
            const doc = getActiveDocument();
            const info = documentInfo(doc, true);
            const date = new Date();
            // Saved documents dejavu beside their own file; unsaved ones
            // use the remembered/default folder.
            const folderRoot = info.hasPath
                ? info.folderPath
                : String(unsavedFolderPath || defaultFolder || "");
            if (!folderRoot) {
                return fail("Choose a default folder before autosaving unsaved documents.");
            }
            const nameForTokens = (!info.hasPath && unsavedBaseName)
                ? unsavedBaseName
                : info.name;
            const folderPath = folderTemplate
                ? resolveTemplate(folderTemplate, {
                    ...buildTokenMap(date, nameForTokens),
                    "$defaultFolder": folderRoot,
                    "$documentFolder": info.folderPath || folderRoot
                })
                : folderRoot;
            await createFolderFromPath(folderPath);
            const extension = info.dejavuFormat || "ai";
            const fileName = `${resolveTemplate(filenameTemplate, buildTokenMap(date, nameForTokens))}.${extension}`;
            const fullPath = `${folderPath.replace(/[\\/]$/, "")}/${fileName}`;
            const target = await createFileFromPath(fullPath, !!overwriteExisting);
            await saveDocumentToEntry(doc, target, extension);
            let size = 0;
            try {
                if (typeof target.getMetadata === "function") {
                    const meta = await target.getMetadata();
                    size = (meta && meta.size) || 0;
                }
            } catch (eSize) {}
            return ok({
                path: nativePath(target) || fullPath,
                fullPath: nativePath(target) || fullPath,
                name: fileName,
                folderPath,
                document: info.name,
                documentSessionId: info.documentSessionId,
                fingerprint: fingerprintDocument(doc),
                size,
                modified: Date.now(),
                savedAt: Date.now(),
                format: extension,
                runtime: "uxp"
            });
        } catch (error) {
            return fail(error);
        }
    };

    const dejavu_listDejavus = async (defaultFolder) => {
        try {
            const entry = await entryFromPath(defaultFolder);
            const entries = typeof entry.getEntries === "function"
                ? await entry.getEntries()
                : [];
            const files = await Promise.all(entries
                .filter((child) => !child.isFolder)
                .map(async (child) => {
                    let size = 0;
                    let modified = 0;
                    try {
                        if (typeof child.getMetadata === "function") {
                            const meta = await child.getMetadata();
                            size = (meta && meta.size) || 0;
                            const m = meta && (meta.dateModified ||
                                meta.modified || meta.modificationDate);
                            modified = m && typeof m.getTime === "function"
                                ? m.getTime()
                                : Number(new Date(m).getTime()) || 0;
                        }
                    } catch (eMeta) {}
                    return {
                        name: child.name,
                        path: nativePath(child),
                        size,
                        modified,
                        exists: true,
                        format: extName(child.name)
                    };
                }));
            const totalBytes = files.reduce(
                (sum, item) => sum + (Number(item.size) || 0),
                0
            );
            return ok({
                files,
                dejavus: files,
                folder: nativePath(entry),
                folderPath: nativePath(entry),
                stats: {
                    totalBytes,
                    missingCount: 0,
                    existingCount: files.length,
                    manifestCount: 0
                }
            });
        } catch (error) {
            return fail(error, { files: [], dejavus: [] });
        }
    };

    const dejavu_revealPath = async (path) => {
        try {
            if (shell && typeof shell.openPath === "function") await shell.openPath(path);
            else if (shell && typeof shell.openExternal === "function") await shell.openExternal(fileUrlFromPath(path));
            return ok({ path });
        } catch (error) {
            return fail(error);
        }
    };

    const dejavu_getDiskSpaceInfo = async (path) => {
        try {
            let target = String(path || "").trim();
            if (!target) return fail("No path provided.");
            if (target.charAt(0) === "~") {
                try {
                    const os = requireModule("os");
                    if (os && typeof os.homedir === "function") {
                        target = os.homedir() + target.slice(1);
                    }
                } catch {}
            }

            try {
                const fs = requireModule("fs");
                if (fs && typeof fs.statfsSync === "function") {
                    const stats = fs.statfsSync(target);
                    const blockSize = Number(stats.bsize || stats.frsize || 0);
                    const freeBlocks = Number(stats.bavail || stats.bfree || 0);
                    const totalBlocks = Number(stats.blocks || 0);
                    if (blockSize > 0 && totalBlocks > 0) {
                        return ok({
                            freeBytes: freeBlocks * blockSize,
                            totalBytes: totalBlocks * blockSize,
                        });
                    }
                }
            } catch {}

            try {
                const cp = requireModule("child_process");
                if (cp && typeof cp.execFile === "function") {
                    const isWin = typeof process !== "undefined" &&
                        process.platform === "win32";
                    if (isWin) {
                        const drive = target.match(/^[a-z]:/i);
                        if (!drive) {
                            return fail("Cannot determine Windows drive.");
                        }
                        return await new Promise((resolve) => {
                            cp.execFile(
                                "powershell.exe",
                                [
                                    "-NoProfile",
                                    "-Command",
                                    `$d = Get-PSDrive ${drive[0].charAt(0)}; "$(($d.Free)),$($d.Free + $d.Used)"`,
                                ],
                                (err, stdout) => {
                                    if (err) {
                                        resolve(fail(err));
                                        return;
                                    }
                                    const parts = String(stdout || "").trim().split(",");
                                    resolve(ok({
                                        freeBytes: Number(parts[0]) || 0,
                                        totalBytes: Number(parts[1]) || 0,
                                    }));
                                }
                            );
                        });
                    }
                    return await new Promise((resolve) => {
                        cp.execFile("df", ["-k", target], (err, stdout) => {
                            if (err) {
                                resolve(fail(err));
                                return;
                            }
                            const lines = String(stdout || "").trim().split(/\r?\n/);
                            const parts = (lines[lines.length - 1] || "").split(/\s+/);
                            const totalKb = Number(parts[1]) || 0;
                            const freeKb = Number(parts[3]) || 0;
                            resolve(ok({
                                freeBytes: freeKb * 1024,
                                totalBytes: totalKb * 1024,
                            }));
                        });
                    });
                }
            } catch {}

            return fail("Could not determine disk space.");
        } catch (error) {
            return fail(error);
        }
    };

    const dejavu_openPath = async (path) => {
        try {
            const entry = await entryFromPath(path);
            const doc = app && typeof app.open === "function"
                ? await app.open(entry)
                : null;
            if (doc) openedDejavuSessionIds.add(getDocumentSessionId(doc));
            return ok({ path, openedDejavu: !!doc });
        } catch (error) {
            return fail(error);
        }
    };

    const dejavu_deletePath = async (path) => {
        try {
            const entry = await entryFromPath(path);
            if (typeof entry.delete === "function") await entry.delete();
            else throw new Error("UXP Entry.delete is unavailable.");
            return ok({ path });
        } catch (error) {
            return fail(error);
        }
    };

    const dejavu_duplicateRecovery = async (path) => {
        try {
            const duplicatePath = `${dirName(path)}/${stemName(path)}_copy.${extName(path)}`;
            const target = await copyPath(path, duplicatePath, false);
            return ok({ path: nativePath(target) || duplicatePath });
        } catch (error) {
            return fail(error);
        }
    };

    const dejavu_saveTextFile = async (defaultName, content) => {
        try {
            if (!storage || typeof storage.getFileForSaving !== "function") {
                throw new Error("UXP save dialog is unavailable.");
            }
            const file = await storage.getFileForSaving(defaultName || "dejavuai.txt");
            await file.write(String(content || ""));
            return ok({ path: nativePath(file) });
        } catch (error) {
            return fail(error);
        }
    };

    const unsupported = async (name) => fail(`${name} is not fully available in the UXP host yet.`);


    const dejavu_openExternalUrl = async (url) => {
        if (shell && typeof shell.openExternal === "function") {
            await shell.openExternal(String(url || ""));
            return ok();
        }
        if (typeof window !== "undefined" && typeof window.open === "function") {
            window.open(String(url || ""), "_blank");
            return ok();
        }
        return fail("No UXP shell.openExternal or window.open is available.");
    };
    const api = {
        dejavu_getHostVersion,
        dejavu_getUiBrightness,
        dejavu_openExternalUrl,
        dejavu_pathExists,
        dejavu_getFileSize,
        dejavu_getActiveDocInfo,
        dejavu_listOpenDocuments,
        dejavu_activateDocument,
        dejavu_checkFolder,
        dejavu_chooseFolder,
        dejavu_dejavu,
        dejavu_listDejavus,
        dejavu_revealPath,
        dejavu_getDiskSpaceInfo,
        dejavu_openPath,
        dejavu_deletePath,
        dejavu_duplicateRecovery,
        dejavu_saveTextFile,
        dejavu_getLogPath: async () => ok({ path: "UXP console" }),
        dejavu_getInstallSignature: async () => ok({ signature: DEJAVU_HOST_VERSION }),
        dejavu_removeManifestEntry: async () => ok({}),
        dejavu_healthCheck: async (
            defaultFolder,
            folderPerDocument,
            unsavedFolderPath
        ) => {
            try {
                if (getDocuments().length === 0) {
                    return fail("No active document.");
                }
                const info = documentInfo(getActiveDocument(), false);
                const folderRoot = info.hasPath
                    ? info.folderPath
                    : String(unsavedFolderPath || defaultFolder || "");
                let folderExists = false;
                let folderWritable = false;
                let resolvedFolder = folderRoot;
                if (folderRoot) {
                    const check = await dejavu_checkFolder(folderRoot);
                    folderExists = !!(check && check.exists);
                    folderWritable = !!(check && check.writable);
                    if (check && check.path) resolvedFolder = check.path;
                }
                let fileCount = 0;
                let folderBytes = 0;
                try {
                    const listed = await dejavu_listDejavus(resolvedFolder);
                    const files = listed && listed.ok && Array.isArray(listed.files)
                        ? listed.files
                        : [];
                    fileCount = files.length;
                    folderBytes = files.reduce(
                        (sum, item) => sum + (Number(item.size) || 0),
                        0
                    );
                } catch {}
                return ok({
                    document: info.docName,
                    hasPath: info.hasPath,
                    format: info.dejavuFormat || "ai",
                    folder: resolvedFolder,
                    folderExists,
                    folderWritable,
                    fileCount,
                    folderBytes,
                    nonSwitchingRecommended: info.hasPath,
                    runtime: "uxp",
                    version: DEJAVU_HOST_VERSION
                });
            } catch (error) {
                return fail(error);
            }
        },
        dejavu_cleanupDejavus: async (...args) => unsupported("dejavu_cleanupDejavus"),
        dejavu_getRecoveryWarning: async (...args) => unsupported("dejavu_getRecoveryWarning"),
        dejavu_finalizeDejavuFolder: async (...args) => unsupported("dejavu_finalizeDejavuFolder"),
        dejavu_saveCopyToChosenLocation: async (...args) => unsupported("dejavu_saveCopyToChosenLocation")
    };

    if (typeof window !== "undefined") {
        window.DejaVuHost = api;
        if (typeof console !== "undefined" && console.log && log) {
            console.log("[DejaVu host] DejaVuHost set on window");
        }
    } else {
        if (typeof console !== "undefined" && console.log && log) {
            console.log("[DejaVu host] window is undefined");
        }
    }
})();
