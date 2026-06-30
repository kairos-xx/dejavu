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
    try { this.cp = require("child_process"); } catch (eCp) { this.cp = null; }
    this.external = (((this.config || {}).index || {}).externalConverters) || {};
    this._lastConversionPlan = [];
    this._binCache = {};
  }

  // True if a command runs (resolves its --version). Works for both bare names
  // on PATH and absolute paths.
  SVGSimilarityCEPAdapter.prototype.binaryRuns = function binaryRuns(cmd) {
    if (!cmd || !this.cp || typeof this.cp.spawnSync !== "function") return false;
    if (this._binCache[cmd] != null) return this._binCache[cmd];
    if (/Inkscape_mac_|inkscape_windows_intel|inkscape-win|Inkscape\.app/.test(String(cmd))) {
      try {
        this._binCache[cmd] = this.fs.existsSync(cmd);
        return this._binCache[cmd];
      } catch (ignoredBundledExists) {
        this._binCache[cmd] = false;
        return false;
      }
    }
    var ok = false;
    try {
      var res = this.cp.spawnSync(cmd, ["--version"],
        { encoding: "utf8", timeout: 8000, windowsHide: true });
      ok = !!(res && !res.error && (res.status === 0 || res.status === null &&
        String(res.stdout || res.stderr || "").length > 0));
      if (res && res.status !== 0 && res.error) ok = false;
    } catch (e) { ok = false; }
    this._binCache[cmd] = ok;
    return ok;
  };

  SVGSimilarityCEPAdapter.prototype.vendorBaseDir = function vendorBaseDir() {
    // Vendor binaries are installed outside the (read-only) extension folder,
    // into the per-user DejaVu data directory. Keep this in sync with
    // getVendorBase() in vendor-autoinstall.js.
    try {
      var os = this.os;
      var path = this.path;
      if (!os || !path || typeof os.homedir !== "function") return null;
      var home = os.homedir();
      var plat = (os.platform && os.platform()) ||
        (typeof process !== "undefined" && process.platform) || "";
      if (plat === "darwin") {
        return path.join(home, "Library", "Application Support", "DejaVu");
      }
      if (plat === "win32") {
        var appData = (typeof process !== "undefined" && process.env.APPDATA) ||
          path.join(home, "AppData", "Roaming");
        return path.join(appData, "DejaVu");
      }
      var xdg = (typeof process !== "undefined" && process.env.XDG_DATA_HOME) ||
        path.join(home, ".local", "share");
      return path.join(xdg, "DejaVu");
    } catch (ignoredVendorBase) {
      return null;
    }
  };

  SVGSimilarityCEPAdapter.prototype.baseDirs = function baseDirs() {
    var dirs = [];
    var self = this;
    var add = function (dir) {
      if (dir && dirs.indexOf(dir) === -1) dirs.push(dir);
    };
    try { add(this.vendorBaseDir()); } catch (ignoredVendor) {}
    try {
      if (typeof process !== "undefined" && typeof process.cwd === "function") {
        add(process.cwd());
      }
    } catch (ignoredCwd) {}
    try {
      if (typeof process !== "undefined" && process.execPath) {
        add(self.path.dirname(process.execPath));
      }
    } catch (ignoredExecPath) {}
    try {
      if (typeof __dirname !== "undefined") add(__dirname);
    } catch (ignoredDirname) {}
    try {
      if (global.document && document.currentScript && document.currentScript.src) {
        var src = decodeURIComponent(String(document.currentScript.src).replace(/^file:\/\//, ""));
        add(this.path.dirname(src));
      }
    } catch (ignoredScript) {}
    dirs.slice().forEach(function (dir) {
      var current = dir;
      for (var i = 0; i < 6; i += 1) {
        add(current);
        current = self.path.dirname(current);
        if (!current || current === self.path.dirname(current)) break;
      }
    });
    return dirs;
  };

  SVGSimilarityCEPAdapter.prototype.platformTarget = function platformTarget() {
    var platform = (this.os && this.os.platform && this.os.platform()) || "";
    var arch = (this.os && this.os.arch && this.os.arch()) ||
      (typeof process !== "undefined" && process.arch) || "";
    if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : "mac-intel";
    if (platform === "win32") return arch === "arm64" ? "win-arm64" : "win-intel";
    return platform || "unknown";
  };

  SVGSimilarityCEPAdapter.prototype.pathRuns = function pathRuns(cmd, args) {
    if (!cmd) return false;
    if (/[\\/]/.test(String(cmd))) {
      try {
        if (!this.fs.existsSync(cmd)) return false;
      } catch (ignoredExists) {
        return false;
      }
    }
    if (!this.cp || typeof this.cp.spawnSync !== "function") return true;
    try {
      var res = this.cp.spawnSync(cmd, args || [], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true
      });
      return !!(res && !res.error);
    } catch (ignoredSpawn) {
      return false;
    }
  };

  SVGSimilarityCEPAdapter.prototype.bundledInkscapeCandidates =
      function bundledInkscapeCandidates() {
    var candidates = [];
    var platform = (this.os && this.os.platform && this.os.platform()) || "";
    var target = this.platformTarget();
    var bases = this.baseDirs();
    var self = this;
    bases.forEach(function (base) {
      [
        self.path.join(base, "inkscape"),
        base,
        self.path.join(base, "vendor"),
        self.path.join(base, "vendor", "inkscape"),
        self.path.join(base, "tools"),
        self.path.join(base, "tools", "inkscape"),
        self.path.join(base, "bin"),
        self.path.join(base, "ai2svg-mac"),
        self.path.join(base, "ai2svg-windows")
      ].forEach(function (dir) {
        if (platform === "darwin") {
          if (target === "mac-arm64") {
            candidates.push(self.path.join(dir, "Inkscape_mac_arm64.app", "Contents", "MacOS", "inkscape"));
          } else if (target === "mac-intel") {
            candidates.push(self.path.join(dir, "Inkscape_mac_intel.app", "Contents", "MacOS", "inkscape"));
          }
          candidates.push(self.path.join(dir, "Inkscape.app", "Contents", "MacOS", "inkscape"));
        } else if (platform === "win32" && target === "win-intel") {
          candidates.push(self.path.join(dir, "inkscape_windows_intel", "bin", "inkscape.com"));
          candidates.push(self.path.join(dir, "inkscape-win", "bin", "inkscape.com"));
        }
      });
    });
    return candidates;
  };

  SVGSimilarityCEPAdapter.prototype.resolveAI2SVGBinary =
      function resolveAI2SVGBinary() {
    if (this._ai2svgBin !== undefined) return this._ai2svgBin;
    var candidates = [];
    var configured = this.external && this.external.ai2svgPath;
    if (configured) candidates.push(configured);
    candidates.push("ai2svg");
    var platform = (this.os && this.os.platform && this.os.platform()) || "";
    var exe = platform === "win32" ? "ai2svg.exe" : "ai2svg";
    var bases = this.baseDirs();
    var self = this;
    bases.forEach(function (base) {
      [
        base,
        self.path.join(base, "ai2svg-mac"),
        self.path.join(base, "ai2svg-windows"),
        self.path.join(base, "vendor", "ai2svg-mac"),
        self.path.join(base, "vendor", "ai2svg-windows"),
        self.path.join(base, "tools", "ai2svg-mac"),
        self.path.join(base, "tools", "ai2svg-windows")
      ].forEach(function (dir) {
        candidates.push(self.path.join(dir, exe));
      });
    });
    var found = null;
    for (var i = 0; i < candidates.length; i += 1) {
      if (this.pathRuns(candidates[i], [])) { found = candidates[i]; break; }
    }
    this._ai2svgBin = found;
    return found;
  };

  // Locate an Inkscape binary: a configured path, a bundled distribution,
  // PATH, then the usual per-OS install locations.
  SVGSimilarityCEPAdapter.prototype.resolveInkscapeBinary =
      function resolveInkscapeBinary() {
    if (this._inkscapeBin !== undefined) return this._inkscapeBin;
    var candidates = [];
    var configured = this.external && this.external.inkscapePath;
    if (configured) candidates.push(configured);
    candidates = candidates.concat(this.bundledInkscapeCandidates());
    candidates.push("inkscape");
    var platform = (this.os && this.os.platform && this.os.platform()) || "";
    if (platform === "darwin") {
      candidates.push("/Applications/Inkscape.app/Contents/MacOS/inkscape");
    } else if (platform === "win32") {
      candidates.push("C:\\Program Files\\Inkscape\\bin\\inkscape.com");
    } else {
      candidates.push("/usr/bin/inkscape");
      candidates.push("/usr/local/bin/inkscape");
      candidates.push("/snap/bin/inkscape");
    }
    var found = null;
    for (var i = 0; i < candidates.length; i += 1) {
      if (this.binaryRuns(candidates[i])) { found = candidates[i]; break; }
    }
    this._inkscapeBin = found;
    return found;
  };

  SVGSimilarityCEPAdapter.prototype.convertWithAI2SVG =
      function convertWithAI2SVG(filePath) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var bin = self.resolveAI2SVGBinary();
      if (!bin) { reject(new Error("AI2SVG converter not found.")); return; }
      if (!self.cp || typeof self.cp.spawn !== "function") {
        reject(new Error("Shell access is unavailable for AI2SVG."));
        return;
      }
      var out = self.tempSVGPath("svgsim_ai2svg");
      var ctx = self._progressContext || {};
      if (typeof self.progress === "function" && ctx.total) {
        self.progress({
          stage: "ai2svg",
          done: ctx.done || 0,
          current: (ctx.done || 0) + 0.35,
          total: ctx.total,
          file: ctx.file,
          attempt: 1
        });
      }
      var child;
      var stderr = "";
      var finished = false;
      var timer = null;
      var finish = function (error) {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (error) {
          self.deleteFileQuietly(out);
          reject(error);
          return;
        }
        var exists = false;
        try { exists = self.fs.existsSync(out); } catch (ignoredExists) {}
        if (!exists) {
          reject(new Error("AI2SVG produced no SVG output." + (stderr ? " " + stderr : "")));
          return;
        }
        try {
          var text = self.readTextAndDelete(out);
          if (text && text.indexOf("<svg") !== -1) {
            resolve(text);
            return;
          }
          reject(new Error("AI2SVG output was not SVG."));
        } catch (readError) {
          reject(readError);
        }
      };
      try {
        child = self.cp.spawn(bin, [filePath, out], { windowsHide: true });
      } catch (spawnError) {
        reject(spawnError);
        return;
      }
      timer = setTimeout(function () {
        try { child.kill(); } catch (ignoredKill) {}
        finish(new Error("AI2SVG timed out."));
      }, 90000);
      if (child.stderr) {
        child.stderr.on("data", function (chunk) { stderr += String(chunk || ""); });
      }
      child.on("error", finish);
      child.on("close", function (code) {
        if (typeof self.progress === "function" && ctx.total) {
          self.progress({
            stage: "ai2svg",
            done: ctx.done || 0,
            current: (ctx.done || 0) + 0.85,
            total: ctx.total,
            file: ctx.file,
            attempt: 1
          });
        }
        if (code !== 0) {
          finish(new Error("AI2SVG failed." + (stderr ? " " + stderr : "")));
          return;
        }
        finish();
      });
    });
  };

  // Convert AI/PDF/SVG-ish files to plain SVG via Inkscape — no Illustrator
  // involved, so nothing opens or closes. EPS is intentionally excluded
  // because Inkscape often treats it as XML and fails before conversion.
  // Handles both the
  // Inkscape 1.x and 0.92 command-line syntaxes.
  SVGSimilarityCEPAdapter.prototype.convertWithInkscape =
      function convertWithInkscape(filePath) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var bin = self.resolveInkscapeBinary();
      if (!bin) { reject(new Error("Inkscape not found.")); return; }
      var out = self.tempSVGPath("svgsim_inkscape");
      var ctx = self._progressContext || {};
      var argSets = [
        [filePath, "--export-type=svg", "--export-plain-svg",
          "--export-filename=" + out],
        ["--export-type=svg", "--export-plain-svg",
          "--export-filename=" + out, filePath],
        [filePath, "--export-plain-svg=" + out],
        ["--export-plain-svg=" + out, filePath]
      ];
      var tried = 0;
      var runInkscape = function (args, done) {
        if (!self.cp || typeof self.cp.spawn !== "function") {
          try {
            var res = self.cp.spawnSync(bin, args,
              { encoding: "utf8", timeout: 90000, windowsHide: true });
            done(null, res);
          } catch (eSync) {
            done(eSync);
          }
          return;
        }
        var child;
        var stdout = "";
        var stderr = "";
        var finished = false;
        var timer = null;
        var finish = function (error, result) {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          done(error, result);
        };
        try {
          child = self.cp.spawn(bin, args, { windowsHide: true });
        } catch (eSpawn) {
          finish(eSpawn);
          return;
        }
        timer = setTimeout(function () {
          try { child.kill(); } catch (ignoredKill) {}
          finish(new Error("Inkscape timed out."));
        }, 90000);
        if (child.stdout) {
          child.stdout.on("data", function (chunk) { stdout += String(chunk || ""); });
        }
        if (child.stderr) {
          child.stderr.on("data", function (chunk) { stderr += String(chunk || ""); });
        }
        child.on("error", function (error) { finish(error); });
        child.on("close", function (code) {
          finish(null, { status: code, stdout: stdout, stderr: stderr });
        });
      };
      var attempt = function () {
        if (tried >= argSets.length) {
          reject(new Error("Inkscape produced no SVG output."));
          return;
        }
        var args = argSets[tried];
        tried += 1;
        if (typeof self.progress === "function" && ctx.total) {
          self.progress({
            stage: "inkscape",
            done: ctx.done || 0,
            current: (ctx.done || 0) + Math.min(0.65, 0.25 + tried * 0.12),
            total: ctx.total,
            file: ctx.file,
            attempt: tried
          });
        }
        runInkscape(args, function () {
          var exists = false;
          try { exists = self.fs.existsSync(out); } catch (eEx) {}
          if (exists) {
            var text = "";
            try { text = self.readTextAndDelete(out); } catch (eRead) {
              reject(eRead);
              return;
            }
            if (text && text.indexOf("<svg") !== -1) { resolve(text); return; }
          }
          attempt();
        });
      };
      attempt();
    });
  };

  // Can this file be turned into SVG without Illustrator?
  SVGSimilarityCEPAdapter.prototype.canConvertWithoutIllustrator =
      function canConvertWithoutIllustrator(filePath) {
    var ext = extOf(filePath);
    if (ext === ".svg" || ext === ".svgz") return true;
    return !!(this.resolveAI2SVGBinary() || this.resolveInkscapeBinary());
  };

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
    if (ext === ".ai" || ext === ".pdf") {
      return self.convertVectorFileToSVG(filePath, self.resolveConversionPlanForExtension(ext)).then(function (svgText) {
        return { svgText: svgText, format: ext.slice(1), converted: true, sourcePath: filePath, converter: self._lastConverter || null, conversionPlan: self._lastConversionPlan ? self._lastConversionPlan.slice() : [] };
      });
    }
    if (ext === ".eps") {
      return self.convertVectorFileToSVG(filePath, self.resolveConversionPlanForExtension(ext)).then(function (svgText) {
        return { svgText: svgText, format: ext.slice(1), converted: true, sourcePath: filePath, converter: self._lastConverter || null, conversionPlan: self._lastConversionPlan ? self._lastConversionPlan.slice() : [] };
      });
    }
    return self.convertVectorFileToSVG(filePath).then(function (svgText) { return { svgText: svgText, format: ext.slice(1), converted: true, sourcePath: filePath, converter: self._lastConverter || null, conversionPlan: self._lastConversionPlan ? self._lastConversionPlan.slice() : [] }; });
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

  SVGSimilarityCEPAdapter.prototype.converterSupport = function converterSupport() {
    return {
      embeddedSVG: true,
      ai2svg: !!this.resolveAI2SVGBinary(),
      inkscape: true,
      illustrator: true
    };
  };

  SVGSimilarityCEPAdapter.prototype.resolveConversionPlan = function resolveConversionPlan() {
    var external = this.external || {};
    var planner = global.SVGSimilarityConverters;
    var plan = planner.resolvePlan({
      prefer: external.prefer,
      supported: this.converterSupport()
    });
    this._lastConversionPlan = plan.slice();
    return plan;
  };

  SVGSimilarityCEPAdapter.prototype.resolveConversionPlanForExtension =
      function resolveConversionPlanForExtension(ext) {
    var external = this.external || {};
    var planner = global.SVGSimilarityConverters;
    var plan = planner.planForExtension(ext, {
      prefer: external.prefer,
      supported: this.converterSupport()
    });
    this._lastConversionPlan = plan.slice();
    return plan;
  };

  SVGSimilarityCEPAdapter.prototype.convertVectorFileToSVG = function convertVectorFileToSVG(filePath, planOverride) {
    var self = this;
    var plan = planOverride ? planOverride.slice() : this.resolveConversionPlan(filePath);
    var errors = [];
    this._lastConversionPlan = plan.slice();
    this._lastConverter = null;
    var chain = Promise.reject(new Error("No converter attempted."));
    plan.forEach(function (name) {
      chain = chain.catch(function (previous) {
        if (previous && previous.message !== "No converter attempted.") {
          errors.push(previous.message || String(previous));
        }
        if (name === "embeddedSVG") return self.extractEmbeddedSVGText(filePath).then(function (text) { self._lastConverter = "embeddedSVG"; return text; });
        if (name === "ai2svg") return self.convertWithAI2SVG(filePath).then(function (text) { self._lastConverter = "ai2svg"; return text; });
        if (name === "inkscape") return self.convertWithInkscape(filePath).then(function (text) { self._lastConverter = "inkscape"; return text; });
        if (name === "illustrator") return self.convertWithIllustrator(filePath).then(function (text) { self._lastConverter = "illustrator"; return text; });
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
