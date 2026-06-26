(function (global) {
  "use strict";

  function SVGSimilarityEnv() {}

  SVGSimilarityEnv.detect = function detect() {
    var hasRequire = typeof require === "function";
    var isCEP = typeof CSInterface !== "undefined" || !!(global.__adobe_cep__ && typeof global.__adobe_cep__.evalScript === "function");
    var isUXP = false;
    try { isUXP = hasRequire && !!require("uxp"); } catch (e) { isUXP = false; }
    return { isCEP: isCEP, isUXP: isUXP, hasNode: hasRequire && !isUXP, hasDOM: typeof document !== "undefined", platform: (typeof navigator !== "undefined" && navigator.platform) || "unknown" };
  };

  SVGSimilarityEnv.createAdapter = function createAdapter(config) {
    var env = SVGSimilarityEnv.detect();
    if (env.isCEP || env.hasNode) return new SVGSimilarityCEPAdapter(config);
    if (env.isUXP) return new SVGSimilarityUXPAdapter(config);
    return new SVGSimilarityBrowserAdapter(config);
  };

  global.SVGSimilarityEnv = SVGSimilarityEnv;
})(this);
