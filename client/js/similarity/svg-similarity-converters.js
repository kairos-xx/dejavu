(function (root) {
  "use strict";

  var DEFAULT_PLAN = ["embeddedSVG", "ai2svg", "inkscape", "illustrator"];
  var VECTOR_FALLBACK_PLAN = ["ai2svg", "inkscape", "illustrator"];
  var EXTENSION_PLANS = {
    ".ai": VECTOR_FALLBACK_PLAN,
    ".pdf": VECTOR_FALLBACK_PLAN,
    ".eps": ["illustrator"]
  };
  var KNOWN_CONVERTERS = {
    embeddedSVG: true,
    ai2svg: true,
    inkscape: true,
    illustrator: true
  };

  function asArray(value, fallback) {
    return Array.isArray(value) && value.length ? value : fallback.slice();
  }

  function isSupported(name, supported) {
    return !!KNOWN_CONVERTERS[name] && (!supported || supported[name] !== false);
  }

  function appendUnique(out, name, supported) {
    if (isSupported(name, supported) && out.indexOf(name) === -1) {
      out.push(name);
    }
  }

  function appendPlan(out, plan, supported) {
    plan.forEach(function (name) {
      appendUnique(out, name, supported);
    });
  }

  function resolvePlan(options) {
    var config = options || {};
    var supported = config.supported || {};
    var requested = asArray(config.override || config.prefer, DEFAULT_PLAN);
    var out = [];
    var wantsAuto = false;

    requested.forEach(function (name) {
      if (name === "auto") {
        wantsAuto = true;
        return;
      }
      appendUnique(out, name, supported);
    });

    if (wantsAuto || out.length === 0) {
      appendPlan(out, DEFAULT_PLAN, supported);
    }
    if (config.appendFallbacks !== false) {
      appendPlan(out, VECTOR_FALLBACK_PLAN, supported);
    }
    return out;
  }

  function planForExtension(ext, options) {
    var normalizedExt = String(ext || "").toLowerCase();
    var config = {};
    var key;
    for (key in options || {}) {
      config[key] = options[key];
    }
    if (Object.prototype.hasOwnProperty.call(EXTENSION_PLANS, normalizedExt)) {
      config.override = EXTENSION_PLANS[normalizedExt];
      config.appendFallbacks = false;
    }
    return resolvePlan(config);
  }

  var converters = {
    DEFAULT_PLAN: DEFAULT_PLAN.slice(),
    VECTOR_FALLBACK_PLAN: VECTOR_FALLBACK_PLAN.slice(),
    resolvePlan: resolvePlan,
    planForExtension: planForExtension
  };

  root.SVGSimilarityConverters = converters;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = converters;
  }
})(typeof window !== "undefined" ? window : globalThis);
