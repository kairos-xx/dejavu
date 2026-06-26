(function (global) {
  "use strict";

  function SVGSimilarityConfig() {}

  SVGSimilarityConfig.defaults = function defaults() {
    return {
      version: 11,
      engine: {
        samplesPerElement: 160,
        maxSamples: 8192,
        rotationInvariant: true,
        scaleInvariant: true,
        translationInvariant: true,
        mirrorInvariant: false,
        includeHidden: false,
        compareTextAsGeometry: true,
        compareRasterImagesByBBox: true,
        colorTolerance: 8,
        numericPrecision: 5,
        elementMatchThreshold: 0.42,
        reportSampleLimit: 24,
        pathSampleMinDistance: 0.0025,
        pathSampleRoundToNearest: 0,
        weights: {
          canvas: 0.035,
          elementTypes: 0.045,
          structure: 0.055,
          geometryRaw: 0.06,
          geometryNormalized: 0.4,
          geometryMultiRotation: 0.1,
          bbox: 0.055,
          fill: 0.075,
          stroke: 0.065,
          strokeWidth: 0.035,
          opacity: 0.015,
          pathCommands: 0.035,
          curvature: 0.04,
          complexity: 0.025,
          imageUsage: 0.015,
          textUsage: 0.025,
          defsUsage: 0.01,
          gradientUsage: 0.02
        }
      },
      index: {
        allowedExtensions: [".svg", ".svgz", ".pdf", ".ai", ".eps"],
        recursive: true,
        maxFileSizeBytes: 104857600,
        cacheFileName: ".svg_similarity_cache_v11.json",
        limit: 60,
        shortlistLimit: 300,
        ioConcurrency: 12,
        conversionConcurrency: 4,
        fingerprintConcurrency: 1,
        saveCacheEvery: 25,
        skipFolders: [".git", "node_modules", "__MACOSX", ".Trash"],
        externalConverters: { enabled: true, prefer: ["embeddedSVG", "mutool", "inkscape", "ghostscript", "illustrator"], inkscapePath: "inkscape", mutoolPath: "mutool", ghostscriptPath: "gs", allowIllustratorFallback: true, avoidIllustrator: false, tryMutoolForEPS: false }
      },
      thresholds: { nearDuplicate: 0.9, similar: 0.75, loose: 0.55 },
      ui: { showBreakdown: true, showConvertedFormat: true, showElementReport: true, showFileMetadata: true, openFileOnClick: false, defaultSearchFolderFromCurrentDocument: true }
    };
  };

  SVGSimilarityConfig.merge = function merge(base, override) {
    var out = Array.isArray(base) ? base.slice() : {};
    var key;
    for (key in base || {}) out[key] = base[key];
    for (key in override || {}) {
      if (override[key] && typeof override[key] === "object" && !Array.isArray(override[key])) out[key] = SVGSimilarityConfig.merge(out[key] || {}, override[key]);
      else out[key] = override[key];
    }
    return out;
  };

  SVGSimilarityConfig.fromObject = function fromObject(obj) { return SVGSimilarityConfig.merge(SVGSimilarityConfig.defaults(), obj || {}); };
  SVGSimilarityConfig.loadBrowser = function loadBrowser(url) { return fetch(url || "./config.json").then(function (r) { if (!r.ok) throw new Error("Could not load config: " + r.status); return r.json(); }).then(SVGSimilarityConfig.fromObject); };
  SVGSimilarityConfig.loadCEP = function loadCEP(filePath) { var fs = require("fs"); return SVGSimilarityConfig.fromObject(JSON.parse(fs.readFileSync(filePath, "utf8"))); };

  global.SVGSimilarityConfig = SVGSimilarityConfig;
})(this);
