(function (global) {
  "use strict";

  function extOf(path) {
    var m = String(path || "").toLowerCase().match(/\.[^.\\/]+$/);
    return m ? m[0] : "";
  }

  function Pool(limit) { this.limit = Math.max(1, limit || 1); this.active = 0; this.queue = []; }
  Pool.prototype.run = function run(task) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.queue.push({ task: task, resolve: resolve, reject: reject });
      self.next();
    });
  };
  Pool.prototype.next = function next() {
    var self = this;
    if (self.active >= self.limit || !self.queue.length) return;
    var item = self.queue.shift();
    self.active += 1;
    Promise.resolve().then(item.task).then(item.resolve, item.reject).then(function () { self.active -= 1; self.next(); });
  };

  function SVGSimilarityBrowserAdapter(config) { this.config = config || {}; }
  SVGSimilarityBrowserAdapter.prototype.listFiles = function listFiles() { return Promise.resolve([]); };
  SVGSimilarityBrowserAdapter.prototype.readText = function readText() { return Promise.reject(new Error("Browser adapter cannot read arbitrary disk paths.")); };
  SVGSimilarityBrowserAdapter.prototype.normalizeToSVG = function normalizeToSVG(file) { return Promise.resolve({ svgText: file.svgText || "", format: "svg", converted: false }); };

  function SVGSimilarityCEPAdapter(config) {
    this.config = config || {};
    this.fs = require("fs");
    this.path = require("path");
    this.os = require("os");
    this.zlib = require("zlib");
    this.childProcess = require("child_process");
    this.external = (((this.config || {}).index || {}).externalConverters) || {};
    this._lastConversionPlan = [];
  }

  SVGSimilarityCEPAdapter.prototype.deleteFileQuietly = function deleteFileQuietly(filePath) {
    if (!filePath) return false;
    try {
      if (this.fs.existsSync(filePath)) {
        this.fs.unlinkSync(filePath);
        return true;
      }
    } catch (ignored) {}
    return false;
  };

  SVGSimilarityCEPAdapter.prototype.cleanupIllustratorTempFile = function cleanupIllustratorTempFile(filePath) {
    if (!filePath) return Promise.resolve(false);
    if (global.SVGSimilarityCurrentDocument && SVGSimilarityCurrentDocument.hasCEPBridge()) {
      var escaped = String(filePath).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
      return SVGSimilarityCurrentDocument.evalCEP('SVGSim_cleanupTempFile("' + escaped + '")')
        .then(function () { return true; })
        .catch(function () { return false; });
    }
    return Promise.resolve(false);
  };

  SVGSimilarityCEPAdapter.prototype.readTextAndDelete = function readTextAndDelete(filePath) {
    var text = this.fs.readFileSync(filePath, "utf8");
    this.deleteFileQuietly(filePath);
    return text;
  };


  SVGSimilarityCEPAdapter.prototype.listFiles = function listFiles(folderPath, options) {
    var cfg = (this.config.index || {}), recursive = options && options.recursive != null ? options.recursive : cfg.recursive !== false;
    var allowed = (cfg.allowedExtensions || [".svg"]).map(function (x) { return x.toLowerCase(); });
    var skip = {}; (cfg.skipFolders || []).forEach(function (x) { skip[x] = true; }); skip.__MACOSX = true;
    var out = [], self = this;
    function walk(dir) {
      var entries;
      try { entries = self.fs.readdirSync(dir); } catch (e) { return; }
      for (var i = 0; i < entries.length; i += 1) {
        var name = entries[i], full = self.path.join(dir, name), st;
        if (!name || name.charAt(0) === "." || name.indexOf("._") === 0) continue;
        try { st = self.fs.statSync(full); } catch (e2) { continue; }
        if (st.isDirectory()) { if (recursive && !skip[name]) walk(full); continue; }
        if (!st.isFile()) continue;
        if (allowed.indexOf(extOf(name)) !== -1) out.push({ path: full, name: name, size: st.size, mtimeMs: st.mtimeMs, ext: extOf(name) });
      }
    }
    walk(folderPath);
    return Promise.resolve(out);
  };

  SVGSimilarityCEPAdapter.prototype.readText = function readText(filePath) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.fs.readFile(filePath, function (err, data) {
        if (err) { reject(err); return; }
        if (extOf(filePath) === ".svgz") {
          self.zlib.gunzip(data, function (zerr, unzipped) { if (zerr) reject(zerr); else resolve(unzipped.toString("utf8")); });
        } else resolve(data.toString("utf8"));
      });
    });
  };

  SVGSimilarityCEPAdapter.prototype.normalizeToSVG = function normalizeToSVG(file) {
    var filePath = typeof file === "string" ? file : file.path;
    var ext = extOf(filePath), self = this;
    if (ext === ".svg" || ext === ".svgz") return self.readText(filePath).then(function (svgText) { return { svgText: svgText, format: ext.slice(1), converted: false, sourcePath: filePath }; });
    return self.convertVectorFileToSVG(filePath).then(function (svgText) { return { svgText: svgText, format: ext.slice(1), converted: true, sourcePath: filePath, conversionPlan: self._lastConversionPlan ? self._lastConversionPlan.slice() : [] }; });
  };

  SVGSimilarityCEPAdapter.prototype.readHeader = function readHeader(filePath, maxBytes) {
    try {
      var fd = this.fs.openSync(filePath, "r");
      var size = Math.max(64, maxBytes || 4096);
      var buffer = Buffer.alloc(size);
      var read = this.fs.readSync(fd, buffer, 0, size, 0);
      this.fs.closeSync(fd);
      return buffer.slice(0, read).toString("binary");
    } catch (ignored) {
      return "";
    }
  };

  SVGSimilarityCEPAdapter.prototype.isPDFLikeFile = function isPDFLikeFile(filePath) {
    var header = this.readHeader(filePath, 8192);
    return header.indexOf("%PDF-") !== -1;
  };

  SVGSimilarityCEPAdapter.prototype.extractEmbeddedSVGText = function extractEmbeddedSVGText(filePath) {
    var ext = extOf(filePath);
    var stat;
    try { stat = this.fs.statSync(filePath); } catch (ignored) { return Promise.reject(new Error("Cannot stat file.")); }
    if (stat.size > 25 * 1024 * 1024) {
      return Promise.reject(new Error("Skipped embedded SVG scan for large file."));
    }
    return this.readText(filePath).then(function (text) {
      var start = text.indexOf("<svg");
      var end = text.lastIndexOf("</svg>");
      if (start === -1 || end === -1 || end <= start) {
        throw new Error("No embedded SVG XML found in " + ext + ".");
      }
      return text.slice(start, end + 6);
    });
  };

  SVGSimilarityCEPAdapter.prototype.resolveConversionPlan = function resolveConversionPlan(filePath) {
    var ext = extOf(filePath);
    var external = this.external || {};
    var prefer = external.prefer || ["embeddedSVG", "mutool", "inkscape", "ghostscript", "illustrator"];
    var enabled = external.enabled !== false;
    var allowIllustrator = external.allowIllustratorFallback !== false;
    var avoidIllustrator = external.avoidIllustrator === true;
    var pdfLike = ext === ".pdf" || this.isPDFLikeFile(filePath);
    var supported = {};

    supported.embeddedSVG = true;
    supported.inkscape = enabled;
    supported.mutool = enabled && (pdfLike || ext === ".ai");
    supported.ghostscript = enabled && (pdfLike || ext === ".eps" || ext === ".ai");
    supported.illustrator = allowIllustrator && !avoidIllustrator;

    if (ext === ".eps") {
      supported.mutool = enabled && external.tryMutoolForEPS === true;
    }

    var out = [];
    for (var i = 0; i < prefer.length; i += 1) {
      var name = prefer[i];
      if (name === "auto") continue;
      if (supported[name] && out.indexOf(name) === -1) out.push(name);
    }

    if (out.length === 0 || prefer.indexOf("auto") !== -1) {
      var auto = ["embeddedSVG"];
      if (pdfLike) auto = auto.concat(["mutool", "inkscape", "ghostscript"]);
      else if (ext === ".eps") auto = auto.concat(["inkscape", "ghostscript"]);
      else if (ext === ".ai") auto = auto.concat(["inkscape"]);
      if (supported.illustrator) auto.push("illustrator");
      for (var j = 0; j < auto.length; j += 1) {
        if (supported[auto[j]] && out.indexOf(auto[j]) === -1) out.push(auto[j]);
      }
    }

    if (supported.illustrator && out.indexOf("illustrator") === -1) {
      out.push("illustrator");
    }

    this._lastConversionPlan = out.slice();
    return out;
  };

  SVGSimilarityCEPAdapter.prototype.convertVectorFileToSVG = function convertVectorFileToSVG(filePath) {
    var self = this;
    var plan = this.resolveConversionPlan(filePath);
    var errors = [];
    var chain = Promise.reject(new Error("No converter attempted."));
    plan.forEach(function (name) {
      chain = chain.catch(function (previous) {
        if (previous && previous.message !== "No converter attempted.") {
          errors.push(previous.message || String(previous));
        }
        if (name === "embeddedSVG") return self.extractEmbeddedSVGText(filePath);
        if (name === "mutool") return self.convertWithMutool(filePath);
        if (name === "inkscape") return self.convertWithInkscape(filePath);
        if (name === "ghostscript") return self.convertWithGhostscript(filePath);
        if (name === "illustrator") return self.convertWithIllustrator(filePath);
        return Promise.reject(new Error("Unknown converter: " + name));
      });
    });
    return chain.catch(function (error) {
      errors.push(error && error.message ? error.message : String(error));
      throw new Error("Could not normalize " + filePath + " to SVG. Tried: " + plan.join(", ") + ". Errors: " + errors.join(" | "));
    });
  };

  SVGSimilarityCEPAdapter.prototype.convertWithIllustrator = function convertWithIllustrator(filePath) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!global.SVGSimilarityCurrentDocument || !SVGSimilarityCurrentDocument.hasCEPBridge()) {
        reject(new Error("CEP bridge unavailable for Illustrator conversion."));
        return;
      }
      var escaped = String(filePath).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
      SVGSimilarityCurrentDocument.evalCEP('SVGSim_convertFileToTempSVG("' + escaped + '")').then(function (result) {
        var tempPath = String(result || "").trim();
        if (!tempPath || tempPath.indexOf("ERROR:") === 0) {
          reject(new Error(tempPath || "Illustrator conversion failed."));
          return;
        }
        try {
          var text = self.readTextAndDelete(tempPath);
          self.cleanupIllustratorTempFile(tempPath);
          resolve(text);
        } catch (e) {
          self.deleteFileQuietly(tempPath);
          self.cleanupIllustratorTempFile(tempPath);
          reject(e);
        }
      }, reject);
    });
  };

  SVGSimilarityCEPAdapter.prototype.tempSVGPath = function tempSVGPath(prefix) {
    return this.path.join(this.os.tmpdir(), (prefix || "svgsim") + "_" + Date.now() + "_" + Math.round(Math.random() * 1e9) + ".svg");
  };
  SVGSimilarityCEPAdapter.prototype.execFile = function execFile(cmd, args) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.childProcess.execFile(cmd, args, { timeout: 120000 }, function (err, stdout, stderr) { if (err) reject(new Error((stderr || stdout || err.message || String(err)).trim())); else resolve(stdout); });
    });
  };
  SVGSimilarityCEPAdapter.prototype.convertWithInkscape = function convertWithInkscape(filePath) {
    var out = this.tempSVGPath("inkscape"), cmd = this.external.inkscapePath || "inkscape", self = this;
    return this.execFile(cmd, [filePath, "--export-type=svg", "--export-filename=" + out])
      .then(function () { return self.readTextAndDelete(out); }, function (error) { self.deleteFileQuietly(out); throw error; });
  };
  SVGSimilarityCEPAdapter.prototype.convertWithMutool = function convertWithMutool(filePath) {
    var out = this.tempSVGPath("mutool");
    var cmd = this.external.mutoolPath || "mutool";
    var self = this;
    function readOut() {
      if (!self.fs.existsSync(out)) {
        throw new Error("MuPDF did not create SVG output.");
      }
      return self.readTextAndDelete(out);
    }
    return this.execFile(cmd, ["draw", "-o", out, filePath, "1"])
      .then(readOut, function (firstError) {
        self.deleteFileQuietly(out);
        return self.execFile(cmd, ["convert", "-o", out, filePath])
          .then(readOut, function (secondError) {
            self.deleteFileQuietly(out);
            throw new Error("MuPDF failed: " + (firstError.message || firstError) + " / " + (secondError.message || secondError));
          });
      });
  };
  SVGSimilarityCEPAdapter.prototype.convertWithGhostscript = function convertWithGhostscript(filePath) {
    var out = this.tempSVGPath("gs"), cmd = this.external.ghostscriptPath || "gs", self = this;
    return this.execFile(cmd, ["-dBATCH", "-dNOPAUSE", "-sDEVICE=svg", "-sOutputFile=" + out, filePath])
      .then(function () { return self.readTextAndDelete(out); }, function (error) { self.deleteFileQuietly(out); throw error; });
  };




  SVGSimilarityCEPAdapter.prototype.exportCurrentDocumentSVG = function exportCurrentDocumentSVG() {
    return SVGSimilarityCurrentDocument.exportCEP();
  };

  SVGSimilarityCEPAdapter.prototype.exportCurrentDocumentSVGWithMeta = function exportCurrentDocumentSVGWithMeta() {
    return SVGSimilarityCurrentDocument.exportCEPWithMeta();
  };

  SVGSimilarityCEPAdapter.prototype.getCurrentDocumentInfo = function getCurrentDocumentInfo() {
    return SVGSimilarityCurrentDocument.getCEPDocumentInfo();
  };

  function SVGSimilarityUXPAdapter(config) {
    this.config = config || {};
    this.uxp = require("uxp");
    this.fs = this.uxp.storage.localFileSystem;
  }
  SVGSimilarityUXPAdapter.prototype.pickFolder = function pickFolder() { return this.fs.getFolder(); };
  SVGSimilarityUXPAdapter.prototype.listFiles = function listFiles(folderEntry, options) {
    var cfg = this.config.index || {}, recursive = options && options.recursive != null ? options.recursive : cfg.recursive !== false;
    var allowed = (cfg.allowedExtensions || [".svg", ".svgz", ".pdf", ".ai", ".eps"]).map(function (x) { return x.toLowerCase(); });
    var out = [];
    function walk(folder) {
      return folder.getEntries().then(function (entries) {
        var chain = Promise.resolve();
        entries.forEach(function (entry) {
          chain = chain.then(function () {
            if (!entry.name || entry.name.charAt(0) === "." || entry.name.indexOf("._") === 0 || entry.name === "__MACOSX") return null;
            if (entry.isFolder && recursive) return walk(entry);
            if (!entry.isFile) return null;
            var ext = extOf(entry.name);
            if (allowed.indexOf(ext) !== -1) out.push({ entry: entry, path: entry.nativePath || entry.name, name: entry.name, ext: ext });
            return null;
          });
        });
        return chain;
      });
    }
    return walk(folderEntry).then(function () { return out; });
  };
  SVGSimilarityUXPAdapter.prototype.readText = function readText(fileOrEntry) {
    var entry = fileOrEntry.entry || fileOrEntry;
    return entry.read({ format: this.uxp.storage.formats.utf8 });
  };
  SVGSimilarityUXPAdapter.prototype.normalizeToSVG = function normalizeToSVG(file) {
    var ext = file.ext || extOf(file.name || file.path);
    if (ext === ".svg") return this.readText(file).then(function (svgText) { return { svgText: svgText, format: "svg", converted: false, sourcePath: file.path || file.name }; });
    if (ext === ".svgz") return Promise.reject(new Error("UXP fallback cannot decompress SVGZ without a bundled gzip library."));
    return Promise.reject(new Error("UXP fallback can list AI/PDF/EPS, but needs Illustrator host conversion or a CEP/helper process to convert: " + (file.path || file.name)));
  };



  SVGSimilarityUXPAdapter.prototype.exportCurrentDocumentSVG = function exportCurrentDocumentSVG(options) {
    return SVGSimilarityCurrentDocument.exportUXP(options || {});
  };

  SVGSimilarityUXPAdapter.prototype.exportCurrentDocumentSVGWithMeta = function exportCurrentDocumentSVGWithMeta(options) {
    return SVGSimilarityCurrentDocument.exportUXPWithMeta(options || {});
  };

  SVGSimilarityUXPAdapter.prototype.getCurrentDocumentInfo = function getCurrentDocumentInfo() {
    return SVGSimilarityCurrentDocument.getUXPDocumentInfo();
  };

  SVGSimilarityUXPAdapter.prototype.pickTargetVectorFile = function pickTargetVectorFile() {
    var self = this;
    return this.fs.getFileForOpening({
      types: ["svg", "svgz", "pdf", "ai", "eps"],
      allowMultiple: false
    }).then(function (entry) {
      return { entry: entry, path: entry.nativePath || entry.name, name: entry.name, ext: extOf(entry.name) };
    }).then(function (file) {
      return self.normalizeToSVG(file).then(function (normalized) {
        return normalized.svgText;
      });
    });
  };

  global.SVGSimilarityBrowserAdapter = SVGSimilarityBrowserAdapter;
  global.SVGSimilarityCEPAdapter = SVGSimilarityCEPAdapter;
  global.SVGSimilarityUXPAdapter = SVGSimilarityUXPAdapter;
  global.SVGSimilarityPool = Pool;
})(this);
