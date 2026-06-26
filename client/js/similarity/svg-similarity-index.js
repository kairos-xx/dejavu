(function (global) {
  "use strict";

  function SVGSimilarityIndex(options) {
    var o = options || {};
    this.config = o.config || SVGSimilarityConfig.defaults();
    this.engine = o.engine || new SVGSimilarityEngine(this.config.engine || {});
    this.adapter = o.adapter || SVGSimilarityEnv.createAdapter(this.config);
    this.cache = { version: 9, engineFingerprintVersion: 9, files: {} };
    this.cacheFolderPath = null;
    this.lastTotal = 0;
    this.progress = o.onProgress || function () {};
  }

  SVGSimilarityIndex.prototype.findSimilarToSVGText = function findSimilarToSVGText(svgText, folderOrEntry, options) {
    var target = this.engine.fingerprint(svgText);
    target.sourceMeta = (options && options.targetMeta) || { role: "target", name: "Current document or supplied SVG text" };
    return this.findSimilarToFingerprint(target, folderOrEntry, options);
  };

  SVGSimilarityIndex.prototype.findSimilarToCurrentIllustratorDocument = function findSimilarToCurrentIllustratorDocument(folderOrEntry, options) {
    var self = this, o = options || {}, cfg = this.config.index || {};
    return this.adapter.listFiles(folderOrEntry, { recursive: o.recursive != null ? o.recursive : cfg.recursive !== false }).then(function (files) {
      self.lastTotal = files.length;
      self.progress({ stage: "listed", done: 0, total: files.length });
      return self.exportCurrentDocumentSVGWithMeta(o).then(function (payload) {
      var targetOptions = {};
      var key;
      for (key in o) targetOptions[key] = o[key];
      // Exclude the origin document itself from the candidates: comparing a
      // file to itself is a meaningless 100% match, and (when it is the open
      // document) re-opening it during the scan is what closed it.
      var originPath = payload.path || payload.sourcePath || null;
      var scanFiles = files;
      if (originPath) {
        var norm = function (p) {
          return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        };
        var originNorm = norm(originPath);
        scanFiles = [];
        for (var fi = 0; fi < files.length; fi += 1) {
          var f = files[fi];
          var fp = f && (f.path || f.fsName || f.name);
          if (norm(fp) !== originNorm) scanFiles.push(f);
        }
      }
      self.lastTotal = scanFiles.length;
      targetOptions.files = scanFiles;
      targetOptions.targetMeta = {
        role: "target",
        name: payload.name || "Current document",
        path: payload.path || payload.sourcePath || null,
        sourcePath: payload.path || payload.sourcePath || null,
        folder: payload.folder || null,
        sizeBytes: payload.sizeBytes || null,
        mtimeMs: payload.mtimeMs || null,
        modifiedAt: payload.modifiedAt || null,
        tempSVGPath: payload.tempSVGPath || null
      };
      return self.findSimilarToSVGText(payload.svgText, folderOrEntry, targetOptions);
      });
    });
  };

  SVGSimilarityIndex.prototype.findSimilarToFingerprint = function findSimilarToFingerprint(target, folderOrEntry, options) {
    var self = this, cfg = this.config.index || {}, o = options || {};
    var limit = o.limit || cfg.limit || 60, shortlistLimit = o.shortlistLimit || cfg.shortlistLimit || Math.max(300, limit * 5);
    return this.loadCache(folderOrEntry).then(function () {
      return o.files || self.adapter.listFiles(folderOrEntry, { recursive: o.recursive != null ? o.recursive : cfg.recursive !== false });
    }).then(function (files) {
      self.lastTotal = files.length;
      if (!o.files) self.progress({ stage: "listed", done: 0, total: files.length });
      return self.indexFiles(files, folderOrEntry);
    }).then(function (indexed) {
      var rough = [];
      for (var i = 0; i < indexed.length; i += 1) {
        rough.push({ file: indexed[i].file, fingerprint: indexed[i].fingerprint, fastDelta: self.fastFingerprintDelta(target, indexed[i].fingerprint), meta: indexed[i].meta });
      }
      rough.sort(function (a, b) { return a.fastDelta - b.fastDelta; });
      var shortlist = rough.slice(0, shortlistLimit), finalResults = [];
      for (var j = 0; j < shortlist.length; j += 1) {
        var deep = self.engine.compareFingerprints(target, shortlist[j].fingerprint);
        var fileMeta = self.makeFileMeta(shortlist[j].file, shortlist[j].fingerprint, shortlist[j].meta);
        var targetMeta = self.makeTargetMeta(target);
        finalResults.push({
          filePath: shortlist[j].file.path || shortlist[j].file.name,
          file: shortlist[j].file,
          delta: deep.delta,
          similarity: deep.similarity,
          parts: deep.parts,
          weighted: deep.weighted,
          summary: deep.summary,
          report: self.buildComparisonReport(target, shortlist[j].fingerprint, targetMeta, fileMeta, deep),
          fastDelta: shortlist[j].fastDelta,
          meta: shortlist[j].meta
        });
      }
      finalResults.sort(function (a, b) { return a.delta - b.delta; });
      return finalResults.slice(0, limit);
    });
  };

  SVGSimilarityIndex.prototype.indexFiles = function indexFiles(files, folderOrEntry) {
    var self = this, cfg = this.config.index || {};
    var max = cfg.maxFileSizeBytes || Infinity, convertPool = new SVGSimilarityPool(cfg.conversionConcurrency || 1), fingerPool = new SVGSimilarityPool(cfg.fingerprintConcurrency || 1);
    var done = 0, indexed = [], dirty = 0;
    var tasks = files.map(function (file) {
      if (file.size && file.size > max) {
        done += 1; self.progress({ stage: "skipped", done: done, total: files.length, file: file });
        return Promise.resolve(null);
      }
      var cacheKey = self.cacheKey(file), cached = self.cache.files[cacheKey];
      if (cached && cached.fingerprint && self.cacheStillValid(file, cached)) {
        indexed.push({ file: file, fingerprint: cached.fingerprint, meta: cached.meta || { cached: true } });
        done += 1; self.progress({ stage: "cached", done: done, total: files.length, file: file });
        return Promise.resolve(null);
      }
      return convertPool.run(function () {
        self.progress({ stage: "converting", done: done, total: files.length, file: file });
        return self.adapter.normalizeToSVG(file);
      }).then(function (converted) {
        return fingerPool.run(function () {
          self.progress({ stage: "fingerprinting", done: done, total: files.length, file: file });
          var fp = self.engine.fingerprint(converted.svgText);
          var meta = {
            cached: false,
            converted: converted.converted,
            format: converted.format,
            sourcePath: converted.sourcePath,
            sizeBytes: file.size || null,
            mtimeMs: file.mtimeMs || null,
            modifiedAt: self.formatDate(file.mtimeMs || null)
          };
          self.cache.files[cacheKey] = { fingerprint: fp, meta: meta, mtimeMs: file.mtimeMs || 0, size: file.size || 0, name: file.name || file.path };
          indexed.push({ file: file, fingerprint: fp, meta: meta });
          done += 1; dirty += 1; self.progress({ stage: "indexed", done: done, total: files.length, file: file });
          if (dirty >= (cfg.saveCacheEvery || 25)) { dirty = 0; return self.saveCache(folderOrEntry).then(function () { return null; }); }
          return null;
        });
      }).catch(function (error) {
        self.cache.files[cacheKey] = { error: String(error && error.message ? error.message : error), mtimeMs: file.mtimeMs || 0, size: file.size || 0, name: file.name || file.path };
        done += 1; self.progress({ stage: "error", done: done, total: files.length, file: file, error: error });
        return null;
      });
    });
    return Promise.all(tasks).then(function () { return self.saveCache(folderOrEntry).then(function () { return indexed; }); });
  };

  SVGSimilarityIndex.prototype.fastFingerprintDelta = function fastFingerprintDelta(a, b) {
    return this.engine.canvasDelta(a.canvas, b.canvas) * 0.04 +
      this.engine.histogramDelta(a.elementTypes, b.elementTypes) * 0.08 +
      this.engine.colorHistogramDelta(a.fills, b.fills) * 0.06 +
      this.engine.colorHistogramDelta(a.strokes, b.strokes) * 0.06 +
      this.engine.bboxDelta(a.bbox, b.bbox) * 0.1 +
      this.engine.numericArrayDelta(a.curvature, b.curvature) * 0.1 +
      this.engine.pointCloudDelta(this.downsample(a.pointsNormalized, 256), this.downsample(b.pointsNormalized, 256)) * 0.56;
  };

  SVGSimilarityIndex.prototype.downsample = function downsample(points, max) {
    if (!points || points.length <= max) return points || [];
    var out = [], step = points.length / max;
    for (var i = 0; i < max; i += 1) out.push(points[Math.floor(i * step)]);
    return out;
  };

  SVGSimilarityIndex.prototype.cacheKey = function cacheKey(file) { return file.path || file.nativePath || file.name; };
  SVGSimilarityIndex.prototype.cacheStillValid = function cacheStillValid(file, cached) {
    if (!cached || !cached.fingerprint) return false;
    if (cached.fingerprint.version !== 6) return false;
    if (!cached.fingerprint.summary || cached.fingerprint.summary.elementCount <= 0) return false;
    if (!cached.fingerprint.summary || cached.fingerprint.summary.sampledPointCount <= 0) return false;
    if (file.mtimeMs && cached.mtimeMs && file.mtimeMs !== cached.mtimeMs) return false;
    if (file.size && cached.size && file.size !== cached.size) return false;
    return true;
  };
  SVGSimilarityIndex.prototype.loadCache = function loadCache(folderOrEntry) {
    var self = this, cfg = this.config.index || {};
    if (this.adapter instanceof SVGSimilarityCEPAdapter) {
      var p = this.adapter.path.join(String(folderOrEntry), cfg.cacheFileName || ".svg_similarity_cache_v9.json");
      this.cacheFolderPath = p;
      try { this.cache = JSON.parse(this.adapter.fs.readFileSync(p, "utf8")); } catch (e) { this.cache = { version: 9, engineFingerprintVersion: 9, files: {} }; }
      return Promise.resolve(this.cache);
    }
    this.cache = { version: 9, engineFingerprintVersion: 9, files: {} };
    return Promise.resolve(this.cache);
  };
  SVGSimilarityIndex.prototype.saveCache = function saveCache() {
    if (this.adapter instanceof SVGSimilarityCEPAdapter && this.cacheFolderPath) {
      try { this.adapter.fs.writeFileSync(this.cacheFolderPath, JSON.stringify(this.cache, null, 2), "utf8"); } catch (e) {}
    }
    return Promise.resolve();
  };


  SVGSimilarityIndex.prototype.makeTargetMeta = function makeTargetMeta(target) {
    var meta = (target && target.sourceMeta) || {};
    return {
      role: "A",
      name: meta.name || meta.path || meta.sourcePath || "Current document",
      path: meta.path || meta.sourcePath || null,
      sizeBytes: meta.sizeBytes || meta.size || null,
      modifiedAt: meta.modifiedAt || this.formatDate(meta.mtimeMs || null),
      mtimeMs: meta.mtimeMs || null,
      canvas: target && target.summary ? target.summary.canvas : null,
      bbox: target && target.summary ? target.summary.bbox : null,
      elementCount: target && target.summary ? target.summary.elementCount : 0,
      groupCount: target && target.summary ? target.summary.groupCount : 0,
      sampledPointCount: target && target.summary ? target.summary.sampledPointCount : 0,
      elementTypes: target && target.summary ? target.summary.elementTypes : {}
    };
  };

  SVGSimilarityIndex.prototype.makeFileMeta = function makeFileMeta(file, fingerprint, meta) {
    meta = meta || {};
    return {
      role: "B",
      name: file.name || file.path || meta.sourcePath || "candidate",
      path: file.path || meta.sourcePath || null,
      sizeBytes: file.size || meta.sizeBytes || null,
      modifiedAt: meta.modifiedAt || this.formatDate(file.mtimeMs || meta.mtimeMs || null),
      mtimeMs: file.mtimeMs || meta.mtimeMs || null,
      format: meta.format || file.ext || null,
      converted: !!meta.converted,
      canvas: fingerprint && fingerprint.summary ? fingerprint.summary.canvas : null,
      bbox: fingerprint && fingerprint.summary ? fingerprint.summary.bbox : null,
      elementCount: fingerprint && fingerprint.summary ? fingerprint.summary.elementCount : 0,
      groupCount: fingerprint && fingerprint.summary ? fingerprint.summary.groupCount : 0,
      sampledPointCount: fingerprint && fingerprint.summary ? fingerprint.summary.sampledPointCount : 0,
      elementTypes: fingerprint && fingerprint.summary ? fingerprint.summary.elementTypes : {}
    };
  };

  SVGSimilarityIndex.prototype.buildComparisonReport = function buildComparisonReport(target, candidate, targetMeta, fileMeta, deep) {
    var elementReport = deep && deep.report && deep.report.elements ? deep.report.elements : this.engine.compareElementProfiles(target, candidate);
    return {
      documents: {
        a: targetMeta,
        b: fileMeta
      },
      sizes: {
        aCanvas: targetMeta.canvas,
        bCanvas: fileMeta.canvas,
        aBBox: targetMeta.bbox,
        bBBox: fileMeta.bbox,
        aFileSizeBytes: targetMeta.sizeBytes,
        bFileSizeBytes: fileMeta.sizeBytes
      },
      dates: {
        aModifiedAt: targetMeta.modifiedAt,
        bModifiedAt: fileMeta.modifiedAt,
        aMtimeMs: targetMeta.mtimeMs,
        bMtimeMs: fileMeta.mtimeMs
      },
      counts: {
        aElements: targetMeta.elementCount,
        bElements: fileMeta.elementCount,
        aGroups: targetMeta.groupCount,
        bGroups: fileMeta.groupCount,
        aSampledPoints: targetMeta.sampledPointCount,
        bSampledPoints: fileMeta.sampledPointCount
      },
      elementTypes: {
        a: targetMeta.elementTypes,
        b: fileMeta.elementTypes
      },
      elementMatching: elementReport
    };
  };

  SVGSimilarityIndex.prototype.formatDate = function formatDate(ms) {
    if (!ms) return null;
    try { return new Date(ms).toISOString(); } catch (e) { return null; }
  };

  SVGSimilarityIndex.prototype.exportCurrentDocumentSVG = function exportCurrentDocumentSVG(options) {
    return SVGSimilarityCurrentDocument.exportSVG(this.adapter, options || {});
  };

  SVGSimilarityIndex.prototype.exportCurrentDocumentSVGWithMeta = function exportCurrentDocumentSVGWithMeta(options) {
    return SVGSimilarityCurrentDocument.exportSVGWithMeta(this.adapter, options || {});
  };

  SVGSimilarityIndex.prototype.getCurrentDocumentInfo = function getCurrentDocumentInfo() {
    return SVGSimilarityCurrentDocument.getCurrentDocumentInfo(this.adapter);
  };

  global.SVGSimilarityIndex = SVGSimilarityIndex;
})(this);
