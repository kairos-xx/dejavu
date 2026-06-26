(function (global) {
  "use strict";

  function assign(target) {
    for (var i = 1; i < arguments.length; i += 1) {
      var source = arguments[i] || {};
      for (var key in source) target[key] = source[key];
    }
    return target;
  }

  function SVGSimilarityEngine(options) {
    var o = options || {};
    this.options = assign({
      samplesPerElement: 160,
      maxSamples: 8192,
      rotationInvariant: true,
      scaleInvariant: true,
      translationInvariant: true,
      mirrorInvariant: false,
      includeHidden: true,
      compareTextAsGeometry: true,
      compareRasterImagesByBBox: true,
      colorTolerance: 8,
      numericPrecision: 5,
      elementMatchThreshold: 0.42,
      reportSampleLimit: 24,
      pathSampleMinDistance: 0.0025,
      pathSampleRoundToNearest: 0,
      weights: {}
    }, o);

    this.options.weights = assign({
      canvas: 0.035,
      elementTypes: 0.045,
      structure: 0.055,
      geometryRaw: 0.13,
      geometryNormalized: 0.31,
      geometryMultiRotation: 0.07,
      bbox: 0.045,
      fill: 0.075,
      stroke: 0.065,
      strokeWidth: 0.035,
      opacity: 0.015,
      pathCommands: 0.055,
      curvature: 0.04,
      complexity: 0.025,
      imageUsage: 0.015,
      textUsage: 0.025,
      defsUsage: 0.01,
      gradientUsage: 0.02
    }, this.options.weights || {});
  }

  SVGSimilarityEngine.prototype.compare = function compare(svgTextA, svgTextB) {
    return this.compareFingerprints(this.fingerprint(svgTextA), this.fingerprint(svgTextB));
  };

  SVGSimilarityEngine.prototype.compareFingerprints = function compareFingerprints(a, b) {
    var parts = {
      canvas: this.canvasDelta(a.canvas, b.canvas),
      elementTypes: this.histogramDelta(a.elementTypes, b.elementTypes),
      structure: this.sequenceDelta(a.structure, b.structure),
      geometryRaw: this.pointCloudDelta(a.pointsRaw, b.pointsRaw),
      geometryNormalized: this.pointCloudDelta(a.pointsNormalized, b.pointsNormalized),
      geometryMultiRotation: this.multiRotationDelta(a.pointsNormalized, b.pointsNormalized),
      bbox: this.bboxDelta(a.bbox, b.bbox),
      fill: this.colorHistogramDelta(a.fills, b.fills),
      stroke: this.colorHistogramDelta(a.strokes, b.strokes),
      strokeWidth: this.numericArrayDelta(a.strokeWidths, b.strokeWidths),
      opacity: this.numericArrayDelta(a.opacities, b.opacities),
      pathCommands: this.pathCommandDelta(a.pathCommands, b.pathCommands),
      curvature: this.numericArrayDelta(a.curvature, b.curvature),
      complexity: this.complexityDelta(a.complexity, b.complexity),
      imageUsage: this.scalarDelta(a.imageUsage, b.imageUsage),
      textUsage: this.scalarDelta(a.textUsage, b.textUsage),
      defsUsage: this.scalarDelta(a.defsUsage, b.defsUsage),
      gradientUsage: this.scalarDelta(a.gradientUsage, b.gradientUsage)
    };
    var weighted = {}, total = 0, totalWeight = 0;
    for (var key in parts) {
      var weight = this.options.weights[key] || 0;
      weighted[key] = parts[key] * weight;
      total += weighted[key];
      totalWeight += weight;
    }
    var delta = totalWeight === 0 ? 1 : total / totalWeight;
    var elementReport = this.compareElementProfiles(a, b);
    return {
      delta: this.clamp01(delta),
      similarity: this.clamp01(1 - delta),
      parts: parts,
      weighted: weighted,
      summary: { a: a.summary, b: b.summary },
      report: { elements: elementReport }
    };
  };

  SVGSimilarityEngine.prototype.fingerprint = function fingerprint(svgText) {
    var parsed = this.parseSVG(svgText);
    var svg = parsed.svg;
    try {
      var canvas = this.getCanvas(svg);
      var elements = this.collectElements(svg);
      var points = [], rawPoints = [], types = {}, fills = {}, strokes = {}, strokeWidths = [], opacities = [];
      var structure = [], pathCommands = [], curvature = [], bboxes = [], elementProfiles = [];
      var complexity = { pathCommands: 0, numericValues: 0, groups: svg.querySelectorAll("g").length, masks: svg.querySelectorAll("mask").length, clips: svg.querySelectorAll("clipPath").length, filters: svg.querySelectorAll("filter").length };
      var imageUsage = svg.querySelectorAll("image").length;
      var textUsage = svg.querySelectorAll("text,tspan,textPath").length;
      var defsUsage = svg.querySelectorAll("defs symbol use pattern marker").length;
      var gradientUsage = svg.querySelectorAll("linearGradient,radialGradient,meshgradient").length;

      for (var i = 0; i < elements.length; i += 1) {
        var el = elements[i], tag = this.lower(el.tagName);
        types[tag] = (types[tag] || 0) + 1;
        structure.push(this.structureToken(el));
        var style = this.getResolvedStyle(el);
        this.addHistogram(fills, style.fill);
        this.addHistogram(strokes, style.stroke);
        strokeWidths.push(style.strokeWidth);
        opacities.push(style.opacity);
        var cmd = this.extractCommandSignature(el);
        if (cmd) {
          pathCommands.push(cmd);
          complexity.pathCommands += cmd.commands.length;
          complexity.numericValues += cmd.numbers.length;
        }
        var sample = this.cleanSamplePoints(this.sampleElement(el));
        for (var s = 0; s < sample.length; s += 1) rawPoints.push(sample[s]);
        var curv = this.curvatureSignature(sample);
        for (var c = 0; c < curv.length; c += 1) curvature.push(curv[c]);
        var bbox = this.safeBBox(el);
        if (bbox) bboxes.push(bbox);
        elementProfiles.push(this.createElementProfile(el, canvas, style, cmd, sample, bbox));
      }

      rawPoints = this.limitPoints(rawPoints, this.options.maxSamples);
      points = this.normalizePointsToCanvas(rawPoints, canvas);
      var normalized = this.normalizePointCloud(points, this.options);
      var mirrored = null;
      if (this.options.mirrorInvariant) mirrored = this.mirrorPointCloud(normalized);
      var combinedBBox = this.normalizeBBoxToCanvas(this.combineBBoxes(bboxes), canvas);
      var groupProfiles = this.collectGroupProfiles(svg, canvas);

      return {
        version: 9,
        canvas: canvas,
        elementTypes: types,
        structure: structure,
        fills: fills,
        strokes: strokes,
        strokeWidths: strokeWidths,
        opacities: opacities,
        pathCommands: pathCommands,
        curvature: curvature,
        complexity: complexity,
        imageUsage: imageUsage,
        textUsage: textUsage,
        defsUsage: defsUsage,
        gradientUsage: gradientUsage,
        bbox: combinedBBox,
        elementProfiles: elementProfiles,
        groupProfiles: groupProfiles,
        pointsRaw: points,
        pointsNormalized: normalized,
        pointsMirrored: mirrored,
        summary: {
          elementCount: elements.length,
          groupCount: groupProfiles.length,
          sampledPointCount: rawPoints.length,
          canvas: canvas,
          bbox: combinedBBox,
          elementTypes: types,
          fills: Object.keys(fills).length,
          strokes: Object.keys(strokes).length,
          images: imageUsage,
          text: textUsage
        }
      };
    } finally {
      parsed.cleanup();
    }
  };

  SVGSimilarityEngine.prototype.parseSVG = function parseSVG(svgText) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(svgText, "image/svg+xml");
    var svg = doc.documentElement;
    if (!svg || this.lower(svg.tagName) !== "svg") throw new Error("Invalid SVG document.");
    var imported = document.importNode(svg, true);
    var host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-100000px;top:-100000px;width:1000px;height:1000px;overflow:hidden;pointer-events:none;z-index:-1;";
    host.appendChild(imported);
    document.body.appendChild(host);
    return { svg: imported, cleanup: function () { if (host.parentNode) host.parentNode.removeChild(host); } };
  };

  SVGSimilarityEngine.prototype.getCanvas = function getCanvas(svg) {
    var viewBox = svg.getAttribute("viewBox"), width = this.parseNumber(svg.getAttribute("width")) || 300, height = this.parseNumber(svg.getAttribute("height")) || 150, x = 0, y = 0;
    if (viewBox) { var nums = this.parseNumberList(viewBox); if (nums.length >= 4) { x = nums[0]; y = nums[1]; width = nums[2]; height = nums[3]; } }
    width = Math.max(width, 1e-9); height = Math.max(height, 1e-9);
    return { x: x, y: y, width: width, height: height, aspect: width / height };
  };

  SVGSimilarityEngine.prototype.collectElements = function collectElements(svg) {
    var selector = "path,rect,circle,ellipse,line,polyline,polygon,text,image,use";
    var all = Array.prototype.slice.call(svg.querySelectorAll(selector)), out = [];
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i], tag = this.lower(el.tagName);
      if (tag === "text" && !this.options.compareTextAsGeometry) continue;
      if (tag === "image" && !this.options.compareRasterImagesByBBox) continue;
      if (!this.options.includeHidden && this.isHidden(el)) continue;
      out.push(el);
    }
    return out;
  };

  SVGSimilarityEngine.prototype.isHidden = function isHidden(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var styleAttr = String(node.getAttribute("style") || "").toLowerCase();
      var displayAttr = String(node.getAttribute("display") || "").toLowerCase();
      var visibilityAttr = String(node.getAttribute("visibility") || "").toLowerCase();
      var opacityAttr = node.getAttribute("opacity");

      if (displayAttr === "none" || /display\s*:\s*none/.test(styleAttr)) return true;
      if (visibilityAttr === "hidden" || /visibility\s*:\s*hidden/.test(styleAttr)) return true;
      if (opacityAttr != null && Number(opacityAttr) === 0) return true;
      if (/opacity\s*:\s*0(?:[;\s]|$)/.test(styleAttr)) return true;

      node = node.parentNode;
    }
    return false;
  };

  SVGSimilarityEngine.prototype.getResolvedStyle = function getResolvedStyle(el) {
    var s = window.getComputedStyle(el);
    var fill = this.normalizeColor((s && s.fill) || el.getAttribute("fill"));
    var stroke = this.normalizeColor((s && s.stroke) || el.getAttribute("stroke"));
    var sw = this.parseNumber((s && s.strokeWidth) || el.getAttribute("stroke-width"));
    var opacity = Number((s && s.opacity) || el.getAttribute("opacity"));
    return { fill: fill || "none", stroke: stroke || "none", strokeWidth: Number.isFinite(sw) ? sw : 0, opacity: Number.isFinite(opacity) ? this.clamp01(opacity) : 1 };
  };

  SVGSimilarityEngine.prototype.sampleElement = function sampleElement(el) {
    var tag = this.lower(el.tagName);
    if (tag === "rect") return this.sampleRect(el);
    if (tag === "circle") return this.sampleCircle(el);
    if (tag === "ellipse") return this.sampleEllipse(el);
    if (tag === "line") return this.sampleLine(el);
    if (tag === "polyline" || tag === "polygon") return this.samplePolyline(el, tag === "polygon");
    if (tag === "text" || tag === "image" || tag === "use") return this.sampleBBox(el);
    if (typeof el.getTotalLength !== "function" || typeof el.getPointAtLength !== "function") return this.sampleBBox(el);
    var length;
    try { length = el.getTotalLength(); } catch (e) { return this.sampleBBox(el); }
    if (!Number.isFinite(length) || length <= 0) return this.sampleBBox(el);
    var points = [], count = Math.max(8, this.options.samplesPerElement), matrix = this.safeCTM(el);
    for (var i = 0; i < count; i += 1) {
      try { points.push(this.applyMatrix(el.getPointAtLength(length * (i / Math.max(count - 1, 1))), matrix)); } catch (e2) {}
    }
    return points.length ? points : this.sampleBBox(el);
  };

  SVGSimilarityEngine.prototype.sampleRect = function sampleRect(el) {
    var x = this.parseNumber(el.getAttribute("x")), y = this.parseNumber(el.getAttribute("y"));
    var w = this.parseNumber(el.getAttribute("width")), h = this.parseNumber(el.getAttribute("height"));
    if (!(w > 0) || !(h > 0)) return this.sampleBBox(el);
    var count = Math.max(8, this.options.samplesPerElement), m = this.safeCTM(el), out = [];
    var per = 2 * (w + h);
    for (var i = 0; i < count; i += 1) {
      var d = per * (i / count), p;
      if (d < w) p = { x: x + d, y: y };
      else if (d < w + h) p = { x: x + w, y: y + (d - w) };
      else if (d < 2 * w + h) p = { x: x + w - (d - w - h), y: y + h };
      else p = { x: x, y: y + h - (d - 2 * w - h) };
      out.push(this.applyMatrix(p, m));
    }
    return out;
  };

  SVGSimilarityEngine.prototype.sampleCircle = function sampleCircle(el) {
    var cx = this.parseNumber(el.getAttribute("cx")), cy = this.parseNumber(el.getAttribute("cy"));
    var r = this.parseNumber(el.getAttribute("r"));
    if (!(r > 0)) return this.sampleBBox(el);
    var count = Math.max(16, this.options.samplesPerElement), m = this.safeCTM(el), out = [];
    for (var i = 0; i < count; i += 1) {
      var a = Math.PI * 2 * (i / count);
      out.push(this.applyMatrix({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }, m));
    }
    return out;
  };

  SVGSimilarityEngine.prototype.sampleEllipse = function sampleEllipse(el) {
    var cx = this.parseNumber(el.getAttribute("cx")), cy = this.parseNumber(el.getAttribute("cy"));
    var rx = this.parseNumber(el.getAttribute("rx")), ry = this.parseNumber(el.getAttribute("ry"));
    if (!(rx > 0) || !(ry > 0)) return this.sampleBBox(el);
    var count = Math.max(16, this.options.samplesPerElement), m = this.safeCTM(el), out = [];
    for (var i = 0; i < count; i += 1) {
      var a = Math.PI * 2 * (i / count);
      out.push(this.applyMatrix({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }, m));
    }
    return out;
  };

  SVGSimilarityEngine.prototype.sampleLine = function sampleLine(el) {
    var x1 = this.parseNumber(el.getAttribute("x1")), y1 = this.parseNumber(el.getAttribute("y1"));
    var x2 = this.parseNumber(el.getAttribute("x2")), y2 = this.parseNumber(el.getAttribute("y2"));
    var count = Math.max(8, Math.floor(this.options.samplesPerElement / 2)), m = this.safeCTM(el), out = [];
    for (var i = 0; i < count; i += 1) {
      var t = i / Math.max(count - 1, 1);
      out.push(this.applyMatrix({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t }, m));
    }
    return out;
  };

  SVGSimilarityEngine.prototype.samplePolyline = function samplePolyline(el, closed) {
    var nums = this.parseNumberList(el.getAttribute("points"));
    if (nums.length < 4) return this.sampleBBox(el);
    var pts = [];
    for (var i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
    if (closed && pts.length > 2) pts.push({ x: pts[0].x, y: pts[0].y });
    var segs = [], total = 0;
    for (var j = 0; j < pts.length - 1; j += 1) {
      var dx = pts[j + 1].x - pts[j].x, dy = pts[j + 1].y - pts[j].y, len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) { segs.push({ a: pts[j], b: pts[j + 1], len: len }); total += len; }
    }
    if (!segs.length || total <= 0) return this.sampleBBox(el);
    var count = Math.max(8, this.options.samplesPerElement), m = this.safeCTM(el), out = [];
    for (var k = 0; k < count; k += 1) {
      var d = total * (k / Math.max(count - 1, 1)), acc = 0, seg = segs[segs.length - 1];
      for (var si = 0; si < segs.length; si += 1) { if (acc + segs[si].len >= d) { seg = segs[si]; break; } acc += segs[si].len; }
      var t = Math.max(0, Math.min(1, (d - acc) / seg.len));
      out.push(this.applyMatrix({ x: seg.a.x + (seg.b.x - seg.a.x) * t, y: seg.a.y + (seg.b.y - seg.a.y) * t }, m));
    }
    return out;
  };

  SVGSimilarityEngine.prototype.sampleBBox = function sampleBBox(el) {
    var b = this.safeBBox(el);
    if (!b) return [];
    return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
  };

  SVGSimilarityEngine.prototype.safeCTM = function safeCTM(el) { try { return el.getCTM(); } catch (e) { return null; } };
  SVGSimilarityEngine.prototype.applyMatrix = function applyMatrix(p, m) { return !m ? { x: p.x, y: p.y } : { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }; };
  SVGSimilarityEngine.prototype.safeBBox = function safeBBox(el) {
    try {
      var b = el.getBBox(), m = this.safeCTM(el), pts = [this.applyMatrix({ x: b.x, y: b.y }, m), this.applyMatrix({ x: b.x + b.width, y: b.y }, m), this.applyMatrix({ x: b.x + b.width, y: b.y + b.height }, m), this.applyMatrix({ x: b.x, y: b.y + b.height }, m)];
      var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    } catch (e) { return null; }
  };

  SVGSimilarityEngine.prototype.combineBBoxes = function combineBBoxes(bs) { if (!bs || !bs.length) return null; var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (var i = 0; i < bs.length; i += 1) { minX = Math.min(minX, bs[i].x); minY = Math.min(minY, bs[i].y); maxX = Math.max(maxX, bs[i].x + bs[i].width); maxY = Math.max(maxY, bs[i].y + bs[i].height); } return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }; };
  SVGSimilarityEngine.prototype.normalizeBBoxToCanvas = function normalizeBBoxToCanvas(b, c) { return !b ? null : { x: (b.x - c.x) / c.width, y: (b.y - c.y) / c.height, width: b.width / c.width, height: b.height / c.height }; };
  SVGSimilarityEngine.prototype.normalizePointsToCanvas = function normalizePointsToCanvas(points, c) { var out = []; for (var i = 0; i < points.length; i += 1) out.push({ x: (points[i].x - c.x) / c.width, y: (points[i].y - c.y) / c.height }); return out; };
  SVGSimilarityEngine.prototype.normalizePointCloud = function normalizePointCloud(points, opts) {
    if (!points || !points.length) return [];
    var p = points.slice();
    if (opts.translationInvariant) { var cen = this.centroid(p); p = p.map(function (q) { return { x: q.x - cen.x, y: q.y - cen.y }; }); }
    if (opts.rotationInvariant) { var a = this.principalAngle(p), cs = Math.cos(-a), sn = Math.sin(-a); p = p.map(function (q) { return { x: q.x * cs - q.y * sn, y: q.x * sn + q.y * cs }; }); }
    if (opts.scaleInvariant) { var sc = this.rmsRadius(p) || 1; p = p.map(function (q) { return { x: q.x / sc, y: q.y / sc }; }); }
    return p;
  };
  SVGSimilarityEngine.prototype.mirrorPointCloud = function mirrorPointCloud(points) { return (points || []).map(function (p) { return { x: -p.x, y: p.y }; }); };
  SVGSimilarityEngine.prototype.centroid = function centroid(points) { var x = 0, y = 0; for (var i = 0; i < points.length; i += 1) { x += points[i].x; y += points[i].y; } return { x: x / points.length, y: y / points.length }; };
  SVGSimilarityEngine.prototype.rmsRadius = function rmsRadius(points) { var sum = 0; for (var i = 0; i < points.length; i += 1) sum += points[i].x * points[i].x + points[i].y * points[i].y; return Math.sqrt(sum / Math.max(points.length, 1)); };
  SVGSimilarityEngine.prototype.principalAngle = function principalAngle(points) { var xx = 0, yy = 0, xy = 0; for (var i = 0; i < points.length; i += 1) { xx += points[i].x * points[i].x; yy += points[i].y * points[i].y; xy += points[i].x * points[i].y; } return 0.5 * Math.atan2(2 * xy, xx - yy); };
  SVGSimilarityEngine.prototype.limitPoints = function limitPoints(points, max) { if (!points || points.length <= max) return points || []; var out = [], step = points.length / max; for (var i = 0; i < max; i += 1) out.push(points[Math.floor(i * step)]); return out; };

  SVGSimilarityEngine.prototype.cleanSamplePoints = function cleanSamplePoints(points) {
    var source = points || [];
    var out = [];
    var minDistance = Number(this.options.pathSampleMinDistance || 0);
    var roundTo = Number(this.options.pathSampleRoundToNearest || 0);
    var last = null;

    function snap(value) {
      if (!roundTo || !Number.isFinite(roundTo) || roundTo <= 0) return value;
      return Math.round(value / roundTo) * roundTo;
    }

    for (var i = 0; i < source.length; i += 1) {
      var p = source[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;

      var q = { x: snap(Number(p.x)), y: snap(Number(p.y)) };

      if (last && minDistance > 0) {
        var dx = q.x - last.x;
        var dy = q.y - last.y;
        if (Math.sqrt(dx * dx + dy * dy) < minDistance) continue;
      }

      out.push(q);
      last = q;
    }

    if (out.length === 1 && source.length > 1) {
      var tail = source[source.length - 1];
      if (tail && Number.isFinite(tail.x) && Number.isFinite(tail.y)) {
        out.push({ x: snap(Number(tail.x)), y: snap(Number(tail.y)) });
      }
    }

    return out;
  };

  SVGSimilarityEngine.prototype.extractCommandSignature = function extractCommandSignature(el) {
    var tag = this.lower(el.tagName), nums = [], commands = [];
    if (tag === "path") {
      var d = el.getAttribute("d") || "", re = /([a-zA-Z])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g, m;
      while ((m = re.exec(d))) { if (m[1]) commands.push(m[1]); else nums.push(Number(m[2])); }
    } else {
      commands = [tag]; nums = this.primitiveNumbers(el);
    }
    return { commands: commands, numbers: this.normalizeNumberArray(nums) };
  };
  SVGSimilarityEngine.prototype.primitiveNumbers = function primitiveNumbers(el) {
    var tag = this.lower(el.tagName);
    if (tag === "rect") return [this.parseNumber(el.getAttribute("width")), this.parseNumber(el.getAttribute("height")), this.parseNumber(el.getAttribute("rx")), this.parseNumber(el.getAttribute("ry"))];
    if (tag === "circle") return [this.parseNumber(el.getAttribute("r"))];
    if (tag === "ellipse") return [this.parseNumber(el.getAttribute("rx")), this.parseNumber(el.getAttribute("ry"))];
    if (tag === "line") {
      var x1 = this.parseNumber(el.getAttribute("x1")), y1 = this.parseNumber(el.getAttribute("y1"));
      var x2 = this.parseNumber(el.getAttribute("x2")), y2 = this.parseNumber(el.getAttribute("y2"));
      return [Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2))];
    }
    if (tag === "polyline" || tag === "polygon") {
      var nums = this.parseNumberList(el.getAttribute("points"));
      var pts = [], out = [];
      for (var i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
      for (var j = 1; j < pts.length; j += 1) out.push(Math.sqrt(Math.pow(pts[j].x - pts[j - 1].x, 2) + Math.pow(pts[j].y - pts[j - 1].y, 2)));
      return out;
    }
    return [];
  };
  SVGSimilarityEngine.prototype.normalizeNumberArray = function normalizeNumberArray(nums) { var clean = (nums || []).filter(Number.isFinite); if (!clean.length) return []; var min = Math.min.apply(null, clean), max = Math.max.apply(null, clean), span = max - min || 1; return clean.map(function (n) { return (n - min) / span; }); };
  SVGSimilarityEngine.prototype.curvatureSignature = function curvatureSignature(points) { var out = []; if (!points || points.length < 3) return out; var step = Math.max(1, Math.floor(points.length / 64)); for (var i = step; i < points.length - step; i += step) { var a = points[i - step], b = points[i], c = points[i + step]; var v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y; var ang = Math.atan2(v2y, v2x) - Math.atan2(v1y, v1x); while (ang > Math.PI) ang -= Math.PI * 2; while (ang < -Math.PI) ang += Math.PI * 2; out.push(Math.abs(ang) / Math.PI); } return out; };
  SVGSimilarityEngine.prototype.structureToken = function structureToken(el) { var depth = 0, p = el.parentNode; while (p && p.nodeType === 1) { depth += 1; p = p.parentNode; } return this.lower(el.tagName) + ":" + depth; };

  SVGSimilarityEngine.prototype.canvasDelta = function canvasDelta(a, b) { var dw = Math.abs(a.width - b.width) / Math.max(a.width, b.width, 1), dh = Math.abs(a.height - b.height) / Math.max(a.height, b.height, 1), da = Math.abs(a.aspect - b.aspect) / Math.max(a.aspect, b.aspect, 1); return this.clamp01((dw + dh + da) / 3); };
  SVGSimilarityEngine.prototype.histogramDelta = function histogramDelta(a, b) { var keys = {}, k, diff = 0, total = 0; for (k in a) keys[k] = true; for (k in b) keys[k] = true; for (k in keys) { var av = a[k] || 0, bv = b[k] || 0; diff += Math.abs(av - bv); total += Math.max(av, bv); } return total === 0 ? 0 : this.clamp01(diff / total); };
  SVGSimilarityEngine.prototype.sequenceDelta = function sequenceDelta(a, b) { a = a || []; b = b || []; if (!a.length && !b.length) return 0; if (!a.length || !b.length) return 1; var max = Math.max(a.length, b.length), min = Math.min(a.length, b.length), diff = Math.abs(a.length - b.length); for (var i = 0; i < min; i += 1) if (a[i] !== b[i]) diff += 1; return this.clamp01(diff / max); };
  SVGSimilarityEngine.prototype.pathCommandDelta = function pathCommandDelta(a, b) { var ac = [], bc = [], an = [], bn = []; for (var i = 0; i < (a || []).length; i += 1) { ac = ac.concat(a[i].commands || []); an = an.concat(a[i].numbers || []); } for (var j = 0; j < (b || []).length; j += 1) { bc = bc.concat(b[j].commands || []); bn = bn.concat(b[j].numbers || []); } return this.clamp01(this.sequenceDelta(ac, bc) * 0.62 + this.numericSequenceDelta(an, bn) * 0.38); };
  SVGSimilarityEngine.prototype.numericSequenceDelta = function numericSequenceDelta(a, b) { a = a || []; b = b || []; if (!a.length && !b.length) return 0; if (!a.length || !b.length) return 1; var max = Math.max(a.length, b.length), min = Math.min(a.length, b.length), sum = Math.abs(a.length - b.length); for (var i = 0; i < min; i += 1) sum += Math.abs(a[i] - b[i]); return this.clamp01(sum / max); };
  SVGSimilarityEngine.prototype.bboxDelta = function bboxDelta(a, b) {
    if (!a && !b) return 0;
    if (!a || !b) return 1;
    var sizeDelta = (Math.abs(a.width - b.width) + Math.abs(a.height - b.height)) / 2;
    if (this.options.translationInvariant) return this.clamp01(sizeDelta);
    var posDelta = (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) / 2;
    return this.clamp01(sizeDelta * 0.65 + posDelta * 0.35);
  };
  SVGSimilarityEngine.prototype.pointCloudDelta = function pointCloudDelta(a, b) { if ((!a || !a.length) && (!b || !b.length)) return 0; if (!a || !b || !a.length || !b.length) return 1; var ab = this.meanNearestDistance(a, b), ba = this.meanNearestDistance(b, a); return this.softNormalize((ab + ba) / 2, 0.16); };
  SVGSimilarityEngine.prototype.multiRotationDelta = function multiRotationDelta(a, b) { if (!a || !b || !a.length || !b.length) return (!a || !a.length) && (!b || !b.length) ? 0 : 1; var best = this.pointCloudDelta(a, b), angles = [Math.PI / 2, Math.PI, Math.PI * 1.5]; for (var i = 0; i < angles.length; i += 1) best = Math.min(best, this.pointCloudDelta(a, this.rotatePoints(b, angles[i]))); return best; };
  SVGSimilarityEngine.prototype.rotatePoints = function rotatePoints(points, angle) { var c = Math.cos(angle), s = Math.sin(angle); return points.map(function (p) { return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }; }); };
  SVGSimilarityEngine.prototype.meanNearestDistance = function meanNearestDistance(a, b) { var sum = 0; for (var i = 0; i < a.length; i += 1) { var p = a[i], best = Infinity; for (var j = 0; j < b.length; j += 1) { var q = b[j], dx = p.x - q.x, dy = p.y - q.y, d = Math.sqrt(dx * dx + dy * dy); if (d < best) best = d; } sum += best; } return sum / a.length; };
  SVGSimilarityEngine.prototype.colorHistogramDelta = function colorHistogramDelta(a, b) {
    a = a || {}; b = b || {};
    var keys = {}, k, totalA = 0, totalB = 0;
    for (k in a) { keys[k] = true; totalA += a[k] || 0; }
    for (k in b) { keys[k] = true; totalB += b[k] || 0; }
    if (totalA === 0 && totalB === 0) return 0;
    if (totalA === 0 || totalB === 0) return 1;
    var diff = 0;
    for (k in keys) {
      diff += Math.abs(((a[k] || 0) / totalA) - ((b[k] || 0) / totalB));
    }
    return this.clamp01(diff / 2);
  };
  SVGSimilarityEngine.prototype.numericArrayDelta = function numericArrayDelta(a, b) { a = a || []; b = b || []; if (!a.length && !b.length) return 0; if (!a.length || !b.length) return 1; var aa = a.slice().sort(function (x, y) { return x - y; }), bb = b.slice().sort(function (x, y) { return x - y; }), n = Math.max(aa.length, bb.length), sum = 0; for (var i = 0; i < n; i += 1) { var av = aa[Math.floor((i / n) * aa.length)] || 0, bv = bb[Math.floor((i / n) * bb.length)] || 0, denom = Math.max(Math.abs(av), Math.abs(bv), 1); sum += Math.abs(av - bv) / denom; } return this.clamp01(sum / n); };
  SVGSimilarityEngine.prototype.scalarDelta = function scalarDelta(a, b) { return Math.abs((a || 0) - (b || 0)) / Math.max(a || 0, b || 0, 1); };
  SVGSimilarityEngine.prototype.complexityDelta = function complexityDelta(a, b) { var keys = ["pathCommands", "numericValues", "groups", "masks", "clips", "filters"], sum = 0; for (var i = 0; i < keys.length; i += 1) sum += this.scalarDelta(a && a[keys[i]], b && b[keys[i]]); return this.clamp01(sum / keys.length); };


  SVGSimilarityEngine.prototype.createElementProfile = function createElementProfile(el, canvas, style, cmd, sample, bbox) {
    var tag = this.lower(el.tagName);
    var depth = this.elementDepth(el);
    var nb = this.normalizeBBoxToCanvas(bbox, canvas);
    var normSample = this.normalizeElementSample(sample || [], bbox);
    var area = nb ? Math.max(0, nb.width * nb.height) : 0;
    return {
      kind: "element",
      tag: tag,
      id: el.getAttribute("id") || "",
      className: el.getAttribute("class") || "",
      depth: depth,
      parentPath: this.parentPath(el),
      fill: style.fill,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      opacity: style.opacity,
      bbox: nb,
      area: area,
      aspect: nb && nb.height ? nb.width / nb.height : 0,
      commands: cmd ? (cmd.commands || []) : [],
      numbers: cmd ? (cmd.numbers || []) : [],
      points: normSample,
      signature: this.profileSignature(tag, nb, style, cmd)
    };
  };

  SVGSimilarityEngine.prototype.collectGroupProfiles = function collectGroupProfiles(svg, canvas) {
    var groups = Array.prototype.slice.call(svg.querySelectorAll("g,defs,symbol,clipPath,mask,pattern"));
    var out = [];
    for (var i = 0; i < groups.length; i += 1) {
      var g = groups[i];
      if (!this.options.includeHidden && this.isHidden(g)) continue;
      var bbox = this.safeBBox(g);
      var nb = this.normalizeBBoxToCanvas(bbox, canvas);
      var descendants = Array.prototype.slice.call(g.querySelectorAll("path,rect,circle,ellipse,line,polyline,polygon,text,image,use"));
      var hist = {};
      for (var j = 0; j < descendants.length; j += 1) {
        var tag = this.lower(descendants[j].tagName);
        hist[tag] = (hist[tag] || 0) + 1;
      }
      out.push({
        kind: "group",
        tag: this.lower(g.tagName),
        id: g.getAttribute("id") || "",
        className: g.getAttribute("class") || "",
        depth: this.elementDepth(g),
        parentPath: this.parentPath(g),
        bbox: nb,
        area: nb ? Math.max(0, nb.width * nb.height) : 0,
        aspect: nb && nb.height ? nb.width / nb.height : 0,
        childCount: descendants.length,
        childTypes: hist,
        signature: this.profileSignature(this.lower(g.tagName), nb, { fill: "", stroke: "", strokeWidth: 0, opacity: 1 }, null)
      });
    }
    return out;
  };

  SVGSimilarityEngine.prototype.normalizeElementSample = function normalizeElementSample(points, bbox) {
    if (!points || !points.length || !bbox) return [];
    var w = Math.max(Math.abs(bbox.width), 1e-9), h = Math.max(Math.abs(bbox.height), 1e-9);
    var out = [];
    for (var i = 0; i < points.length; i += 1) {
      out.push({ x: (points[i].x - bbox.x) / w, y: (points[i].y - bbox.y) / h });
    }
    return this.limitPoints(out, 64);
  };

  SVGSimilarityEngine.prototype.profileSignature = function profileSignature(tag, bbox, style, cmd) {
    var w = bbox ? bbox.width : 0, h = bbox ? bbox.height : 0;
    var aspect = h ? w / h : 0;
    var commands = cmd && cmd.commands ? cmd.commands.join("") : "";
    return [tag, this.round(aspect, 3), style.fill || "", style.stroke || "", this.round(style.strokeWidth || 0, 3), commands.slice(0, 32)].join("|");
  };

  SVGSimilarityEngine.prototype.elementDepth = function elementDepth(el) {
    var depth = 0, p = el.parentNode;
    while (p && p.nodeType === 1) { depth += 1; p = p.parentNode; }
    return depth;
  };

  SVGSimilarityEngine.prototype.parentPath = function parentPath(el) {
    var parts = [], p = el.parentNode;
    while (p && p.nodeType === 1 && this.lower(p.tagName) !== "svg") {
      var id = p.getAttribute && p.getAttribute("id");
      parts.push(this.lower(p.tagName) + (id ? "#" + id : ""));
      p = p.parentNode;
    }
    return parts.reverse().join("/");
  };

  SVGSimilarityEngine.prototype.compareElementProfiles = function compareElementProfiles(a, b) {
    var aElements = (a.elementProfiles || []).concat(a.groupProfiles || []);
    var bElements = (b.elementProfiles || []).concat(b.groupProfiles || []);
    var threshold = Number(this.options.elementMatchThreshold || 0.42);
    var pairs = [];
    for (var i = 0; i < aElements.length; i += 1) {
      for (var j = 0; j < bElements.length; j += 1) {
        var d = this.elementProfileDelta(aElements[i], bElements[j]);
        if (d <= Math.max(0.9, threshold + 0.35)) pairs.push({ a: i, b: j, delta: d });
      }
    }
    pairs.sort(function (x, y) { return x.delta - y.delta; });
    var usedA = {}, usedB = {}, matches = [], changed = [];
    for (var p = 0; p < pairs.length; p += 1) {
      var pair = pairs[p];
      if (usedA[pair.a] || usedB[pair.b]) continue;
      usedA[pair.a] = true; usedB[pair.b] = true;
      var rec = { delta: pair.delta, similarity: this.clamp01(1 - pair.delta), a: this.publicProfile(aElements[pair.a]), b: this.publicProfile(bElements[pair.b]) };
      if (pair.delta <= threshold) matches.push(rec); else changed.push(rec);
    }
    var removed = [], added = [];
    for (var ai = 0; ai < aElements.length; ai += 1) if (!usedA[ai]) removed.push(this.publicProfile(aElements[ai]));
    for (var bi = 0; bi < bElements.length; bi += 1) if (!usedB[bi]) added.push(this.publicProfile(bElements[bi]));
    var avg = 0;
    for (var m = 0; m < matches.length; m += 1) avg += matches[m].delta;
    avg = matches.length ? avg / matches.length : 1;
    var limit = Math.max(1, Number(this.options.reportSampleLimit || 24));
    return {
      threshold: threshold,
      totalA: aElements.length,
      totalB: bElements.length,
      matchedSimilar: matches.length,
      matchedChanged: changed.length,
      newInB: added.length,
      removedFromA: removed.length,
      avgMatchedDelta: this.clamp01(avg),
      avgMatchedSimilarity: this.clamp01(1 - avg),
      matchedElements: matches.slice(0, limit),
      changedElements: changed.slice(0, limit),
      newElements: added.slice(0, limit),
      removedElements: removed.slice(0, limit)
    };
  };

  SVGSimilarityEngine.prototype.elementProfileDelta = function elementProfileDelta(a, b) {
    if (!a || !b) return 1;
    var tag = a.tag === b.tag ? 0 : 1;
    var kind = a.kind === b.kind ? 0 : 1;
    var bbox = this.bboxDelta(a.bbox, b.bbox);
    var area = this.scalarDelta(a.area, b.area);
    var aspect = this.scalarDelta(a.aspect, b.aspect);
    var depth = Math.min(1, Math.abs((a.depth || 0) - (b.depth || 0)) / 8);
    var fill = a.fill === b.fill ? 0 : 1;
    var stroke = a.stroke === b.stroke ? 0 : 1;
    var sw = this.scalarDelta(a.strokeWidth, b.strokeWidth);
    var opacity = this.scalarDelta(a.opacity, b.opacity);
    var command = this.sequenceDelta(a.commands || [], b.commands || []);
    var nums = this.numericSequenceDelta(a.numbers || [], b.numbers || []);
    var shape = this.pointCloudDelta(a.points || [], b.points || []);
    var childTypes = this.histogramDelta(a.childTypes || {}, b.childTypes || {});
    var childCount = this.scalarDelta(a.childCount, b.childCount);
    return this.clamp01(
      tag * 0.18 +
      kind * 0.06 +
      shape * 0.22 +
      bbox * 0.08 +
      area * 0.08 +
      aspect * 0.07 +
      command * 0.08 +
      nums * 0.04 +
      fill * 0.06 +
      stroke * 0.045 +
      sw * 0.025 +
      opacity * 0.015 +
      depth * 0.035 +
      childTypes * 0.055 +
      childCount * 0.025
    );
  };

  SVGSimilarityEngine.prototype.publicProfile = function publicProfile(p) {
    return {
      kind: p.kind,
      tag: p.tag,
      id: p.id,
      className: p.className,
      depth: p.depth,
      parentPath: p.parentPath,
      bbox: p.bbox,
      area: p.area,
      fill: p.fill,
      stroke: p.stroke,
      strokeWidth: p.strokeWidth,
      childCount: p.childCount || 0,
      signature: p.signature
    };
  };

  SVGSimilarityEngine.prototype.round = function round(value, digits) {
    var m = Math.pow(10, digits || 0);
    return Math.round((Number(value) || 0) * m) / m;
  };

  SVGSimilarityEngine.prototype.addHistogram = function addHistogram(h, v) { h[v || "none"] = (h[v || "none"] || 0) + 1; };
  SVGSimilarityEngine.prototype.normalizeColor = function normalizeColor(value) { if (!value) return "none"; var v = String(value).trim().toLowerCase(); if (!v || v === "none" || v === "transparent" || v === "rgba(0, 0, 0, 0)") return "none"; var rgb = v.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/); if (rgb) return "#" + this.toHex(Number(rgb[1])) + this.toHex(Number(rgb[2])) + this.toHex(Number(rgb[3])); if (/^#[0-9a-f]{3}$/i.test(v)) return ("#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase(); if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase(); return v; };
  SVGSimilarityEngine.prototype.toHex = function toHex(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"); };
  SVGSimilarityEngine.prototype.parseNumber = function parseNumber(v) { if (v == null) return 0; var m = String(v).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/i); return m ? Number(m[0]) : 0; };
  SVGSimilarityEngine.prototype.parseNumberList = function parseNumberList(v) { var m = String(v || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi); return m ? m.map(Number).filter(Number.isFinite) : []; };
  SVGSimilarityEngine.prototype.softNormalize = function softNormalize(v, s) { return this.clamp01(v / (v + s)); };
  SVGSimilarityEngine.prototype.clamp01 = function clamp01(v) { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1; };
  SVGSimilarityEngine.prototype.lower = function lower(v) { return String(v || "").toLowerCase(); };

  global.SVGSimilarityEngine = SVGSimilarityEngine;
})(this);
