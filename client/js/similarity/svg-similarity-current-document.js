(function (global) {
  "use strict";

  function SVGSimilarityCurrentDocument() {}

  SVGSimilarityCurrentDocument._cepBridgeReadyPromise = null;
  SVGSimilarityCurrentDocument.BRIDGE_VERSION = 2;

  SVGSimilarityCurrentDocument.hasCEPBridge = function hasCEPBridge() {
    return !!(
      (typeof global.CSInterface !== "undefined") ||
      (global.__adobe_cep__ && typeof global.__adobe_cep__.evalScript === "function")
    );
  };

  SVGSimilarityCurrentDocument.createCEPInterface = function createCEPInterface() {
    if (typeof global.CSInterface !== "undefined") {
      return new global.CSInterface();
    }
    if (global.__adobe_cep__ && typeof global.__adobe_cep__.evalScript === "function") {
      return {
        evalScript: function evalScript(script, callback) {
          global.__adobe_cep__.evalScript(script, callback || function () {});
        },
        getSystemPath: function getSystemPath(pathType) {
          if (global.__adobe_cep__ && typeof global.__adobe_cep__.getSystemPath === "function") {
            return global.__adobe_cep__.getSystemPath(pathType);
          }
          return "";
        }
      };
    }
    return null;
  };

  SVGSimilarityCurrentDocument.evalCEPRaw = function evalCEPRaw(script) {
    return new Promise(function (resolve, reject) {
      var cs = SVGSimilarityCurrentDocument.createCEPInterface();
      if (!cs || typeof cs.evalScript !== "function") {
        reject(new Error(
          "CEP bridge is not available. Include lib/CSInterface.js or run inside a CEP panel with window.__adobe_cep__."
        ));
        return;
      }
      try {
        cs.evalScript(script, function (result) {
          resolve(result == null ? "" : String(result));
        });
      } catch (error) {
        reject(error);
      }
    });
  };

  SVGSimilarityCurrentDocument.evalCEP = function evalCEP(script) {
    return SVGSimilarityCurrentDocument.ensureCEPBridgeLoaded().then(function () {
      return SVGSimilarityCurrentDocument.evalCEPRaw(script);
    });
  };

  SVGSimilarityCurrentDocument.getExtensionPath = function getExtensionPath() {
    var cs = SVGSimilarityCurrentDocument.createCEPInterface();
    var path = "";

    try {
      if (cs && typeof cs.getSystemPath === "function") {
        path = cs.getSystemPath("extension") || cs.getSystemPath("EXTENSION") || "";
      }
    } catch (ignored) {}

    if (!path && global.location && global.location.protocol === "file:") {
      try {
        var decoded = decodeURI(global.location.pathname || "");
        var slash = decoded.lastIndexOf("/");
        if (slash >= 0) path = decoded.slice(0, slash);
        if (/\/example$/.test(path) || /\\example$/.test(path) || /\/uxp$/.test(path) || /\\uxp$/.test(path)) {
          path = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
        }
      } catch (ignored2) {}
    }

    return path;
  };

  SVGSimilarityCurrentDocument.escapeExtendScriptString = function escapeExtendScriptString(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  };

  SVGSimilarityCurrentDocument.bridgeFileExists = function bridgeFileExists() {
    var required = SVGSimilarityCurrentDocument.BRIDGE_VERSION || 1;
    return SVGSimilarityCurrentDocument.evalCEPRaw("typeof SVGSim_getCurrentDocumentInfo + '|' + (typeof SVGSim_bridgeVersion === 'function' ? SVGSim_bridgeVersion() : 0)").then(function (result) {
      var parts = String(result).trim().split("|");
      return parts[0] === "function" && Number(parts[1] || 0) >= required;
    }).catch(function () { return false; });
  };

  SVGSimilarityCurrentDocument.ensureCEPBridgeLoaded = function ensureCEPBridgeLoaded() {
    if (!SVGSimilarityCurrentDocument.hasCEPBridge()) {
      return Promise.reject(new Error("CEP bridge is not available."));
    }

    if (SVGSimilarityCurrentDocument._cepBridgeReadyPromise) {
      return SVGSimilarityCurrentDocument._cepBridgeReadyPromise;
    }

    SVGSimilarityCurrentDocument._cepBridgeReadyPromise = SVGSimilarityCurrentDocument.bridgeFileExists().then(function (exists) {
      if (exists) return true;

      var extensionPath = SVGSimilarityCurrentDocument.getExtensionPath();
      if (!extensionPath) {
        throw new Error("Could not locate the CEP extension folder to load jsx/svg_similarity_bridge.jsx.");
      }

      var jsxPath = extensionPath.replace(/[\\\/]$/, "") + "/jsx/svg_similarity_bridge.jsx";
      var escaped = SVGSimilarityCurrentDocument.escapeExtendScriptString(jsxPath);
      var script = "$.evalFile(new File(\"" + escaped + "\")); typeof SVGSim_getCurrentDocumentInfo + '|' + (typeof SVGSim_bridgeVersion === 'function' ? SVGSim_bridgeVersion() : 0)";

      return SVGSimilarityCurrentDocument.evalCEPRaw(script).then(function (result) {
        var parts = String(result).trim().split("|");
        if (parts[0] !== "function" || Number(parts[1] || 0) < SVGSimilarityCurrentDocument.BRIDGE_VERSION) {
          throw new Error("Could not load Illustrator JSX bridge from: " + jsxPath + ". Result: " + result);
        }
        return true;
      });
    }).catch(function (error) {
      SVGSimilarityCurrentDocument._cepBridgeReadyPromise = null;
      throw error;
    });

    return SVGSimilarityCurrentDocument._cepBridgeReadyPromise;
  };

  SVGSimilarityCurrentDocument.parseBridgeJSON = function parseBridgeJSON(result, context) {
    var text = String(result == null ? "" : result).replace(/^\uFEFF/, "").trim();

    if (!text) {
      throw new Error((context || "Illustrator bridge") + " returned an empty response.");
    }

    if (text.indexOf("ERROR:") === 0 || text.indexOf("EvalScript error") === 0) {
      throw new Error((context || "Illustrator bridge") + " failed: " + text);
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(
        (context || "Illustrator bridge") + " returned non-JSON text: " +
        text.slice(0, 240) +
        (text.length > 240 ? "…" : "")
      );
    }
  };

  SVGSimilarityCurrentDocument.exportSVG = function exportSVG(adapter, options) {
    return SVGSimilarityCurrentDocument.exportSVGWithMeta(adapter, options || {}).then(function (payload) {
      return payload.svgText || payload;
    });
  };

  SVGSimilarityCurrentDocument.exportSVGWithMeta = function exportSVGWithMeta(adapter, options) {
    if (adapter && typeof adapter.exportCurrentDocumentSVGWithMeta === "function") {
      return adapter.exportCurrentDocumentSVGWithMeta(options || {});
    }
    if (SVGSimilarityCurrentDocument.hasCEPBridge()) {
      return SVGSimilarityCurrentDocument.exportCEPWithMeta();
    }
    return SVGSimilarityCurrentDocument.exportUXPWithMeta(options || {});
  };

  SVGSimilarityCurrentDocument.exportCEP = function exportCEP() {
    return SVGSimilarityCurrentDocument.exportCEPWithMeta().then(function (payload) {
      return payload.svgText;
    });
  };

  SVGSimilarityCurrentDocument.getCurrentDocumentInfo = function getCurrentDocumentInfo(adapter) {
    if (adapter && typeof adapter.getCurrentDocumentInfo === "function") {
      return adapter.getCurrentDocumentInfo();
    }
    if (SVGSimilarityCurrentDocument.hasCEPBridge()) {
      return SVGSimilarityCurrentDocument.getCEPDocumentInfo();
    }
    return SVGSimilarityCurrentDocument.getUXPDocumentInfo();
  };

  SVGSimilarityCurrentDocument.getCEPDocumentInfo = function getCEPDocumentInfo() {
    return SVGSimilarityCurrentDocument.evalCEP("SVGSim_getCurrentDocumentInfo()").then(function (result) {
      var info = SVGSimilarityCurrentDocument.parseBridgeJSON(result, "SVGSim_getCurrentDocumentInfo");
      if (!info.ok) throw new Error(info.error || "Could not read current document information.");
      return info;
    });
  };

  SVGSimilarityCurrentDocument.exportCEPWithMeta = function exportCEPWithMeta() {
    return SVGSimilarityCurrentDocument.evalCEP("SVGSim_exportCurrentDocumentAsTempSVGWithInfo()").then(function (result) {
      var info = SVGSimilarityCurrentDocument.parseBridgeJSON(result, "SVGSim_exportCurrentDocumentAsTempSVGWithInfo");
      if (!info.ok || !info.tempSVGPath) {
        throw new Error(info.error || "Illustrator SVG export failed.");
      }
      if (typeof require !== "function") {
        throw new Error("CEP exported the SVG, but Node require/fs is unavailable. Enable --enable-nodejs in manifest.xml.");
      }
      var fs = require("fs");
      try {
        info.svgText = fs.readFileSync(info.tempSVGPath, "utf8");
      } finally {
        try { if (info.tempSVGPath && fs.existsSync(info.tempSVGPath)) fs.unlinkSync(info.tempSVGPath); } catch (ignoredUnlink) {}
        try {
          var escaped = String(info.tempSVGPath || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
          SVGSimilarityCurrentDocument.evalCEP("SVGSim_cleanupTempFile(\"" + escaped + "\")");
        } catch (ignoredBridgeCleanup) {}
      }
      info.sourcePath = info.path || null;
      info.tempSVGPath = null;
      return info;
    });
  };

  SVGSimilarityCurrentDocument.pickTargetFileFallback = function pickTargetFileFallback(adapter) {
    if (adapter && typeof adapter.pickTargetVectorFile === "function") {
      return adapter.pickTargetVectorFile();
    }
    return Promise.reject(new Error(
      "Current document export is unavailable in this host. Pick/export a target SVG manually, or run the CEP panel with the JSX bridge loaded."
    ));
  };

  SVGSimilarityCurrentDocument.exportUXP = function exportUXP(options) {
    var opts = options || {};

    if (
      global.SVGSimilarityUXPHost &&
      typeof global.SVGSimilarityUXPHost.exportCurrentDocumentSVG === "function"
    ) {
      return Promise.resolve(global.SVGSimilarityUXPHost.exportCurrentDocumentSVG(opts));
    }

    return SVGSimilarityCurrentDocument.tryIllustratorUXPDOM(opts).catch(function () {
      return Promise.reject(
        new Error(
          "Direct current-document SVG export is not exposed by this UXP host. " +
          "Provide window.SVGSimilarityUXPHost.exportCurrentDocumentSVG(), use the CEP bridge, " +
          "or pick/export a target SVG/AI/PDF/EPS file manually."
        )
      );
    });
  };

  SVGSimilarityCurrentDocument.tryIllustratorUXPDOM = function tryIllustratorUXPDOM() {
    return new Promise(function (resolve, reject) {
      var uxp, storage, illustrator, app, doc;

      try {
        uxp = require("uxp");
        storage = uxp.storage && uxp.storage.localFileSystem;
      } catch (error) {
        reject(error);
        return;
      }

      try {
        illustrator = require("illustrator");
        app = illustrator.app || illustrator.Application || illustrator;
        doc = app.activeDocument ||
          (app.documents && app.documents.length ? app.documents[0] : null);
      } catch (error2) {
        reject(error2);
        return;
      }

      if (!doc || typeof doc.exportFile !== "function") {
        reject(new Error("Illustrator UXP DOM exportFile() is unavailable."));
        return;
      }

      if (!storage || typeof storage.getTemporaryFolder !== "function") {
        reject(new Error("UXP temporary folder API is unavailable."));
        return;
      }

      storage.getTemporaryFolder().then(function (folder) {
        var name = "svgsim_current_" + Date.now() + ".svg";
        return folder.createFile(name, { overwrite: true });
      }).then(function (entry) {
        var maybe = doc.exportFile(entry, "svg", {
          embedRasterImages: true,
          coordinatePrecision: 5,
          preserveEditability: false,
          responsive: false
        });
        return Promise.resolve(maybe).then(function () { return entry; });
      }).then(function (entry) {
        return entry.read({ format: uxp.storage.formats.utf8 }).then(function (text) {
          try { if (entry && typeof entry.delete === "function") entry.delete(); } catch (ignoredDelete) {}
          return text;
        }, function (error) {
          try { if (entry && typeof entry.delete === "function") entry.delete(); } catch (ignoredDelete2) {}
          throw error;
        });
      }).then(resolve, reject);
    });
  };

  SVGSimilarityCurrentDocument.getUXPDocumentInfo = function getUXPDocumentInfo() {
    if (global.SVGSimilarityUXPHost && typeof global.SVGSimilarityUXPHost.getCurrentDocumentInfo === "function") {
      return Promise.resolve(global.SVGSimilarityUXPHost.getCurrentDocumentInfo());
    }
    return new Promise(function (resolve, reject) {
      try {
        var illustrator = require("illustrator");
        var app = illustrator.app || illustrator.Application || illustrator;
        var doc = app.activeDocument || (app.documents && app.documents.length ? app.documents[0] : null);
        if (!doc) { reject(new Error("No active document.")); return; }
        var path = doc.fullName || doc.path || doc.filePath || null;
        var folder = null;
        if (path) {
          var normalized = String(path);
          var slash = normalized.lastIndexOf("/");
          var backslash = normalized.lastIndexOf("\\");
          var idx = Math.max(slash, backslash);
          folder = idx >= 0 ? normalized.slice(0, idx) : null;
        }
        resolve({ ok: true, name: doc.name || "Current document", path: path, folder: folder, saved: !!path });
      } catch (error) {
        reject(error);
      }
    });
  };

  SVGSimilarityCurrentDocument.exportUXPWithMeta = function exportUXPWithMeta(options) {
    return SVGSimilarityCurrentDocument.exportUXP(options || {}).then(function (svgText) {
      return SVGSimilarityCurrentDocument.getUXPDocumentInfo().catch(function () { return {}; }).then(function (info) {
        info = info || {};
        info.svgText = svgText;
        return info;
      });
    });
  };

  global.SVGSimilarityCurrentDocument = SVGSimilarityCurrentDocument;
})(this);
