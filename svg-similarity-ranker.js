// svg-similarity-ranker.js
// Self-contained dependency-free Node.js module for ranking visually/vector-similar SVG files.
// API: new SvgSimilarityRanker(tunings).rankFiles(originPath, candidatePaths)
// Minimal CLI: node svg-similarity-ranker.js origin.svg candidate1.svg candidate2.svg > ranking.json

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const XML_ELEMENT_NODE = 1;
const XML_TEXT_NODE = 3;

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function makeChildList() {
  const list = [];
  Object.defineProperty(list, "item", {
    value(index) { return this[index] || null; },
    enumerable: false
  });
  return list;
}

class SimpleXmlTextNode {
  constructor(text) {
    this.nodeType = XML_TEXT_NODE;
    this.nodeName = "#text";
    this.tagName = "#text";
    this.childNodes = makeChildList();
    this.data = decodeXmlEntities(text);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

class SimpleXmlElement {
  constructor(name, attributes = {}) {
    this.nodeType = XML_ELEMENT_NODE;
    this.nodeName = name;
    this.tagName = name;
    this.attributes = attributes;
    this.childNodes = makeChildList();
    this.parentNode = null;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent || "").join("");
  }

  getElementsByTagName(name) {
    const out = [];
    const wanted = String(name || "");
    const walk = (node) => {
      if (node.nodeType !== XML_ELEMENT_NODE) return;
      const local = String(node.tagName || "").replace(/^.*:/, "");
      if (wanted === "*" || node.tagName === wanted || local === wanted) out.push(node);
      for (const child of node.childNodes) walk(child);
    };
    for (const child of this.childNodes) walk(child);
    return out;
  }
}

function parseXmlAttributes(raw) {
  const attrs = {};
  const re = /([^\s=\/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1];
    if (!name || name === raw) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = decodeXmlEntities(value);
  }
  return attrs;
}

function parseXmlTag(token) {
  const body = token.replace(/^</, "").replace(/>$/, "").replace(/\/\s*$/, "").trim();
  const spaceIndex = body.search(/\s/);
  if (spaceIndex === -1) return { name: body, attributes: {} };
  const name = body.slice(0, spaceIndex);
  const attrText = body.slice(spaceIndex + 1);
  return { name, attributes: parseXmlAttributes(attrText) };
}

function parseXmlDocument(text) {
  const source = String(text || "");
  const rootWrapper = new SimpleXmlElement("#document", {});
  const stack = [rootWrapper];
  const tokenRe = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/[A-Za-z_][^>]*>|<[A-Za-z_][^>]*>|[^<]+/g;
  let match;
  while ((match = tokenRe.exec(source)) !== null) {
    const token = match[0];
    if (!token) continue;
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!DOCTYPE")) continue;
    if (token.startsWith("<![CDATA[")) {
      stack.at(-1).appendChild(new SimpleXmlTextNode(token.slice(9, -3)));
      continue;
    }
    if (token.startsWith("</")) {
      const closeName = token.replace(/^<\//, "").replace(/>$/, "").trim().replace(/^.*:/, "");
      while (stack.length > 1) {
        const popped = stack.pop();
        const poppedName = String(popped.tagName || "").replace(/^.*:/, "");
        if (poppedName === closeName) break;
      }
      continue;
    }
    if (token.startsWith("<")) {
      const selfClosing = /\/\s*>$/.test(token);
      const { name, attributes } = parseXmlTag(token);
      if (!name) continue;
      const element = new SimpleXmlElement(name, attributes);
      stack.at(-1).appendChild(element);
      if (!selfClosing) stack.push(element);
      continue;
    }
    if (token.trim()) stack.at(-1).appendChild(new SimpleXmlTextNode(token));
  }
  const documentElement = rootWrapper.childNodes.find((node) => node.nodeType === XML_ELEMENT_NODE) || null;
  return {
    documentElement,
    getElementsByTagName(name) {
      return documentElement ? documentElement.getElementsByTagName(name) : [];
    }
  };
}

class DOMParser {
  parseFromString(text) {
    return parseXmlDocument(text);
  }
}

const Matrix = (() => {
const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

function applyToPoint(matrix, point) {
  return {
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5]
  };
}

function translate(tx, ty) {
  return [1, 0, 0, 1, tx, ty];
}

function scale(sx, sy = sx) {
  return [sx, 0, 0, sy, 0, 0];
}

function rotate(angleDeg, cx = 0, cy = 0) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  if (cx === 0 && cy === 0) return [cos, sin, -sin, cos, 0, 0];
  return multiply(multiply(translate(cx, cy), [cos, sin, -sin, cos, 0, 0]), translate(-cx, -cy));
}

function skewX(angleDeg) {
  return [1, 0, Math.tan((angleDeg * Math.PI) / 180), 1, 0, 0];
}

function skewY(angleDeg) {
  return [1, Math.tan((angleDeg * Math.PI) / 180), 0, 1, 0, 0];
}

function parseTransform(input = "") {
  const text = String(input || "").trim();
  if (!text) return IDENTITY.slice();

  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let result = IDENTITY.slice();
  let match;
  while ((match = re.exec(text)) !== null) {
    const name = match[1];
    const nums = match[2]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((v) => Number.isFinite(v));

    let m = IDENTITY.slice();
    if (name === "matrix" && nums.length >= 6) {
      m = nums.slice(0, 6);
    } else if (name === "translate") {
      m = translate(nums[0] || 0, nums.length > 1 ? nums[1] : 0);
    } else if (name === "scale") {
      m = scale(nums[0] ?? 1, nums.length > 1 ? nums[1] : nums[0] ?? 1);
    } else if (name === "rotate") {
      m = rotate(nums[0] || 0, nums[1] || 0, nums[2] || 0);
    } else if (name === "skewX") {
      m = skewX(nums[0] || 0);
    } else if (name === "skewY") {
      m = skewY(nums[0] || 0);
    }
    result = multiply(result, m);
  }
  return result;
}

function decompose(matrix) {
  const [a, b, c, d, e, f] = matrix;
  const scaleX = Math.hypot(a, b) || 0;
  let rotation = 0;
  let scaleY = 0;
  let skew = 0;

  if (scaleX !== 0) {
    const na = a / scaleX;
    const nb = b / scaleX;
    skew = na * c + nb * d;
    const c2 = c - na * skew;
    const d2 = d - nb * skew;
    scaleY = Math.hypot(c2, d2) || 0;
    if (scaleY !== 0) skew /= scaleY;
    rotation = Math.atan2(nb, na) * 180 / Math.PI;
  }

  return {
    translateX: e,
    translateY: f,
    rotation,
    scaleX,
    scaleY,
    skewX: Math.atan(skew) * 180 / Math.PI
  };
}

function formatMatrix(matrix) {
  return matrix.map((v) => Number(v.toFixed(6)));
}

return { IDENTITY, multiply, applyToPoint, translate, scale, rotate, skewX, skewY, parseTransform, decompose, formatMatrix };
})();

const Colors = (() => {
const NAMED = new Map(Object.entries({
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  none: "none",
  transparent: "transparent",
  currentcolor: "currentColor"
}));

function normalizeColor(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (NAMED.has(text)) return NAMED.get(text);
  if (text === "none" || text === "transparent" || text === "currentcolor") return text;

  const hex3 = text.match(/^#([0-9a-f]{3})$/i);
  if (hex3) {
    const chars = hex3[1];
    return `#${chars[0]}${chars[0]}${chars[1]}${chars[1]}${chars[2]}${chars[2]}`.toLowerCase();
  }
  const hex6 = text.match(/^#([0-9a-f]{6})$/i);
  if (hex6) return `#${hex6[1].toLowerCase()}`;

  const rgb = text.match(/^rgba?\(([^)]*)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const nums = parts.slice(0, 3).map((part) => (
        part.endsWith("%")
          ? Math.round(Number(part.slice(0, -1)) * 2.55)
          : Number(part)
      ));
      if (nums.every(Number.isFinite)) {
        return `#${nums.map((num) => (
          Math.max(0, Math.min(255, Math.round(num)))
            .toString(16)
            .padStart(2, "0")
        )).join("")}`;
      }
    }
  }
  return text;
}

function hexToRgb(hex) {
  const color = normalizeColor(hex);
  const match = typeof color === "string" ? color.match(/^#([0-9a-f]{6})$/i) : null;
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/**
 * Converts a HEX color string to LAB coordinates using the D65 white point.
 *
 * This intentionally mirrors the CIE LAB conversion provided by the user so
 * palette and per-object color similarity use the same perceptual model.
 */
function hexToLab(hex) {
  const normalized = normalizeColor(hex);
  const match = typeof normalized === "string" ? normalized.match(/^#([0-9a-f]{6})$/i) : null;
  if (!match) return null;

  const cleaned = match[1];
  const rInt = Number.parseInt(cleaned.substring(0, 2), 16);
  const gInt = Number.parseInt(cleaned.substring(2, 4), 16);
  const bInt = Number.parseInt(cleaned.substring(4, 6), 16);

  let r = rInt / 255;
  let g = gInt / 255;
  let b = bInt / 255;

  r = r > 0.04045 ? ((r + 0.055) / 1.055) ** 2.4 : r / 12.92;
  g = g > 0.04045 ? ((g + 0.055) / 1.055) ** 2.4 : g / 12.92;
  b = b > 0.04045 ? ((b + 0.055) / 1.055) ** 2.4 : b / 12.92;

  r *= 100;
  g *= 100;
  b *= 100;

  const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = r * 0.0193 + g * 0.1192 + b * 0.9505;

  let xN = x / 95.047;
  let yN = y / 100.000;
  let zN = z / 108.883;

  xN = xN > 0.008856 ? xN ** (1 / 3) : 7.787 * xN + 16 / 116;
  yN = yN > 0.008856 ? yN ** (1 / 3) : 7.787 * yN + 16 / 116;
  zN = zN > 0.008856 ? zN ** (1 / 3) : 7.787 * zN + 16 / 116;

  return { L: 116 * yN - 16, a: 500 * (xN - yN), b: 200 * (yN - zN) };
}

/**
 * CIEDE2000 perceptual color-difference engine.
 */
function deltaE2000(lab1, lab2) {
  if (!lab1 || !lab2) return 100;

  const L1 = lab1.L;
  const a1 = lab1.a;
  const b1 = lab1.b;
  const L2 = lab2.L;
  const a2 = lab2.a;
  const b2 = lab2.b;

  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const meanC = (C1 + C2) / 2;

  const C7 = meanC ** 7;
  const G = 0.5 * (1 - Math.sqrt(C7 / (C7 + 25 ** 7)));

  const a1Prime = a1 * (1 + G);
  const a2Prime = a2 * (1 + G);

  const C1Prime = Math.sqrt(a1Prime * a1Prime + b1 * b1);
  const C2Prime = Math.sqrt(a2Prime * a2Prime + b2 * b2);

  const h1Prime = a1Prime === 0 && b1 === 0
    ? 0
    : (Math.atan2(b1, a1Prime) * 180 / Math.PI + 360) % 360;
  const h2Prime = a2Prime === 0 && b2 === 0
    ? 0
    : (Math.atan2(b2, a2Prime) * 180 / Math.PI + 360) % 360;

  const dLPrime = L2 - L1;
  const dCPrime = C2Prime - C1Prime;

  let dhPrime = 0;
  if (C1Prime * C2Prime !== 0) {
    dhPrime = h2Prime - h1Prime;
    if (dhPrime > 180) dhPrime -= 360;
    else if (dhPrime < -180) dhPrime += 360;
  }
  const dHPrime = 2 * Math.sqrt(C1Prime * C2Prime) * Math.sin(dhPrime * Math.PI / 360);

  const meanLPrime = (L1 + L2) / 2;
  const meanCPrime = (C1Prime + C2Prime) / 2;

  let meanhPrime = 0;
  if (C1Prime * C2Prime !== 0) {
    if (Math.abs(h1Prime - h2Prime) <= 180) {
      meanhPrime = (h1Prime + h2Prime) / 2;
    } else {
      meanhPrime = h1Prime + h2Prime < 360
        ? (h1Prime + h2Prime + 360) / 2
        : (h1Prime + h2Prime - 360) / 2;
    }
  }

  const T = 1
    - 0.17 * Math.cos((meanhPrime - 30) * Math.PI / 180)
    + 0.24 * Math.cos(2 * meanhPrime * Math.PI / 180)
    + 0.32 * Math.cos((3 * meanhPrime + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * meanhPrime - 63) * Math.PI / 180);

  const SL = 1 + 0.015 * (meanLPrime - 50) ** 2 / Math.sqrt(20 + (meanLPrime - 50) ** 2);
  const SC = 1 + 0.045 * meanCPrime;
  const SH = 1 + 0.015 * meanCPrime * T;

  const meanCPrime7 = meanCPrime ** 7;
  const RC = 2 * Math.sqrt(meanCPrime7 / (meanCPrime7 + 25 ** 7));
  const dTheta = 30 * Math.exp(-(((meanhPrime - 275) / 25) ** 2));
  const RT = -RC * Math.sin(2 * dTheta * Math.PI / 180);

  const dLKL = dLPrime / SL;
  const dCKC = dCPrime / SC;
  const dHKH = dHPrime / SH;

  return Math.sqrt(
    dLKL * dLKL
      + dCKC * dCKC
      + dHKH * dHKH
      + RT * dCKC * dHKH
  );
}

/**
 * Returns a 0..1 perceptual similarity score using CIEDE2000.
 */
function getColorSimilarity(hex1, hex2) {
  const color1 = normalizeColor(hex1);
  const color2 = normalizeColor(hex2);
  if (color1 === color2) return 1;
  if (!color1 || !color2) return 0;

  const lab1 = hexToLab(color1);
  const lab2 = hexToLab(color2);
  if (!lab1 || !lab2) return 0;

  const deltaE = deltaE2000(lab1, lab2);
  const similarity = 1 - Math.min(deltaE, 100) / 100;
  return Math.round(similarity * 10000) / 10000;
}

function colorDistance(a, b) {
  const colorA = normalizeColor(a);
  const colorB = normalizeColor(b);
  if (colorA === colorB) return 0;
  const labA = hexToLab(colorA);
  const labB = hexToLab(colorB);
  if (!labA || !labB) return 100;
  return deltaE2000(labA, labB);
}

function styleColorPairs(matchResults) {
  const pairs = [];
  for (const item of matchResults) {
    if (!item.a || !item.b) continue;
    const fields = ["fill", "stroke"];
    for (const field of fields) {
      const from = normalizeColor(item.a.style[field]);
      const to = normalizeColor(item.b.style[field]);
      const ignored = new Set(["none", "transparent"]);
      if (from && to && !ignored.has(from) && !ignored.has(to)) {
        pairs.push({ field, from, to, aId: item.a.key, bId: item.b.key });
      }
    }
  }
  return pairs;
}

function detectPaletteRemaps(matchResults) {
  const pairs = styleColorPairs(matchResults);
  const byFrom = new Map();
  for (const pair of pairs) {
    const key = `${pair.field}:${pair.from}`;
    if (!byFrom.has(key)) byFrom.set(key, new Map());
    const targets = byFrom.get(key);
    const toKey = pair.to;
    if (!targets.has(toKey)) {
      targets.set(toKey, {
        field: pair.field,
        from: pair.from,
        to: pair.to,
        count: 0,
        objects: []
      });
    }
    const entry = targets.get(toKey);
    entry.count += 1;
    entry.objects.push({ a: pair.aId, b: pair.bId });
  }

  const remaps = [];
  for (const [, targets] of byFrom) {
    const variants = [...targets.values()].sort((a, b) => b.count - a.count);
    const total = variants.reduce((sum, variant) => sum + variant.count, 0);
    const dominant = variants[0];
    const deltaE = colorDistance(dominant.from, dominant.to);
    remaps.push({
      field: dominant.field,
      from: dominant.from,
      to: dominant.to,
      count: dominant.count,
      total,
      consistency: total ? dominant.count / total : 0,
      deltaE,
      colorSimilarity: getColorSimilarity(dominant.from, dominant.to),
      consistent: total > 1 && dominant.count / total >= 0.85,
      variants: variants.map((variant) => ({
        ...variant,
        deltaE: colorDistance(variant.from, variant.to),
        colorSimilarity: getColorSimilarity(variant.from, variant.to)
      }))
    });
  }
  return remaps.sort((a, b) => b.total - a.total || b.count - a.count);
}

return { normalizeColor, hexToRgb, hexToLab, deltaE2000, getColorSimilarity, colorDistance, styleColorPairs, detectPaletteRemaps };
})();

const Geometry = (() => {
const { decompose } = Matrix;
const EPS = 1e-9;

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function bboxOfPoints(points) {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function bboxCenter(bbox) {
  return { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
}

function bboxDiagonal(bbox) {
  return Math.hypot(bbox.width, bbox.height);
}

function polylineLength(line) {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) total += distance(line[i - 1], line[i]);
  return total;
}

function polylinesLength(lines) {
  return lines.reduce((sum, line) => sum + polylineLength(line), 0);
}

function polygonArea(points) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function centroid(points) {
  if (!points.length) return { x: 0, y: 0 };
  const area = polygonArea(points);
  if (Math.abs(area) < EPS) {
    const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / points.length, y: sum.y / points.length };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

function isClosedPolyline(line) {
  return line.length > 2 && distance(line[0], line[line.length - 1]) < 1e-5;
}

function isClosedShape(lines) {
  return lines.length > 0 && lines.every(isClosedPolyline);
}

function flattenPolylines(lines) {
  return lines.flatMap((line) => line);
}

function resamplePolylines(lines, count = 128) {
  const segments = [];
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      const len = distance(a, b);
      if (len > EPS) {
        segments.push({ a, b, len, start: total, end: total + len });
        total += len;
      }
    }
  }
  if (!segments.length) return [];
  if (count <= 1) return [segments[0].a];

  const points = [];
  let segIndex = 0;
  for (let i = 0; i < count; i += 1) {
    const target = total * (i / (count - 1));
    while (segIndex < segments.length - 1 && segments[segIndex].end < target) segIndex += 1;
    const seg = segments[segIndex];
    const t = seg.len < EPS ? 0 : (target - seg.start) / seg.len;
    points.push({ x: seg.a.x + (seg.b.x - seg.a.x) * t, y: seg.a.y + (seg.b.y - seg.a.y) * t });
  }
  return points;
}

function normalizePoints(points) {
  const box = bboxOfPoints(points);
  const center = bboxCenter(box);
  const diag = bboxDiagonal(box) || 1;
  return points.map((p) => ({ x: (p.x - center.x) / diag, y: (p.y - center.y) / diag }));
}

function radialSignature(points, bins = 32) {
  if (!points.length) return Array.from({ length: bins }, () => 0);
  const center = centroid(points);
  const box = bboxOfPoints(points);
  const norm = bboxDiagonal(box) || 1;
  const buckets = Array.from({ length: bins }, () => []);
  for (const p of points) {
    let angle = Math.atan2(p.y - center.y, p.x - center.x);
    if (angle < 0) angle += 2 * Math.PI;
    const idx = Math.min(bins - 1, Math.floor((angle / (2 * Math.PI)) * bins));
    buckets[idx].push(distance(p, center) / norm);
  }
  return buckets.map((values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
}

function signatureDistance(a, b) {
  if (a.length !== b.length || !a.length) return 1;
  let best = Infinity;
  for (let shift = 0; shift < a.length; shift += 1) {
    let err = 0;
    for (let i = 0; i < a.length; i += 1) {
      const d = a[i] - b[(i + shift) % b.length];
      err += d * d;
    }
    best = Math.min(best, Math.sqrt(err / a.length));
  }
  return best;
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let i = 0; i < n; i += 1) {
    let pivot = i;
    for (let r = i + 1; r < n; r += 1) {
      if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    }
    if (Math.abs(a[pivot][i]) < EPS) return null;
    if (pivot !== i) [a[i], a[pivot]] = [a[pivot], a[i]];
    const div = a[i][i];
    for (let c = i; c <= n; c += 1) a[i][c] /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === i) continue;
      const factor = a[r][i];
      for (let c = i; c <= n; c += 1) a[r][c] -= factor * a[i][c];
    }
  }
  return a.map((row) => row[n]);
}

function fitAffine(from, to) {
  const count = Math.min(from.length, to.length);
  if (count < 3) {
    const dx = count ? to[0].x - from[0].x : 0;
    const dy = count ? to[0].y - from[0].y : 0;
    return { matrix: [1, 0, 0, 1, dx, dy], rms: 0, normalizedRms: 0, decomposition: decompose([1, 0, 0, 1, dx, dy]) };
  }

  const ata = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 0));
  const atb = Array.from({ length: 6 }, () => 0);
  const addRow = (row, value) => {
    for (let i = 0; i < 6; i += 1) {
      atb[i] += row[i] * value;
      for (let j = 0; j < 6; j += 1) ata[i][j] += row[i] * row[j];
    }
  };

  for (let i = 0; i < count; i += 1) {
    const p = from[i];
    const q = to[i];
    addRow([p.x, 0, p.y, 0, 1, 0], q.x);
    addRow([0, p.x, 0, p.y, 0, 1], q.y);
  }

  const solution = solveLinearSystem(ata, atb) || [1, 0, 0, 1, 0, 0];
  const matrix = solution;
  let err = 0;
  for (let i = 0; i < count; i += 1) {
    const p = from[i];
    const q = to[i];
    const x = matrix[0] * p.x + matrix[2] * p.y + matrix[4];
    const y = matrix[1] * p.x + matrix[3] * p.y + matrix[5];
    const dx = x - q.x;
    const dy = y - q.y;
    err += dx * dx + dy * dy;
  }
  const rms = Math.sqrt(err / count);
  const diag = bboxDiagonal(bboxOfPoints(to)) || 1;
  return { matrix, rms, normalizedRms: rms / diag, decomposition: decompose(matrix) };
}

function shiftPoints(points, shift) {
  if (!shift) return points;
  return points.map((_, i) => points[(i + shift) % points.length]);
}

function reversePoints(points) {
  return [...points].reverse();
}

function bestAffineFit(from, to, options = {}) {
  if (!from.length || !to.length) {
    return { matrix: [1, 0, 0, 1, 0, 0], rms: Infinity, normalizedRms: Infinity, decomposition: decompose([1, 0, 0, 1, 0, 0]), reversed: false, shift: 0 };
  }

  const maxShiftChecks = options.maxShiftChecks || 32;
  const closed = options.closed !== false;
  const step = closed ? Math.max(1, Math.floor(from.length / maxShiftChecks)) : from.length;
  let best = null;
  const variants = [from];
  if (options.allowReverse !== false) variants.push(reversePoints(from));

  for (let v = 0; v < variants.length; v += 1) {
    const pts = variants[v];
    for (let shift = 0; shift < from.length; shift += step) {
      const candidate = closed ? shiftPoints(pts, shift) : pts;
      const fit = fitAffine(candidate, to);
      const item = { ...fit, reversed: v === 1, shift };
      if (!best || item.normalizedRms < best.normalizedRms) best = item;
      if (!closed) break;
    }
  }
  return best;
}

function makeGeometry(polylines, sampleCount = 128) {
  const points = flattenPolylines(polylines);
  const sampled = resamplePolylines(polylines, sampleCount);
  const box = bboxOfPoints(points.length ? points : sampled);
  const center = centroid(sampled.length ? sampled : points);
  const area = Math.abs(polylines.reduce((sum, line) => sum + polygonArea(line), 0));
  const length = polylinesLength(polylines);
  const closed = isClosedShape(polylines);
  const signature = radialSignature(sampled, 32);
  return {
    polylines,
    points,
    sampled,
    normalizedSampled: normalizePoints(sampled),
    bbox: box,
    centroid: center,
    area,
    pathLength: length,
    closed,
    signature
  };
}

function geometrySimilarity(a, b) {
  if (!a.sampled.length || !b.sampled.length) return { score: 0, fit: null, signatureDistance: 1 };
  const count = Math.min(a.sampled.length, b.sampled.length);
  const from = a.sampled.slice(0, count);
  const to = b.sampled.slice(0, count);
  const sigDist = signatureDistance(a.signature, b.signature);
  const fit = bestAffineFit(from, to, { closed: a.closed && b.closed, maxShiftChecks: 32, allowReverse: true });
  const affineScore = Math.max(0, 1 - Math.min(1, fit.normalizedRms * 12));
  const sigScore = Math.max(0, 1 - Math.min(1, sigDist * 3));
  const areaRatio = Math.min(a.area || 1, b.area || 1) / Math.max(a.area || 1, b.area || 1);
  const lengthRatio = Math.min(a.pathLength || 1, b.pathLength || 1) / Math.max(a.pathLength || 1, b.pathLength || 1);
  const score = 0.55 * affineScore + 0.2 * sigScore + 0.15 * areaRatio + 0.1 * lengthRatio;
  return { score, fit, signatureDistance: sigDist, areaRatio, lengthRatio };
}

function classifyTransform(fit) {
  if (!fit || !Number.isFinite(fit.normalizedRms)) return "unknown";
  const d = fit.decomposition;
  const moved = Math.hypot(d.translateX, d.translateY) > 0.01;
  const rotated = Math.abs(d.rotation) > 0.5;
  const scaled = Math.abs(d.scaleX - 1) > 0.01 || Math.abs(d.scaleY - 1) > 0.01;
  const squeezed = Math.abs(d.scaleX - d.scaleY) > 0.02;
  const skewed = Math.abs(d.skewX) > 0.5;

  if (fit.normalizedRms > 0.025) return "geometry_edited";
  if (skewed) return "skewed";
  if (squeezed) return "squeezed";
  if (scaled && rotated && moved) return "moved_rotated_scaled";
  if (scaled && rotated) return "rotated_scaled";
  if (scaled && moved) return "moved_scaled";
  if (rotated && moved) return "moved_rotated";
  if (scaled) return "scaled";
  if (rotated) return "rotated";
  if (moved) return "moved";
  return "unchanged_geometry";
}

return { distance, bboxOfPoints, bboxCenter, bboxDiagonal, polylineLength, polylinesLength, polygonArea, centroid, isClosedPolyline, isClosedShape, flattenPolylines, resamplePolylines, normalizePoints, radialSignature, signatureDistance, fitAffine, bestAffineFit, makeGeometry, geometrySimilarity, classifyTransform };
})();

const PathTools = (() => {
const { applyToPoint } = Matrix;
const EPS = 1e-9;

function tokenizePath(d) {
  const out = [];
  const re = /([AaCcHhLlMmQqSsTtVvZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let match;
  while ((match = re.exec(d || "")) !== null) {
    out.push(match[1] || Number(match[2]));
  }
  return out;
}

function isCommand(token) {
  return typeof token === "string";
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function cubic(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y
  };
}

function quadratic(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
  };
}

function rotatePoint(x, y, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

function sampleArc(p0, rx0, ry0, xAxisRotation, largeArc, sweep, p1, stepsHint) {
  let rx = Math.abs(rx0);
  let ry = Math.abs(ry0);
  if (rx < EPS || ry < EPS || distance(p0, p1) < EPS) return [p0, p1];

  const phi = (xAxisRotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  const sign = largeArc === sweep ? -1 : 1;
  const denom = rx2 * y1p2 + ry2 * x1p2;
  const coef = denom < EPS ? 0 : sign * Math.sqrt(Math.max(0, (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / denom));
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);

  const cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2;

  const vectorAngle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const clamped = len < EPS ? 1 : Math.max(-1, Math.min(1, dot / len));
    const ang = Math.acos(clamped);
    return ux * vy - uy * vx < 0 ? -ang : ang;
  };

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  let theta1 = vectorAngle(1, 0, ux, uy);
  let delta = vectorAngle(ux, uy, vx, vy);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const arcLengthApprox = Math.max(rx, ry) * Math.abs(delta);
  const steps = Math.max(8, Math.min(128, Math.ceil(arcLengthApprox / Math.max(1, stepsHint || 8))));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = theta1 + delta * t;
    const rp = rotatePoint(rx * Math.cos(angle), ry * Math.sin(angle), phi);
    points.push({ x: cx + rp.x, y: cy + rp.y });
  }
  return points;
}

function parsePathToPolylines(d, options = {}) {
  const curveSteps = options.curveSteps || 24;
  const tokens = tokenizePath(d);
  const polylines = [];
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let lastControl = null;
  let lastQuadratic = null;
  let index = 0;
  let command = null;
  let line = [];

  const pushPoint = (pt) => {
    if (line.length === 0 || distance(line[line.length - 1], pt) > EPS) line.push(pt);
    current = pt;
  };
  const flushLine = () => {
    if (line.length > 1) polylines.push(line);
    line = [];
  };
  const read = () => tokens[index++];
  const hasNumber = () => index < tokens.length && !isCommand(tokens[index]);
  const num = () => {
    const value = read();
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const absolutePoint = (x, y, relative) => relative ? { x: current.x + x, y: current.y + y } : { x, y };

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = read();
    if (!command) break;

    const relative = command === command.toLowerCase();
    const cmd = command.toUpperCase();

    if (cmd === "M") {
      const p = absolutePoint(num(), num(), relative);
      flushLine();
      line = [p];
      current = p;
      start = p;
      lastControl = null;
      lastQuadratic = null;
      command = relative ? "l" : "L";
      while (hasNumber()) {
        const lp = absolutePoint(num(), num(), relative);
        pushPoint(lp);
      }
    } else if (cmd === "L") {
      while (hasNumber()) {
        pushPoint(absolutePoint(num(), num(), relative));
      }
      lastControl = null;
      lastQuadratic = null;
    } else if (cmd === "H") {
      while (hasNumber()) {
        const x = num();
        pushPoint({ x: relative ? current.x + x : x, y: current.y });
      }
      lastControl = null;
      lastQuadratic = null;
    } else if (cmd === "V") {
      while (hasNumber()) {
        const y = num();
        pushPoint({ x: current.x, y: relative ? current.y + y : y });
      }
      lastControl = null;
      lastQuadratic = null;
    } else if (cmd === "C") {
      while (hasNumber()) {
        const p0 = current;
        const p1 = absolutePoint(num(), num(), relative);
        const p2 = absolutePoint(num(), num(), relative);
        const p3 = absolutePoint(num(), num(), relative);
        for (let i = 1; i <= curveSteps; i += 1) pushPoint(cubic(p0, p1, p2, p3, i / curveSteps));
        lastControl = p2;
        lastQuadratic = null;
      }
    } else if (cmd === "S") {
      while (hasNumber()) {
        const p0 = current;
        const reflected = lastControl ? { x: 2 * current.x - lastControl.x, y: 2 * current.y - lastControl.y } : current;
        const p2 = absolutePoint(num(), num(), relative);
        const p3 = absolutePoint(num(), num(), relative);
        for (let i = 1; i <= curveSteps; i += 1) pushPoint(cubic(p0, reflected, p2, p3, i / curveSteps));
        lastControl = p2;
        lastQuadratic = null;
      }
    } else if (cmd === "Q") {
      while (hasNumber()) {
        const p0 = current;
        const p1 = absolutePoint(num(), num(), relative);
        const p2 = absolutePoint(num(), num(), relative);
        for (let i = 1; i <= curveSteps; i += 1) pushPoint(quadratic(p0, p1, p2, i / curveSteps));
        lastQuadratic = p1;
        lastControl = null;
      }
    } else if (cmd === "T") {
      while (hasNumber()) {
        const p0 = current;
        const reflected = lastQuadratic ? { x: 2 * current.x - lastQuadratic.x, y: 2 * current.y - lastQuadratic.y } : current;
        const p2 = absolutePoint(num(), num(), relative);
        for (let i = 1; i <= curveSteps; i += 1) pushPoint(quadratic(p0, reflected, p2, i / curveSteps));
        lastQuadratic = reflected;
        lastControl = null;
      }
    } else if (cmd === "A") {
      while (hasNumber()) {
        const p0 = current;
        const rx = num();
        const ry = num();
        const angle = num();
        const largeArc = num() !== 0;
        const sweep = num() !== 0;
        const p1 = absolutePoint(num(), num(), relative);
        const pts = sampleArc(p0, rx, ry, angle, largeArc, sweep, p1, 6);
        for (let i = 1; i < pts.length; i += 1) pushPoint(pts[i]);
        lastControl = null;
        lastQuadratic = null;
      }
    } else if (cmd === "Z") {
      pushPoint(start);
      flushLine();
      line = [];
      current = start;
      lastControl = null;
      lastQuadratic = null;
      command = null;
    } else {
      index += 1;
    }
  }
  flushLine();
  return polylines;
}

function transformPolylines(polylines, matrix) {
  return polylines.map((line) => line.map((pt) => applyToPoint(matrix, pt)));
}

function rectToPath(x, y, width, height, rx = 0, ry = 0) {
  const rrx = Math.max(0, Math.min(rx || 0, width / 2));
  const rry = Math.max(0, Math.min(ry || rrx, height / 2));
  if (rrx === 0 && rry === 0) {
    return `M${x},${y}H${x + width}V${y + height}H${x}Z`;
  }
  return [
    `M${x + rrx},${y}`,
    `H${x + width - rrx}`,
    `A${rrx},${rry} 0 0 1 ${x + width},${y + rry}`,
    `V${y + height - rry}`,
    `A${rrx},${rry} 0 0 1 ${x + width - rrx},${y + height}`,
    `H${x + rrx}`,
    `A${rrx},${rry} 0 0 1 ${x},${y + height - rry}`,
    `V${y + rry}`,
    `A${rrx},${rry} 0 0 1 ${x + rrx},${y}`,
    "Z"
  ].join(" ");
}

function circleToPath(cx, cy, r) {
  return `M${cx - r},${cy}A${r},${r} 0 1 0 ${cx + r},${cy}A${r},${r} 0 1 0 ${cx - r},${cy}Z`;
}

function ellipseToPath(cx, cy, rx, ry) {
  return `M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`;
}

function lineToPath(x1, y1, x2, y2) {
  return `M${x1},${y1}L${x2},${y2}`;
}

function pointsToPath(points, close = false) {
  const nums = String(points || "").trim().match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const pairs = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pairs.push([Number(nums[i]), Number(nums[i + 1])]);
  if (!pairs.length) return "";
  const parts = [`M${pairs[0][0]},${pairs[0][1]}`];
  for (let i = 1; i < pairs.length; i += 1) parts.push(`L${pairs[i][0]},${pairs[i][1]}`);
  if (close) parts.push("Z");
  return parts.join(" ");
}

return { parsePathToPolylines, transformPolylines, rectToPath, circleToPath, ellipseToPath, lineToPath, pointsToPath };
})();

const SvgParser = (() => {
const { IDENTITY, multiply, parseTransform } = Matrix;
const { makeGeometry } = Geometry;
const { circleToPath, ellipseToPath, lineToPath, parsePathToPolylines, pointsToPath, rectToPath, transformPolylines } = PathTools;
const { normalizeColor } = Colors;
const ELEMENT_NODE = 1;
const SKIP_TAGS = new Set([
  "defs",
  "style",
  "metadata",
  "title",
  "desc",
  "script",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "pattern",
  "filter",
  "marker"
]);

const DEFAULT_STYLE = {
  display: "inline",
  visibility: "visible",
  opacity: "1",
  fill: "#000000",
  stroke: "none",
  strokeWidth: "1",
  fillOpacity: "1",
  strokeOpacity: "1",
  color: "#000000",
  fontFamily: "",
  fontSize: "16",
  fontWeight: "normal",
  fontStyle: "normal",
  letterSpacing: "0",
  filter: "none",
  clipPath: "none",
  mask: "none",
  mixBlendMode: "normal"
};

const INHERITED_PROPS = new Set([
  "visibility",
  "fill",
  "stroke",
  "strokeWidth",
  "fillOpacity",
  "strokeOpacity",
  "color",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing"
]);

const PRESENTATION_ATTRS = new Map([
  ["fill", "fill"],
  ["stroke", "stroke"],
  ["stroke-width", "strokeWidth"],
  ["opacity", "opacity"],
  ["fill-opacity", "fillOpacity"],
  ["stroke-opacity", "strokeOpacity"],
  ["display", "display"],
  ["visibility", "visibility"],
  ["color", "color"],
  ["font-family", "fontFamily"],
  ["font-size", "fontSize"],
  ["font-weight", "fontWeight"],
  ["font-style", "fontStyle"],
  ["letter-spacing", "letterSpacing"],
  ["filter", "filter"],
  ["clip-path", "clipPath"],
  ["mask", "mask"],
  ["mix-blend-mode", "mixBlendMode"]
]);

const EMPTY_EFFECTS = Object.freeze({
  opacity: 1,
  filters: Object.freeze([]),
  clipPaths: Object.freeze([]),
  masks: Object.freeze([]),
  blendModes: Object.freeze([])
});

function attr(node, name, fallback = "") {
  if (!node || !node.getAttribute) return fallback;
  const value = node.getAttribute(name);
  return value === null || value === undefined ? fallback : value;
}

function tagName(node) {
  return String(node.tagName || node.nodeName || "").replace(/^.*:/, "");
}

function numberAttr(node, name, fallback = 0) {
  const raw = attr(node, name, "");
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseStyleDecl(styleText) {
  const out = {};
  for (const part of String(styleText || "").split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key || !value) continue;
    const mapped = PRESENTATION_ATTRS.get(key) || key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[mapped] = value;
  }
  return out;
}

function childrenOf(node) {
  const out = [];
  for (let i = 0; i < (node.childNodes?.length || 0); i += 1) {
    const child = node.childNodes.item(i);
    if (child.nodeType === ELEMENT_NODE) out.push(child);
  }
  return out;
}

function textContentOf(node) {
  return String(node.textContent || "").replace(/\s+/g, " ").trim();
}

function collectIds(node, ids = new Map()) {
  if (node.nodeType === ELEMENT_NODE) {
    const id = attr(node, "id", "");
    if (id) ids.set(id, node);
  }
  for (const child of childrenOf(node)) collectIds(child, ids);
  return ids;
}

function specificity(selector) {
  let score = 0;
  score += (selector.match(/#/g) || []).length * 100;
  score += (selector.match(/\./g) || []).length * 10;
  const bare = selector.replace(/[#.][\w-]+/g, "").trim();
  if (bare && bare !== "*") score += 1;
  return score;
}

function simpleSelectorMatches(node, selector) {
  const s = selector.trim();
  if (!s || /[>+~\s:[\]]/.test(s)) return false;
  if (s === "*") return true;
  const tag = tagName(node);
  const id = attr(node, "id", "");
  const classes = new Set(attr(node, "class", "").split(/\s+/).filter(Boolean));
  const tagMatch = s.match(/^[a-zA-Z_][\w-]*/);
  if (tagMatch && tagMatch[0] !== tag) return false;
  for (const part of s.match(/[#.][\w-]+/g) || []) {
    if (part.startsWith("#") && id !== part.slice(1)) return false;
    if (part.startsWith(".") && !classes.has(part.slice(1))) return false;
  }
  return true;
}

function parseCssRules(document) {
  const rules = [];
  const styleNodes = Array.from(document.getElementsByTagName("style") || []);
  let order = 0;
  for (const node of styleNodes) {
    const css = String(node.textContent || "").replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]+)\}/g;
    let match;
    while ((match = re.exec(css)) !== null) {
      const selectors = match[1].split(",").map((s) => s.trim()).filter(Boolean);
      const style = parseStyleDecl(match[2]);
      for (const selector of selectors) {
        rules.push({ selector, style, specificity: specificity(selector), order: order++ });
      }
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
}

function styleOverrides(node, cssRules) {
  const out = {};
  for (const rule of cssRules) {
    if (simpleSelectorMatches(node, rule.selector)) Object.assign(out, rule.style);
  }
  for (const [attrName, styleName] of PRESENTATION_ATTRS.entries()) {
    const value = attr(node, attrName, "");
    if (value !== "") out[styleName] = value;
  }
  Object.assign(out, parseStyleDecl(attr(node, "style", "")));
  return out;
}

function computeStyle(node, parentStyle, cssRules) {
  const style = { ...DEFAULT_STYLE };
  for (const prop of INHERITED_PROPS) style[prop] = parentStyle[prop] ?? DEFAULT_STYLE[prop];
  Object.assign(style, styleOverrides(node, cssRules));

  style.fill = resolveColor(style.fill, style.color);
  style.stroke = resolveColor(style.stroke, style.color);
  style.color = resolveColor(style.color, DEFAULT_STYLE.color);
  return style;
}

function resolveColor(value, currentColor) {
  const normalized = normalizeColor(value);
  if (normalized === "currentColor") return normalizeColor(currentColor) || currentColor;
  return normalized || value;
}

function parseOpacity(value) {
  const parsed = Number.parseFloat(value ?? "1");
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(1, parsed));
}

function cleanEffectValue(value) {
  const text = String(value || "").trim();
  if (!text || text === "none") return "";
  return text.replace(/url\(["']?#([^"')]+)["']?\)/g, "#$1");
}

function appendIfValue(values, value) {
  const cleaned = cleanEffectValue(value);
  return cleaned ? [...values, cleaned] : values;
}

function cascadeEffects(parentEffects, style) {
  const blend = cleanEffectValue(style.mixBlendMode);
  return {
    opacity: parentEffects.opacity * parseOpacity(style.opacity),
    filters: appendIfValue(parentEffects.filters, style.filter),
    clipPaths: appendIfValue(parentEffects.clipPaths, style.clipPath),
    masks: appendIfValue(parentEffects.masks, style.mask),
    blendModes: blend && blend !== "normal" ? [...parentEffects.blendModes, blend] : parentEffects.blendModes
  };
}

function effectSignature(effects) {
  return [
    `opacity:${Number((effects.opacity || 1).toFixed(6))}`,
    `filters:${effects.filters.join("|")}`,
    `clips:${effects.clipPaths.join("|")}`,
    `masks:${effects.masks.join("|")}`,
    `blends:${effects.blendModes.join("|")}`
  ].join(";");
}

function effectiveStyle(style, effects) {
  return {
    ...style,
    opacity: String(Number((effects.opacity || 1).toFixed(6))),
    filter: effects.filters.at(-1) || "none",
    clipPath: effects.clipPaths.at(-1) || "none",
    mask: effects.masks.at(-1) || "none",
    mixBlendMode: effects.blendModes.at(-1) || "normal"
  };
}

function isVisible(style, effects) {
  return style.display !== "none"
    && style.visibility !== "hidden"
    && (effects?.opacity ?? parseOpacity(style.opacity)) !== 0;
}

function pathForElement(node) {
  const tag = tagName(node);
  if (tag === "path") return attr(node, "d", "");
  if (tag === "rect") {
    return rectToPath(
      numberAttr(node, "x"),
      numberAttr(node, "y"),
      numberAttr(node, "width"),
      numberAttr(node, "height"),
      numberAttr(node, "rx"),
      numberAttr(node, "ry")
    );
  }
  if (tag === "circle") return circleToPath(numberAttr(node, "cx"), numberAttr(node, "cy"), numberAttr(node, "r"));
  if (tag === "ellipse") return ellipseToPath(numberAttr(node, "cx"), numberAttr(node, "cy"), numberAttr(node, "rx"), numberAttr(node, "ry"));
  if (tag === "line") return lineToPath(numberAttr(node, "x1"), numberAttr(node, "y1"), numberAttr(node, "x2"), numberAttr(node, "y2"));
  if (tag === "polyline") return pointsToPath(attr(node, "points", ""), false);
  if (tag === "polygon") return pointsToPath(attr(node, "points", ""), true);
  if (tag === "image") {
    return rectToPath(numberAttr(node, "x"), numberAttr(node, "y"), numberAttr(node, "width"), numberAttr(node, "height"));
  }
  return "";
}

function textToPathApprox(node, style) {
  const text = textContentOf(node);
  const fontSize = Number.parseFloat(style.fontSize || "16") || 16;
  const letterSpacing = Number.parseFloat(style.letterSpacing || "0") || 0;
  const width = Math.max(fontSize * 0.35, text.length * fontSize * 0.58 + Math.max(0, text.length - 1) * letterSpacing);
  const height = fontSize;
  const x = numberAttr(node, "x", 0);
  const y = numberAttr(node, "y", 0) - height * 0.8;
  return rectToPath(x, y, width, height);
}

function flatteningInfo(sourcePath, parentMatrix, localMatrix, effects) {
  return {
    mode: "leaf_with_cascaded_group_context",
    sourcePath,
    inheritedMatrix: parentMatrix.map((v) => Number(v.toFixed(6))),
    localMatrix: localMatrix.map((v) => Number(v.toFixed(6))),
    effectSignature: effectSignature(effects)
  };
}

function makeObject(node, path, worldMatrix, style, effects, flattenInfo, key, sourcePath, kind = "shape", sourceIndex = 0) {
  const localPolylines = parsePathToPolylines(path, { curveSteps: 24 });
  const worldPolylines = transformPolylines(localPolylines, worldMatrix);
  const geometry = makeGeometry(worldPolylines, 128);
  const tag = tagName(node);
  const id = attr(node, "id", "");
  const className = attr(node, "class", "");
  return {
    key,
    id,
    className,
    tag,
    kind,
    sourcePath,
    sourceIndex,
    text: tag === "text" ? textContentOf(node) : "",
    style: {
      fill: style.fill,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      opacity: style.opacity,
      fillOpacity: style.fillOpacity,
      strokeOpacity: style.strokeOpacity,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      letterSpacing: style.letterSpacing,
      filter: style.filter,
      clipPath: style.clipPath,
      mask: style.mask,
      mixBlendMode: style.mixBlendMode
    },
    effects: {
      opacity: Number((effects.opacity || 1).toFixed(6)),
      filters: [...effects.filters],
      clipPaths: [...effects.clipPaths],
      masks: [...effects.masks],
      blendModes: [...effects.blendModes],
      signature: effectSignature(effects)
    },
    flattening: flattenInfo,
    geometry,
    localPath: path,
    worldMatrix
  };
}

function parseViewBox(root) {
  const viewBox = attr(root, "viewBox", "").trim();
  if (viewBox) {
    const nums = viewBox.split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (nums.length === 4) return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
  }
  return {
    x: 0,
    y: 0,
    width: numberAttr(root, "width", 0),
    height: numberAttr(root, "height", 0)
  };
}

function groupObjectFromChildren(node, children, style, effects, key, sourcePath, worldMatrix) {
  const polylines = children.flatMap((child) => child.geometry.polylines);
  if (!polylines.length) return null;
  const geometry = makeGeometry(polylines, 128);
  return {
    key,
    id: attr(node, "id", ""),
    className: attr(node, "class", ""),
    tag: tagName(node),
    kind: "group",
    sourcePath,
    sourceIndex: 0,
    text: children.map((child) => child.text).filter(Boolean).join(" "),
    style: {
      fill: style.fill,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      opacity: style.opacity,
      fillOpacity: style.fillOpacity,
      strokeOpacity: style.strokeOpacity,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      letterSpacing: style.letterSpacing,
      filter: style.filter,
      clipPath: style.clipPath,
      mask: style.mask,
      mixBlendMode: style.mixBlendMode
    },
    effects: {
      opacity: Number((effects.opacity || 1).toFixed(6)),
      filters: [...effects.filters],
      clipPaths: [...effects.clipPaths],
      masks: [...effects.masks],
      blendModes: [...effects.blendModes],
      signature: effectSignature(effects)
    },
    geometry,
    childKeys: children.map((child) => child.key),
    localPath: "",
    worldMatrix
  };
}

function parseSvg(svgText, options = {}) {
  const parser = new DOMParser({ errorHandler: { warning: null, error: null } });
  const document = parser.parseFromString(svgText, "image/svg+xml");
  const root = document.documentElement;
  const ids = collectIds(root);
  const cssRules = parseCssRules(document);
  const includeGroups = options.includeGroups === true;
  const leafObjects = [];
  const groupObjects = [];
  let seq = 0;

  const visit = (node, parentStyle, parentMatrix, parentEffects, sourcePath) => {
    const tag = tagName(node);
    if (SKIP_TAGS.has(tag)) return [];

    const style = computeStyle(node, parentStyle, cssRules);
    const localTransform = parseTransform(attr(node, "transform", ""));
    let worldMatrix = multiply(parentMatrix, localTransform);
    const effects = cascadeEffects(parentEffects, style);

    if (!isVisible(style, effects)) return [];

    if (tag === "use") {
      const href = attr(node, "href", attr(node, "xlink:href", "")).replace(/^#/, "");
      const ref = ids.get(href);
      if (!ref) return [];
      const x = numberAttr(node, "x", 0);
      const y = numberAttr(node, "y", 0);
      worldMatrix = multiply(worldMatrix, [1, 0, 0, 1, x, y]);
      return visit(ref, style, worldMatrix, effects, `${sourcePath}/use(${href})`);
    }

    const before = leafObjects.length;
    const children = childrenOf(node);
    const own = [];
    const effective = effectiveStyle(style, effects);
    const shapePath = tag === "text" ? textToPathApprox(node, effective) : pathForElement(node);
    const isShape = Boolean(shapePath) && !["svg", "g", "symbol"].includes(tag);
    if (isShape) {
      const key = attr(node, "id", "") || `${tag}_${seq + 1}`;
      const flatInfo = flatteningInfo(sourcePath, parentMatrix, localTransform, effects);
      const obj = makeObject(node, shapePath, worldMatrix, effective, effects, flatInfo, key, sourcePath, tag === "text" ? "text" : "shape", seq);
      seq += 1;
      if (obj.geometry.points.length || obj.text) {
        leafObjects.push(obj);
        own.push(obj);
      }
    }

    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const childTag = tagName(child);
      visit(child, style, worldMatrix, effects, `${sourcePath}/${childTag}[${i}]`);
    }

    const descendantChildren = leafObjects.slice(before);
    if ((tag === "g" || tag === "symbol") && includeGroups && descendantChildren.length > 1) {
      const key = attr(node, "id", "") || `${tag}_group_${groupObjects.length + 1}`;
      const group = groupObjectFromChildren(node, descendantChildren, effective, effects, key, sourcePath, worldMatrix);
      if (group) groupObjects.push(group);
    }
    return own;
  };

  visit(root, DEFAULT_STYLE, IDENTITY, EMPTY_EFFECTS, `/${tagName(root)}[0]`);

  return {
    viewBox: parseViewBox(root),
    objects: leafObjects,
    groups: groupObjects,
    allObjects: [...groupObjects, ...leafObjects],
    cssRules: cssRules.length,
    flattened: true,
    groupComparisonEnabled: includeGroups,
    raw: svgText
  };
}

return { parseSvg };
})();

const Fingerprint = (() => {
const { getColorSimilarity, normalizeColor } = Colors;
const { bboxDiagonal, geometrySimilarity, signatureDistance } = Geometry;
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return 0;
  return Number(clamp01(value).toFixed(digits));
}

function rawRound(value, digits = 6) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function numericRatio(a, b) {
  const av = Math.max(0, Number(a || 0));
  const bv = Math.max(0, Number(b || 0));
  if (av === 0 && bv === 0) return 1;
  return Math.min(av, bv) / Math.max(av, bv, 1e-9);
}

function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const rows = s.length + 1;
  const cols = t.length + 1;
  const prev = Array.from({ length: cols }, (_, i) => i);
  const curr = Array.from({ length: cols }, () => 0);
  for (let i = 1; i < rows; i += 1) {
    curr[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < cols; j += 1) prev[j] = curr[j];
  }
  return prev[cols - 1];
}

function textSimilarity(a, b) {
  const ta = String(a || "").trim().toLowerCase();
  const tb = String(b || "").trim().toLowerCase();
  if (!ta && !tb) return 1;
  if (!ta || !tb) return 0;
  return clamp01(1 - levenshtein(ta, tb) / Math.max(ta.length, tb.length, 1));
}

function stableLogBucket(value, base = 1.6) {
  const safe = Math.max(Number(value || 0), 1e-9);
  return Math.round(Math.log(safe) / Math.log(base));
}

function objectArea(obj) {
  if (!obj?.geometry) return 0;
  const box = obj.geometry.bbox || {};
  const bboxArea = Math.max(0, Number(box.width || 0)) * Math.max(0, Number(box.height || 0));
  const area = Math.max(0, Number(obj.geometry.area || 0));
  return Math.max(area, bboxArea);
}

function objectWeight(obj) {
  if (!obj?.geometry) return 1;
  const area = objectArea(obj);
  const length = Math.max(0, Number(obj.geometry.pathLength || 0));
  const box = obj.geometry.bbox || {};
  const diag = bboxDiagonal(box) || 0;
  const textBonus = obj.kind === "text" && obj.text ? String(obj.text).length * 6 : 0;
  const groupBonus = obj.kind === "group" ? 8 : 0;
  return Math.max(1, Math.sqrt(area) + Math.sqrt(length) + diag * 0.08 + textBonus + groupBonus);
}

function selectImportantObjects(objects, maxObjects) {
  return [...objects]
    .map((object) => ({ object, weight: objectWeight(object) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxObjects)
    .map((item) => item.object);
}

function colorsForObject(obj) {
  const colors = [];
  for (const field of ["fill", "stroke"]) {
    const color = normalizeColor(obj?.style?.[field]);
    if (color && color !== "none" && color !== "transparent" && /^#[0-9a-f]{6}$/i.test(color)) {
      colors.push({ field, color });
    }
  }
  return colors;
}

function objectColorSimilarity(a, b) {
  const ca = colorsForObject(a);
  const cb = colorsForObject(b);
  if (!ca.length && !cb.length) return 1;
  if (!ca.length || !cb.length) return 0.35;
  let total = 0;
  let count = 0;
  for (const left of ca) {
    let best = 0;
    for (const right of cb) best = Math.max(best, getColorSimilarity(left.color, right.color));
    total += best;
    count += 1;
  }
  return count ? total / count : 0;
}

function searchGeometrySimilarity(a, b) {
  const geometry = geometrySimilarity(a.geometry, b.geometry);
  if (!geometry.fit) return 0;
  const affineScore = clamp01(1 - Math.min(1, geometry.fit.normalizedRms * 8));
  const sigScore = clamp01(1 - Math.min(1, (geometry.signatureDistance || 0) * 2.3));
  const areaSoft = Math.sqrt(numericRatio(a.geometry.area || objectArea(a), b.geometry.area || objectArea(b)));
  const lengthSoft = Math.sqrt(numericRatio(a.geometry.pathLength, b.geometry.pathLength));
  return clamp01(0.62 * affineScore + 0.23 * sigScore + 0.08 * areaSoft + 0.07 * lengthSoft);
}

function kindSimilarity(a, b) {
  if (a.kind === b.kind) return 1;
  if (a.tag === b.tag) return 0.8;
  if ((a.kind === "shape" && b.kind === "group") || (a.kind === "group" && b.kind === "shape")) return 0.45;
  return 0.25;
}

function searchObjectSimilarity(a, b) {
  const kind = kindSimilarity(a, b);
  const geometry = searchGeometrySimilarity(a, b);
  const color = objectColorSimilarity(a, b);
  const text = (a.kind === "text" || b.kind === "text" || a.text || b.text)
    ? textSimilarity(a.text, b.text)
    : 1;
  const id = a.id && b.id && a.id === b.id ? 1 : 0;

  if (a.kind === "text" || b.kind === "text") {
    return clamp01(0.40 * text + 0.24 * geometry + 0.16 * color + 0.12 * kind + 0.08 * id);
  }
  return clamp01(0.68 * geometry + 0.20 * color + 0.08 * kind + 0.04 * id);
}

function weightedSoftObjectBagSimilarity(aObjects, bObjects, options = {}) {
  const maxObjects = Math.max(1, options.maxObjects || 220);
  const threshold = options.threshold ?? 0.48;
  const a = selectImportantObjects(aObjects, maxObjects);
  const b = selectImportantObjects(bObjects, maxObjects);
  const totalA = a.reduce((sum, obj) => sum + objectWeight(obj), 0);
  const totalB = b.reduce((sum, obj) => sum + objectWeight(obj), 0);

  if (!a.length && !b.length) {
    return { score: 1, average: 1, coverageSmall: 1, coverageLarge: 1, matched: 0 };
  }
  if (!a.length || !b.length) {
    return { score: 0, average: 0, coverageSmall: 0, coverageLarge: 0, matched: 0 };
  }

  const pairs = [];
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      const cheapKind = kindSimilarity(a[i], b[j]);
      const areaRatio = numericRatio(objectArea(a[i]), objectArea(b[j]));
      const textGate = a[i].kind === "text" || b[j].kind === "text"
        ? textSimilarity(a[i].text, b[j].text)
        : 1;
      if (cheapKind < 0.35 && areaRatio < 0.18 && textGate < 0.4) continue;
      const score = searchObjectSimilarity(a[i], b[j]);
      if (score >= threshold) {
        pairs.push({ i, j, score, weight: Math.min(objectWeight(a[i]), objectWeight(b[j])) });
      }
    }
  }

  pairs.sort((x, y) => y.score - x.score || y.weight - x.weight);
  const usedA = new Set();
  const usedB = new Set();
  let matchedWeight = 0;
  let weightedScore = 0;
  let matched = 0;

  for (const pair of pairs) {
    if (usedA.has(pair.i) || usedB.has(pair.j)) continue;
    usedA.add(pair.i);
    usedB.add(pair.j);
    matchedWeight += pair.weight;
    weightedScore += pair.weight * pair.score;
    matched += 1;
  }

  const average = matchedWeight ? weightedScore / matchedWeight : 0;
  const small = Math.min(totalA, totalB) || 1;
  const large = Math.max(totalA, totalB) || 1;
  const coverageSmall = clamp01(matchedWeight / small);
  const coverageLarge = clamp01(matchedWeight / large);
  const coverageFactor = 0.72 * coverageSmall + 0.28 * Math.sqrt(coverageLarge);
  const score = clamp01(average * coverageFactor);
  return {
    score: round(score),
    average: round(average),
    coverageSmall: round(coverageSmall),
    coverageLarge: round(coverageLarge),
    matched
  };
}

function addWeighted(map, key, weight) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + weight);
}

function colorBag(svg) {
  const bag = new Map();
  for (const obj of svg.objects || []) {
    const weight = objectWeight(obj);
    for (const item of colorsForObject(obj)) addWeighted(bag, item.color, weight * (item.field === "fill" ? 1 : 0.55));
  }
  return bag;
}

function textBag(svg) {
  const bag = new Map();
  for (const obj of svg.objects || []) {
    const text = String(obj.text || "").trim().toLowerCase();
    if (!text) continue;
    const weight = objectWeight(obj);
    addWeighted(bag, `phrase:${text}`, weight * 1.2);
    for (const token of text.split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 2)) {
      addWeighted(bag, token, weight);
    }
  }
  return bag;
}

function weightedJaccard(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  if (!keys.size) return 1;
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const av = a.get(key) || 0;
    const bv = b.get(key) || 0;
    intersection += Math.min(av, bv);
    union += Math.max(av, bv);
  }
  return union ? intersection / union : 1;
}

function paletteSimilarity(aSvg, bSvg) {
  const a = [...colorBag(aSvg).entries()].map(([color, weight]) => ({ color, weight }));
  const b = [...colorBag(bSvg).entries()].map(([color, weight]) => ({ color, weight }));
  if (!a.length && !b.length) return { score: 1, average: 1, coverageSmall: 1, matched: 0 };
  if (!a.length || !b.length) return { score: 0, average: 0, coverageSmall: 0, matched: 0 };

  const totalA = a.reduce((sum, item) => sum + item.weight, 0);
  const totalB = b.reduce((sum, item) => sum + item.weight, 0);
  const pairs = [];
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      pairs.push({ i, j, score: getColorSimilarity(a[i].color, b[j].color), weight: Math.min(a[i].weight, b[j].weight) });
    }
  }
  pairs.sort((x, y) => y.score - x.score || y.weight - x.weight);
  const usedA = new Set();
  const usedB = new Set();
  let matchedWeight = 0;
  let weightedScore = 0;
  let matched = 0;
  for (const pair of pairs) {
    if (usedA.has(pair.i) || usedB.has(pair.j)) continue;
    usedA.add(pair.i);
    usedB.add(pair.j);
    matchedWeight += pair.weight;
    weightedScore += pair.weight * pair.score;
    matched += 1;
  }
  const average = matchedWeight ? weightedScore / matchedWeight : 0;
  const coverageSmall = clamp01(matchedWeight / Math.min(totalA, totalB));
  const coverageLarge = clamp01(matchedWeight / Math.max(totalA, totalB));
  const score = clamp01(average * (0.8 * coverageSmall + 0.2 * Math.sqrt(coverageLarge)));
  return { score: round(score), average: round(average), coverageSmall: round(coverageSmall), matched };
}

function kindDistribution(svg) {
  const bag = new Map();
  for (const obj of svg.objects || []) addWeighted(bag, obj.kind || obj.tag || "unknown", objectWeight(obj));
  return bag;
}

function aspectRatioSimilarity(aBox, bBox) {
  const aa = Math.max(Number(aBox.width || 0), 1e-9) / Math.max(Number(aBox.height || 0), 1e-9);
  const bb = Math.max(Number(bBox.width || 0), 1e-9) / Math.max(Number(bBox.height || 0), 1e-9);
  return clamp01(1 - Math.min(1, Math.abs(Math.log(aa / bb)) / Math.log(8)));
}

function structureSimilarity(aSvg, bSvg) {
  const objectCount = numericRatio(aSvg.objects?.length || 0, bSvg.objects?.length || 0);
  const groupCount = numericRatio(aSvg.groups?.length || 0, bSvg.groups?.length || 0);
  const viewBox = aspectRatioSimilarity(aSvg.viewBox || {}, bSvg.viewBox || {});
  const kinds = weightedJaccard(kindDistribution(aSvg), kindDistribution(bSvg));
  const paletteCount = numericRatio(colorBag(aSvg).size, colorBag(bSvg).size);
  return round(0.28 * objectCount + 0.12 * groupCount + 0.18 * viewBox + 0.30 * kinds + 0.12 * paletteCount);
}

function geometryTokenBag(svg) {
  const bag = new Map();
  for (const obj of svg.objects || []) {
    const geometry = obj.geometry || {};
    const box = geometry.bbox || {};
    const area = objectArea(obj);
    const length = geometry.pathLength || 0;
    const aspect = Math.max(box.width || 0, 1e-9) / Math.max(box.height || 0, 1e-9);
    const signature = (geometry.signature || [])
      .filter((_, index) => index % 4 === 0)
      .map((value) => Math.max(0, Math.min(9, Math.round(value * 12))))
      .join("");
    const key = [
      obj.kind || obj.tag,
      geometry.closed ? "closed" : "open",
      `ar${stableLogBucket(aspect)}`,
      `a${stableLogBucket(area)}`,
      `l${stableLogBucket(length)}`,
      `s${signature}`
    ].join(":");
    addWeighted(bag, key, objectWeight(obj));
  }
  return bag;
}

function tokenizedGeometrySimilarity(aSvg, bSvg) {
  return round(weightedJaccard(geometryTokenBag(aSvg), geometryTokenBag(bSvg)));
}

function documentFingerprint(svg, options = {}) {
  const maxObjects = Math.max(1, options.maxFingerprintObjects || 220);
  const maxGroups = Math.max(1, options.maxFingerprintGroups || 80);
  return {
    objectCount: svg.objects?.length || 0,
    groupCount: svg.groups?.length || 0,
    viewBox: svg.viewBox,
    palette: Object.fromEntries(colorBag(svg)),
    text: Object.fromEntries(textBag(svg)),
    geometryTokens: Object.fromEntries(geometryTokenBag(svg)),
    importantObjectKeys: selectImportantObjects(svg.objects || [], maxObjects).map((object) => object.key),
    importantGroupKeys: selectImportantObjects(svg.groups || [], maxGroups).map((object) => object.key)
  };
}

function compareDocumentFingerprints(aSvg, bSvg, options = {}) {
  const maxObjects = Math.max(1, options.maxFingerprintObjects || 220);
  const maxGroups = Math.max(1, options.maxFingerprintGroups || 80);
  const objects = weightedSoftObjectBagSimilarity(aSvg.objects || [], bSvg.objects || [], {
    maxObjects,
    threshold: options.fingerprintThreshold ?? 0.48
  });
  const groups = weightedSoftObjectBagSimilarity(aSvg.groups || [], bSvg.groups || [], {
    maxObjects: maxGroups,
    threshold: options.groupFingerprintThreshold ?? 0.45
  });
  const palette = paletteSimilarity(aSvg, bSvg);
  const text = round(weightedJaccard(textBag(aSvg), textBag(bSvg)));
  const structure = structureSimilarity(aSvg, bSvg);
  const geometryTokens = tokenizedGeometrySimilarity(aSvg, bSvg);
  const hasText = textBag(aSvg).size > 0 || textBag(bSvg).size > 0;
  const hasGroups = (aSvg.groups?.length || 0) > 0 || (bSvg.groups?.length || 0) > 0;
  const textWeight = hasText ? 0.12 : 0.04;
  const remaining = 1 - textWeight;
  const documentWeights = hasGroups
    ? { objects: 0.44, groups: 0.16, palette: 0.18, structure: 0.12, geometryTokens: 0.10 }
    : { objects: 0.52, groups: 0.00, palette: 0.18, structure: 0.12, geometryTokens: 0.18 };
  const score = clamp01(
    remaining * (
      documentWeights.objects * objects.score
        + documentWeights.groups * groups.score
        + documentWeights.palette * palette.score
        + documentWeights.structure * structure
        + documentWeights.geometryTokens * geometryTokens
    )
      + textWeight * text
  );

  return {
    score: round(score),
    percentage: Number((score * 100).toFixed(2)),
    breakdown: {
      objects: round(objects.score),
      objectAverage: round(objects.average),
      objectCoverageSmall: round(objects.coverageSmall),
      objectCoverageLarge: round(objects.coverageLarge),
      groups: round(groups.score),
      groupAverage: round(groups.average),
      palette: round(palette.score),
      paletteAverage: round(palette.average),
      text,
      structure,
      geometryTokens,
      matchedObjects: rawRound(objects.matched, 0),
      matchedGroups: rawRound(groups.matched, 0),
      groupComparisonEnabled: hasGroups,
      weights: documentWeights
    }
  };
}

function blendSimilarities(objectSimilarity, documentSimilarity, options = {}) {
  const profile = options.profile || "balanced";
  const weights = {
    exact: { object: 0.84, document: 0.16 },
    balanced: { object: 0.58, document: 0.42 },
    search: { object: 0.34, document: 0.66 }
  }[profile] || { object: 0.58, document: 0.42 };
  const objectScore = objectSimilarity?.score ?? 0;
  const documentScore = documentSimilarity?.score ?? 0;
  const score = weights.object * objectScore + weights.document * documentScore;
  return {
    score: round(score),
    percentage: Number((score * 100).toFixed(2)),
    grade: similarityGrade(score),
    profile,
    weights,
    objectSimilarity: round(objectScore),
    documentSimilarity: round(documentScore),
    breakdown: {
      ...(objectSimilarity?.breakdown || {}),
      documentObjects: documentSimilarity?.breakdown?.objects ?? 0,
      documentGroups: documentSimilarity?.breakdown?.groups ?? 0,
      documentPalette: documentSimilarity?.breakdown?.palette ?? 0,
      documentText: documentSimilarity?.breakdown?.text ?? 0,
      documentStructure: documentSimilarity?.breakdown?.structure ?? 0,
      documentGeometryTokens: documentSimilarity?.breakdown?.geometryTokens ?? 0
    }
  };
}

function similarityGrade(score) {
  if (score >= 0.98) return "near_identical";
  if (score >= 0.92) return "very_similar";
  if (score >= 0.80) return "similar";
  if (score >= 0.60) return "related_but_changed";
  if (score >= 0.35) return "weakly_similar";
  return "different";
}

return { documentFingerprint, compareDocumentFingerprints, blendSimilarities, similarityGrade };
})();

const Matcher = (() => {
const { colorDistance, detectPaletteRemaps, getColorSimilarity, normalizeColor } = Colors;
const { bboxCenter, bboxDiagonal, geometrySimilarity, classifyTransform } = Geometry;
const { blendSimilarities, compareDocumentFingerprints } = Fingerprint;
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const rows = s.length + 1;
  const cols = t.length + 1;
  const prev = Array.from({ length: cols }, (_, i) => i);
  const curr = Array.from({ length: cols }, () => 0);
  for (let i = 1; i < rows; i += 1) {
    curr[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < cols; j += 1) prev[j] = curr[j];
  }
  return prev[cols - 1];
}

function textSimilarity(a, b) {
  const ta = String(a || "");
  const tb = String(b || "");
  if (!ta && !tb) return 1;
  if (!ta || !tb) return 0;
  return 1 - levenshtein(ta, tb) / Math.max(ta.length, tb.length, 1);
}

function idSimilarity(a, b) {
  let score = 0;
  if (a.id && b.id && a.id === b.id) score += 0.7;
  if (a.key && b.key && a.key === b.key) score += 0.2;
  if (a.className && b.className && a.className === b.className) score += 0.1;
  return clamp01(score);
}

function numericStyleSimilarity(aRaw, bRaw) {
  const a = Number.parseFloat(aRaw ?? "0");
  const b = Number.parseFloat(bRaw ?? "0");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return aRaw === bRaw ? 1 : 0;
  if (a === b) return 1;
  const ratio = Math.min(Math.abs(a), Math.abs(b)) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return clamp01(ratio);
}

function colorSimilarity(a, b) {
  const ca = normalizeColor(a);
  const cb = normalizeColor(b);
  if (ca === cb) return 1;
  if (!ca || !cb) return 0.5;
  if (ca === "none" || cb === "none" || ca === "transparent" || cb === "transparent") return 0;
  return getColorSimilarity(ca, cb);
}

function arraySimilarity(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0.35;
  const keys = new Set([...left, ...right]);
  let same = 0;
  for (const key of keys) {
    if (left.includes(key) && right.includes(key)) same += 1;
  }
  return same / keys.size;
}

function effectSimilarity(a, b) {
  const ea = a.effects || {};
  const eb = b.effects || {};
  const opacity = numericStyleSimilarity(ea.opacity ?? a.style.opacity, eb.opacity ?? b.style.opacity);
  const filters = arraySimilarity(ea.filters, eb.filters);
  const clips = arraySimilarity(ea.clipPaths, eb.clipPaths);
  const masks = arraySimilarity(ea.masks, eb.masks);
  const blends = arraySimilarity(ea.blendModes, eb.blendModes);
  return 0.36 * opacity + 0.20 * filters + 0.18 * clips + 0.16 * masks + 0.10 * blends;
}

function styleSimilarity(a, b) {
  const fill = colorSimilarity(a.style.fill, b.style.fill);
  const stroke = colorSimilarity(a.style.stroke, b.style.stroke);
  const strokeWidth = numericStyleSimilarity(a.style.strokeWidth, b.style.strokeWidth);
  const opacity = numericStyleSimilarity(a.style.opacity, b.style.opacity);
  const fontSize = numericStyleSimilarity(a.style.fontSize, b.style.fontSize);
  const fontFamily = a.style.fontFamily === b.style.fontFamily ? 1 : 0.5;
  const effects = effectSimilarity(a, b);
  return 0.24 * fill + 0.18 * stroke + 0.15 * strokeWidth + 0.10 * opacity + 0.08 * fontSize + 0.08 * fontFamily + 0.17 * effects;
}

function positionSimilarity(a, b, globalDiagonal) {
  const ca = bboxCenter(a.geometry.bbox);
  const cb = bboxCenter(b.geometry.bbox);
  const d = Math.hypot(ca.x - cb.x, ca.y - cb.y);
  const norm = globalDiagonal || Math.max(bboxDiagonal(a.geometry.bbox), bboxDiagonal(b.geometry.bbox), 1);
  return clamp01(1 - d / norm);
}

function candidateScore(a, b, context) {
  const id = idSimilarity(a, b);
  const kind = a.kind === b.kind ? 1 : (a.tag === b.tag ? 0.8 : 0.35);
  const text = a.kind === "text" || b.kind === "text" ? textSimilarity(a.text, b.text) : 1;
  const style = styleSimilarity(a, b);
  const geometry = geometrySimilarity(a.geometry, b.geometry);
  const position = positionSimilarity(a, b, context.globalDiagonal);

  let score = 0.36 * geometry.score + 0.17 * style + 0.16 * id + 0.14 * text + 0.1 * kind + 0.07 * position;
  if ((a.kind === "text" || b.kind === "text") && text < 0.4 && id < 0.6) score *= 0.55;
  if (a.kind !== b.kind && id < 0.6 && geometry.score < 0.7) score *= 0.7;
  if (id < 0.2 && geometry.score < 0.35 && style < 0.7) score *= 0.65;
  if (id < 0.2 && geometry.score < 0.25) score *= 0.55;

  return { score, parts: { id, kind, text, style, geometry: geometry.score, position }, geometry };
}

function hungarianMin(cost) {
  const n = cost.length;
  const u = Array.from({ length: n + 1 }, () => 0);
  const v = Array.from({ length: n + 1 }, () => 0);
  const p = Array.from({ length: n + 1 }, () => 0);
  const way = Array.from({ length: n + 1 }, () => 0);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = Array.from({ length: n + 1 }, () => Infinity);
    const used = Array.from({ length: n + 1 }, () => false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j += 1) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = Array.from({ length: n }, () => -1);
  for (let j = 1; j <= n; j += 1) {
    if (p[j] > 0) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}

function matchSet(aObjects, bObjects, context, options = {}) {
  const threshold = options.threshold ?? 0.42;
  const n = Math.max(aObjects.length, bObjects.length, 1);
  const scores = Array.from({ length: aObjects.length }, () => Array.from({ length: bObjects.length }, () => null));
  for (let i = 0; i < aObjects.length; i += 1) {
    for (let j = 0; j < bObjects.length; j += 1) {
      scores[i][j] = candidateScore(aObjects[i], bObjects[j], context);
    }
  }

  const cost = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    if (i < aObjects.length && j < bObjects.length) return 1 - scores[i][j].score;
    return 1;
  }));
  const assignment = hungarianMin(cost);
  const matched = [];
  const usedB = new Set();
  const removed = [];

  for (let i = 0; i < aObjects.length; i += 1) {
    const j = assignment[i];
    if (j >= 0 && j < bObjects.length && scores[i][j].score >= threshold) {
      usedB.add(j);
      matched.push({ a: aObjects[i], b: bObjects[j], score: scores[i][j].score, parts: scores[i][j].parts, geometry: scores[i][j].geometry });
    } else {
      removed.push({ a: aObjects[i], b: null, score: 0 });
    }
  }

  const added = [];
  for (let j = 0; j < bObjects.length; j += 1) {
    if (!usedB.has(j)) added.push({ a: null, b: bObjects[j], score: 0 });
  }
  return { matched, added, removed };
}

function styleChanges(a, b) {
  const changes = [];
  const colorFields = ["fill", "stroke"];
  for (const field of colorFields) {
    const from = normalizeColor(a.style[field]);
    const to = normalizeColor(b.style[field]);
    if (from !== to) {
      changes.push({
        type: `${field}_changed`,
        field,
        from,
        to,
        deltaE: colorDistance(from, to),
        colorSimilarity: getColorSimilarity(from, to)
      });
    }
  }
  const numericFields = ["strokeWidth", "opacity", "fillOpacity", "strokeOpacity", "fontSize", "letterSpacing"];
  for (const field of numericFields) {
    const from = a.style[field] ?? "";
    const to = b.style[field] ?? "";
    if (String(from) !== String(to)) changes.push({ type: `${field}_changed`, field, from, to });
  }
  const textFields = ["fontFamily", "fontWeight", "fontStyle"];
  for (const field of textFields) {
    const from = a.style[field] ?? "";
    const to = b.style[field] ?? "";
    if (String(from) !== String(to)) changes.push({ type: `${field}_changed`, field, from, to });
  }
  const fromEffect = a.effects?.signature || "";
  const toEffect = b.effects?.signature || "";
  if (fromEffect !== toEffect) {
    changes.push({
      type: "cascaded_effect_changed",
      from: a.effects || null,
      to: b.effects || null,
      similarity: effectSimilarity(a, b)
    });
  }
  return changes;
}


function transformSimilarity(fit, globalDiagonal) {
  if (!fit || !Number.isFinite(fit.normalizedRms)) return 0;
  const d = fit.decomposition;
  const move = Math.hypot(d.translateX || 0, d.translateY || 0);
  const norm = Math.max(globalDiagonal || 1, 1);
  const moveSimilarity = clamp01(1 - Math.min(1, move / norm));
  const rotationSimilarity = clamp01(1 - Math.min(1, Math.abs(d.rotation || 0) / 180));
  const safeScaleX = Math.max(Math.abs(d.scaleX || 1), 1e-6);
  const safeScaleY = Math.max(Math.abs(d.scaleY || 1), 1e-6);
  const scaleDistance = (Math.abs(Math.log(safeScaleX)) + Math.abs(Math.log(safeScaleY))) / 2;
  const scaleSimilarity = clamp01(1 - Math.min(1, scaleDistance / Math.log(4)));
  const squeezeSimilarity = clamp01(1 - Math.min(1, Math.abs(Math.log(safeScaleX / safeScaleY)) / Math.log(4)));
  const skewSimilarity = clamp01(1 - Math.min(1, Math.abs(d.skewX || 0) / 45));
  const residualSimilarity = clamp01(1 - Math.min(1, fit.normalizedRms * 16));
  return 0.2 * moveSimilarity
    + 0.18 * rotationSimilarity
    + 0.18 * scaleSimilarity
    + 0.14 * squeezeSimilarity
    + 0.12 * skewSimilarity
    + 0.18 * residualSimilarity;
}

function colorPartSimilarity(a, b) {
  const fill = colorSimilarity(a.style.fill, b.style.fill);
  const stroke = colorSimilarity(a.style.stroke, b.style.stroke);
  return 0.58 * fill + 0.42 * stroke;
}

function sourceOrderSimilarity(a, b) {
  return (a.sourceIndex ?? 0) === (b.sourceIndex ?? 0) ? 1 : 0.85;
}

function computeMatchedSimilarity(item, context) {
  const parts = item.parts;
  const transform = transformSimilarity(item.geometry.fit, context.globalDiagonal);
  const color = colorPartSimilarity(item.a, item.b);
  const order = sourceOrderSimilarity(item.a, item.b);
  const score = clamp01(
    0.24 * parts.geometry
      + 0.18 * parts.style
      + 0.13 * parts.position
      + 0.13 * transform
      + 0.12 * parts.text
      + 0.08 * color
      + 0.06 * parts.kind
      + 0.04 * parts.id
      + 0.02 * order
  );
  return {
    score,
    parts: {
      geometry: parts.geometry,
      style: parts.style,
      color,
      position: parts.position,
      transform,
      text: parts.text,
      kind: parts.kind,
      id: parts.id,
      order
    }
  };
}

function objectAreaFromSummary(obj) {
  if (!obj) return 0;
  const box = obj.bbox || {};
  const bboxArea = Math.max(0, Number(box.width || 0)) * Math.max(0, Number(box.height || 0));
  const area = Math.max(0, Number(obj.area || 0));
  return Math.max(area, bboxArea);
}

function objectWeight(obj) {
  if (!obj) return 1;
  const area = objectAreaFromSummary(obj);
  const length = Math.max(0, Number(obj.pathLength || 0));
  const textBonus = obj.kind === "text" && obj.text ? String(obj.text).length * 4 : 0;
  return Math.max(1, Math.sqrt(area) + Math.sqrt(length) + textBonus);
}

function formatScore(value, digits = 6) {
  return Number(clamp01(value).toFixed(digits));
}

function similarityGrade(score) {
  if (score >= 0.98) return "near_identical";
  if (score >= 0.92) return "very_similar";
  if (score >= 0.80) return "similar";
  if (score >= 0.60) return "related_but_changed";
  if (score >= 0.35) return "weakly_similar";
  return "different";
}

function summarizeSimilarity(objects) {
  let totalWeight = 0;
  let matchedWeight = 0;
  let weightedScore = 0;
  const partSums = new Map();
  const partWeights = new Map();

  for (const item of objects) {
    const ref = item.b || item.a;
    const weight = objectWeight(ref);
    totalWeight += weight;
    if (item.status !== "added" && item.status !== "removed") {
      matchedWeight += weight;
      weightedScore += weight * (item.similarity?.score ?? 0);
      for (const [key, value] of Object.entries(item.similarity?.parts || {})) {
        partSums.set(key, (partSums.get(key) || 0) + weight * value);
        partWeights.set(key, (partWeights.get(key) || 0) + weight);
      }
    }
  }

  const score = totalWeight ? weightedScore / totalWeight : 1;
  const matchedAverage = matchedWeight ? weightedScore / matchedWeight : 0;
  const coverage = totalWeight ? matchedWeight / totalWeight : 1;
  const breakdown = {
    coverage: formatScore(coverage),
    matchedAverage: formatScore(matchedAverage)
  };

  for (const [key, sum] of partSums.entries()) {
    const weight = partWeights.get(key) || 0;
    breakdown[key] = weight ? formatScore(sum / weight) : 0;
  }

  return {
    score: formatScore(score),
    percentage: Number((score * 100).toFixed(2)),
    grade: similarityGrade(score),
    breakdown
  };
}

function classifyMatched(item, context) {
  const changes = [];
  const transformType = classifyTransform(item.geometry.fit);
  if (transformType !== "unchanged_geometry") changes.push({ type: transformType, fit: item.geometry.fit });
  if (item.a.kind === "text" || item.b.kind === "text") {
    if (item.a.text !== item.b.text) changes.push({ type: "text_changed", from: item.a.text, to: item.b.text, similarity: textSimilarity(item.a.text, item.b.text) });
  }
  changes.push(...styleChanges(item.a, item.b));
  if ((item.a.sourceIndex ?? 0) !== (item.b.sourceIndex ?? 0)) {
    changes.push({ type: "z_order_or_source_order_changed", from: item.a.sourceIndex, to: item.b.sourceIndex });
  }

  const status = changes.length ? "changed" : "unchanged";
  const similarity = computeMatchedSimilarity(item, context);
  return {
    status,
    changeTypes: [...new Set(changes.map((c) => c.type))],
    similarity: {
      score: formatScore(similarity.score),
      percentage: Number((similarity.score * 100).toFixed(2)),
      parts: Object.fromEntries(Object.entries(similarity.parts).map(([k, v]) => [k, formatScore(v)]))
    },
    a: summarizeObject(item.a),
    b: summarizeObject(item.b),
    matchScore: Number(item.score.toFixed(6)),
    matchParts: Object.fromEntries(Object.entries(item.parts).map(([k, v]) => [k, Number(v.toFixed(6))])),
    transform: item.geometry.fit ? {
      type: transformType,
      matrix: item.geometry.fit.matrix.map((v) => Number(v.toFixed(6))),
      decomposition: Object.fromEntries(Object.entries(item.geometry.fit.decomposition).map(([k, v]) => [k, Number(v.toFixed(6))])),
      rms: Number(item.geometry.fit.rms.toFixed(6)),
      normalizedRms: Number(item.geometry.fit.normalizedRms.toFixed(6)),
      reversed: item.geometry.fit.reversed,
      shift: item.geometry.fit.shift
    } : null,
    geometry: {
      score: Number(item.geometry.score.toFixed(6)),
      areaRatio: Number((item.geometry.areaRatio ?? 0).toFixed(6)),
      lengthRatio: Number((item.geometry.lengthRatio ?? 0).toFixed(6)),
      signatureDistance: Number((item.geometry.signatureDistance ?? 0).toFixed(6))
    },
    changes: changes.map((change) => compactChange(change))
  };
}

function compactChange(change) {
  if (change.fit) {
    return {
      type: change.type,
      matrix: change.fit.matrix.map((v) => Number(v.toFixed(6))),
      decomposition: Object.fromEntries(Object.entries(change.fit.decomposition).map(([k, v]) => [k, Number(v.toFixed(6))])),
      normalizedRms: Number(change.fit.normalizedRms.toFixed(6))
    };
  }
  if (change.deltaE !== undefined) {
    return {
      ...change,
      deltaE: Number(change.deltaE.toFixed(6)),
      colorSimilarity: change.colorSimilarity === undefined
        ? undefined
        : Number(change.colorSimilarity.toFixed(4))
    };
  }
  return change;
}

function summarizeObject(obj) {
  if (!obj) return null;
  return {
    key: obj.key,
    id: obj.id,
    tag: obj.tag,
    kind: obj.kind,
    className: obj.className,
    sourcePath: obj.sourcePath,
    sourceIndex: obj.sourceIndex,
    text: obj.text,
    bbox: Object.fromEntries(Object.entries(obj.geometry.bbox).map(([k, v]) => [k, Number(v.toFixed(6))])),
    centroid: Object.fromEntries(Object.entries(obj.geometry.centroid).map(([k, v]) => [k, Number(v.toFixed(6))])),
    area: Number(obj.geometry.area.toFixed(6)),
    pathLength: Number(obj.geometry.pathLength.toFixed(6)),
    style: obj.style,
    effects: obj.effects,
    flattening: obj.flattening,
    childKeys: obj.childKeys
  };
}

function summaryFromResults(items) {
  const summary = {
    unchanged: 0,
    changed: 0,
    added: 0,
    removed: 0,
    moved: 0,
    rotated: 0,
    scaled: 0,
    squeezed: 0,
    skewed: 0,
    geometryEdited: 0,
    textChanged: 0,
    colorChanged: 0,
    styleChanged: 0,
    zOrderChanged: 0
  };
  for (const item of items) {
    if (item.status === "added") summary.added += 1;
    if (item.status === "removed") summary.removed += 1;
    if (item.status === "unchanged") summary.unchanged += 1;
    if (item.status === "changed") summary.changed += 1;
    const types = item.changeTypes || [];
    if (types.some((t) => t.includes("moved"))) summary.moved += 1;
    if (types.some((t) => t.includes("rotated"))) summary.rotated += 1;
    if (types.some((t) => t.includes("scaled"))) summary.scaled += 1;
    if (types.includes("squeezed")) summary.squeezed += 1;
    if (types.includes("skewed")) summary.skewed += 1;
    if (types.includes("geometry_edited")) summary.geometryEdited += 1;
    if (types.includes("text_changed")) summary.textChanged += 1;
    if (types.some((t) => t === "fill_changed" || t === "stroke_changed")) summary.colorChanged += 1;
    if (types.some((t) => t.endsWith("_changed"))) summary.styleChanged += 1;
    if (types.includes("z_order_or_source_order_changed")) summary.zOrderChanged += 1;
  }
  return summary;
}

function compareParsedSvgs(aSvg, bSvg, options = {}) {
  const globalDiagonal = Math.max(
    bboxDiagonal({ minX: aSvg.viewBox.x, minY: aSvg.viewBox.y, maxX: aSvg.viewBox.x + aSvg.viewBox.width, maxY: aSvg.viewBox.y + aSvg.viewBox.height, width: aSvg.viewBox.width, height: aSvg.viewBox.height }),
    bboxDiagonal({ minX: bSvg.viewBox.x, minY: bSvg.viewBox.y, maxX: bSvg.viewBox.x + bSvg.viewBox.width, maxY: bSvg.viewBox.y + bSvg.viewBox.height, width: bSvg.viewBox.width, height: bSvg.viewBox.height }),
    1
  );
  const context = { globalDiagonal };
  const groupMatches = matchSet(aSvg.groups, bSvg.groups, context, { threshold: options.groupThreshold ?? 0.4 });
  const leafMatches = matchSet(aSvg.objects, bSvg.objects, context, { threshold: options.threshold ?? 0.42 });

  const matched = [...groupMatches.matched, ...leafMatches.matched].map((item) => classifyMatched(item, context));
  const zeroSimilarity = { score: 0, percentage: 0, parts: {} };
  const added = [...groupMatches.added, ...leafMatches.added].map((item) => ({ status: "added", changeTypes: ["added"], similarity: zeroSimilarity, a: null, b: summarizeObject(item.b), matchScore: 0, changes: [{ type: "added" }] }));
  const removed = [...groupMatches.removed, ...leafMatches.removed].map((item) => ({ status: "removed", changeTypes: ["removed"], similarity: zeroSimilarity, a: summarizeObject(item.a), b: null, matchScore: 0, changes: [{ type: "removed" }] }));
  const objects = [...matched, ...removed, ...added];
  const summary = summaryFromResults(objects);
  const objectSimilarity = summarizeSimilarity(objects);
  const documentSimilarity = compareDocumentFingerprints(aSvg, bSvg, options);
  summary.objectSimilarity = objectSimilarity;
  summary.documentSimilarity = documentSimilarity;
  summary.similarity = blendSimilarities(objectSimilarity, documentSimilarity, options);
  const paletteChanges = detectPaletteRemaps([...groupMatches.matched, ...leafMatches.matched]);

  return {
    meta: {
      algorithm: "flattened leaf-object SVG diff + tolerant document fingerprint",
      flattening: {
        enabled: true,
        groupTransformsAppliedToLeaves: true,
        cascadedGroupEffectsAppliedToLeaves: true,
        groupObjectsCompared: aSvg.groupComparisonEnabled || bSvg.groupComparisonEnabled || false
      },
      a: { objectCount: aSvg.objects.length, groupCount: aSvg.groups.length, viewBox: aSvg.viewBox },
      b: { objectCount: bSvg.objects.length, groupCount: bSvg.groups.length, viewBox: bSvg.viewBox },
      thresholds: { object: options.threshold ?? 0.42, group: options.groupThreshold ?? 0.4 },
      profile: options.profile || "balanced",
      fingerprint: {
        maxObjects: options.maxFingerprintObjects || 220,
        maxGroups: options.maxFingerprintGroups || 80,
        objectThreshold: options.fingerprintThreshold ?? 0.48,
        groupThreshold: options.groupFingerprintThreshold ?? 0.45
      }
    },
    summary,
    paletteChanges: paletteChanges.map((p) => ({
      ...p,
      deltaE: Number(p.deltaE.toFixed(6)),
      colorSimilarity: Number(p.colorSimilarity.toFixed(4)),
      consistency: Number(p.consistency.toFixed(6)),
      variants: p.variants.map((v) => ({
        field: v.field,
        from: v.from,
        to: v.to,
        count: v.count,
        deltaE: Number(v.deltaE.toFixed(6)),
        colorSimilarity: Number(v.colorSimilarity.toFixed(4)),
        objects: v.objects
      }))
    })),
    objects
  };
}

return { compareParsedSvgs };
})();

const Reporter = (() => {
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeSvg(svg) {
  return String(svg || "").replace(/<script[\s\S]*?<\/script>/gi, "");
}

function metricCard(label, value) {
  return `<div class="metric"><div class="metric-value">${escapeHtml(value)}</div><div class="metric-label">${escapeHtml(label)}</div></div>`;
}

function similarityCard(similarity) {
  const sim = similarity || { percentage: 0, grade: "unknown", breakdown: {} };
  return `<div class="metric primary"><div class="metric-value">${escapeHtml(sim.percentage)}%</div><div class="metric-label">Similarity · ${escapeHtml(sim.grade)}</div></div>`;
}

function similarityBreakdownTable(report) {
  const breakdown = report.summary?.similarity?.breakdown || {};
  const entries = Object.entries(breakdown);
  if (!entries.length) return `<p class="muted">No similarity breakdown available.</p>`;
  return `<table>
    <thead><tr><th>Component</th><th>Score</th><th>Percent</th></tr></thead>
    <tbody>${entries.map(([key, value]) => `<tr>
      <td>${escapeHtml(key)}</td>
      <td>${escapeHtml(Number(value).toFixed(6))}</td>
      <td>${escapeHtml((Number(value) * 100).toFixed(2))}%</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function swatch(color) {
  const safe = escapeHtml(color || "none");
  const bg = /^#[0-9a-f]{6}$/i.test(color || "") ? `style="background:${safe}"` : "";
  return `<span class="swatch" ${bg}></span><code>${safe}</code>`;
}

function paletteTable(report) {
  if (!report.paletteChanges.length) return `<p class="muted">No palette remaps detected.</p>`;
  return `<table>
    <thead><tr><th>Field</th><th>From</th><th>To</th><th>Consistency</th><th>Count</th><th>ΔE2000</th><th>Similarity</th></tr></thead>
    <tbody>${report.paletteChanges.map((p) => `<tr>
      <td>${escapeHtml(p.field)}</td>
      <td>${swatch(p.from)}</td>
      <td>${swatch(p.to)}</td>
      <td>${p.consistent ? "consistent" : "mixed"} · ${(p.consistency * 100).toFixed(1)}%</td>
      <td>${p.count}/${p.total}</td>
      <td>${p.deltaE}</td>
      <td>${p.colorSimilarity}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function objectRows(report) {
  return report.objects.map((obj, index) => {
    const a = obj.a;
    const b = obj.b;
    const statusClass = obj.status;
    const title = `${a?.key || "∅"} → ${b?.key || "∅"}`;
    const changeTypes = (obj.changeTypes || []).join(", ");
    const bbox = b?.bbox || a?.bbox || {};
    const text = b?.text || a?.text || "";
    return `<details class="row ${escapeHtml(statusClass)}" ${index < 20 ? "open" : ""}>
      <summary>
        <span class="pill ${escapeHtml(statusClass)}">${escapeHtml(obj.status)}</span>
        <strong>${escapeHtml(title)}</strong>
        <span class="muted">${escapeHtml(changeTypes)}</span>
        <span class="score">sim ${obj.similarity ? Number(obj.similarity.score).toFixed(3) : "0.000"} · match ${obj.matchScore ? Number(obj.matchScore).toFixed(3) : "0.000"}</span>
      </summary>
      <div class="details-grid">
        <div>
          <h4>A</h4>
          <pre>${escapeHtml(JSON.stringify(a, null, 2))}</pre>
        </div>
        <div>
          <h4>B</h4>
          <pre>${escapeHtml(JSON.stringify(b, null, 2))}</pre>
        </div>
        <div>
          <h4>Similarity</h4>
          <pre>${escapeHtml(JSON.stringify(obj.similarity, null, 2))}</pre>
          <h4>Changes</h4>
          <pre>${escapeHtml(JSON.stringify(obj.changes, null, 2))}</pre>
        </div>
        <div>
          <h4>Quick facts</h4>
          <p><b>BBox</b>: ${escapeHtml(JSON.stringify(bbox))}</p>
          ${text ? `<p><b>Text</b>: ${escapeHtml(text)}</p>` : ""}
          ${obj.transform ? `<p><b>Transform</b>: ${escapeHtml(obj.transform.type)}</p><pre>${escapeHtml(JSON.stringify(obj.transform.decomposition, null, 2))}</pre>` : ""}
        </div>
      </div>
    </details>`;
  }).join("\n");
}

function generateHtmlReport(report, aSvgText, bSvgText) {
  const s = report.summary;
  const svgA = sanitizeSvg(aSvgText);
  const svgB = sanitizeSvg(bSvgText);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SVG aware diff report</title>
<style>
  :root { color-scheme: light dark; --line:#8884; --muted:#777; --bg:#f7f7f8; --card:#fff; --text:#222; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --card:#1b1b1d; --text:#eee; --muted:#aaa; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
  h1, h2, h3 { margin: 0 0 12px; }
  section { margin: 0 0 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .metric, .card, details { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; box-shadow: 0 1px 4px #0001; }
  .metric-value { font-size: 28px; font-weight: 700; }
  .metric.primary { grid-column: span 2; border-width: 2px; }
  .metric.primary .metric-value { font-size: 42px; }
  .metric-label, .muted { color: var(--muted); }
  .preview { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .svgbox { height: 420px; overflow: auto; display: grid; place-items: center; background: repeating-conic-gradient(#9991 0% 25%, transparent 0% 50%) 50% / 24px 24px; border: 1px solid var(--line); border-radius: 8px; }
  .svgbox svg { max-width: 100%; max-height: 400px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; }
  th, td { border-bottom: 1px solid var(--line); padding: 8px; text-align: left; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; color: var(--muted); }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  pre { max-height: 360px; overflow: auto; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: #00000008; }
  details { margin: 8px 0; }
  summary { cursor: pointer; display: flex; gap: 10px; align-items: center; }
  .score { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
  .pill { display: inline-flex; align-items: center; min-width: 82px; justify-content: center; border-radius: 999px; padding: 2px 8px; font-size: 12px; border: 1px solid var(--line); }
  .pill.changed { background: #ffd54a33; }
  .pill.unchanged { background: #4caf5033; }
  .pill.added { background: #2196f333; }
  .pill.removed { background: #f4433633; }
  .details-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
  .swatch { display:inline-block; width:16px; height:16px; border:1px solid var(--line); border-radius:4px; vertical-align:middle; margin-right:6px; background: repeating-conic-gradient(#9995 0% 25%, transparent 0% 50%) 50% / 8px 8px; }
</style>
</head>
<body>
  <h1>SVG aware diff report</h1>
  <section class="grid">
    ${similarityCard(s.similarity)}
    ${metricCard("Object score", s.objectSimilarity ? `${s.objectSimilarity.percentage}%` : "—")}
    ${metricCard("Document score", s.documentSimilarity ? `${s.documentSimilarity.percentage}%` : "—")}
    ${metricCard("Profile", s.similarity?.profile || "balanced")}
    ${metricCard("Unchanged", s.unchanged)}
    ${metricCard("Changed", s.changed)}
    ${metricCard("Added", s.added)}
    ${metricCard("Removed", s.removed)}
    ${metricCard("Moved", s.moved)}
    ${metricCard("Rotated", s.rotated)}
    ${metricCard("Scaled", s.scaled)}
    ${metricCard("Squeezed", s.squeezed)}
    ${metricCard("Text changed", s.textChanged)}
    ${metricCard("Color changed", s.colorChanged)}
  </section>

  <section>
    <h2>Similarity breakdown</h2>
    ${similarityBreakdownTable(report)}
  </section>

  <section class="preview">
    <div class="card"><h2>A</h2><div class="svgbox">${svgA}</div></div>
    <div class="card"><h2>B</h2><div class="svgbox">${svgB}</div></div>
  </section>

  <section>
    <h2>Palette remaps</h2>
    ${paletteTable(report)}
  </section>

  <section>
    <h2>Objects</h2>
    ${objectRows(report)}
  </section>
</body>
</html>`;
}

return { generateHtmlReport };
})();

const ApiModule = (() => {
const { parseSvg } = SvgParser;
const { compareParsedSvgs } = Matcher;
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key])
      ? deepMerge(out[key], value)
      : value;
  }
  return out;
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTunings(tunings = {}) {
  const profile = tunings.profile || tunings.similarityProfile || "search";
  if (!["exact", "balanced", "search"].includes(profile)) {
    throw new Error(`Invalid profile "${profile}". Use exact, balanced, or search.`);
  }

  const thresholds = tunings.thresholds || {};
  const limits = tunings.limits || {};
  const fingerprint = tunings.fingerprint || {};

  return {
    profile,
    includeGroups: tunings.includeGroups === true,
    threshold: asNumber(tunings.threshold ?? thresholds.object, 0.42),
    groupThreshold: asNumber(tunings.groupThreshold ?? thresholds.group, 0.40),
    fingerprintThreshold: asNumber(tunings.fingerprintThreshold ?? thresholds.fingerprintObject ?? fingerprint.objectThreshold, 0.48),
    groupFingerprintThreshold: asNumber(tunings.groupFingerprintThreshold ?? thresholds.fingerprintGroup ?? fingerprint.groupThreshold, 0.45),
    maxFingerprintObjects: asNumber(tunings.maxFingerprintObjects ?? limits.maxFingerprintObjects ?? fingerprint.maxObjects, 220),
    maxFingerprintGroups: asNumber(tunings.maxFingerprintGroups ?? limits.maxFingerprintGroups ?? fingerprint.maxGroups, 80),
    resultDetail: tunings.resultDetail || "full",
    keepFailed: tunings.keepFailed === true,
    resolvePaths: tunings.resolvePaths !== false
  };
}

function uniqueCandidatePaths(originPath, candidatePaths, resolvePaths) {
  if (!Array.isArray(candidatePaths)) {
    throw new TypeError("candidatePaths must be an array of SVG file paths.");
  }

  const originComparable = resolvePaths ? path.resolve(originPath) : originPath;
  const seen = new Set();
  const out = [];

  for (const candidatePath of candidatePaths) {
    if (typeof candidatePath !== "string" || candidatePath.trim() === "") continue;
    const cleanPath = candidatePath.trim();
    const comparable = resolvePaths ? path.resolve(cleanPath) : cleanPath;
    if (comparable === originComparable || seen.has(comparable)) continue;
    seen.add(comparable);
    out.push(resolvePaths ? comparable : cleanPath);
  }
  return out;
}

function comparisonOptions(tunings) {
  return {
    profile: tunings.profile,
    includeGroups: tunings.includeGroups,
    threshold: tunings.threshold,
    groupThreshold: tunings.groupThreshold,
    fingerprintThreshold: tunings.fingerprintThreshold,
    groupFingerprintThreshold: tunings.groupFingerprintThreshold,
    maxFingerprintObjects: tunings.maxFingerprintObjects,
    maxFingerprintGroups: tunings.maxFingerprintGroups
  };
}

function compactReport(report) {
  return {
    meta: report.meta,
    summary: report.summary,
    paletteChanges: report.paletteChanges
  };
}

function rankingItem({ originPath, candidatePath, report, error, detail }) {
  if (error) {
    return {
      rank: null,
      originPath,
      candidatePath,
      error: error instanceof Error ? error.message : String(error),
      similarity: {
        score: 0,
        percentage: 0,
        grade: "error"
      }
    };
  }

  const base = {
    rank: null,
    originPath,
    candidatePath,
    similarity: report.summary.similarity,
    objectSimilarity: report.summary.objectSimilarity,
    documentSimilarity: report.summary.documentSimilarity,
    summary: report.summary,
    paletteChanges: report.paletteChanges,
    meta: report.meta
  };

  if (detail === "summary") return base;
  if (detail === "compact") return { ...base, comparison: compactReport(report) };
  return { ...base, comparison: report };
}

async function readSvgFile(filePath) {
  return fs.readFile(filePath, "utf8");
}

const DEFAULT_TUNINGS = Object.freeze(normalizeTunings());

class SvgSimilarityRanker {
  constructor(tunings = {}) {
    this.tunings = normalizeTunings(tunings);
  }

  withTunings(tunings = {}) {
    return new SvgSimilarityRanker(deepMerge(this.tunings, tunings));
  }

  async compareFiles(originPath, candidatePath) {
    const options = comparisonOptions(this.tunings);
    const [originText, candidateText] = await Promise.all([
      readSvgFile(originPath),
      readSvgFile(candidatePath)
    ]);
    const originSvg = parseSvg(originText, { includeGroups: options.includeGroups });
    const candidateSvg = parseSvg(candidateText, { includeGroups: options.includeGroups });
    return compareParsedSvgs(originSvg, candidateSvg, options);
  }

  async rankFiles(originPath, candidatePaths) {
    if (typeof originPath !== "string" || originPath.trim() === "") {
      throw new TypeError("originPath must be an SVG file path string.");
    }

    const resolvePaths = this.tunings.resolvePaths;
    const cleanOriginPath = resolvePaths ? path.resolve(originPath) : originPath.trim();
    const cleanCandidatePaths = uniqueCandidatePaths(cleanOriginPath, candidatePaths, resolvePaths);
    const options = comparisonOptions(this.tunings);
    const originText = await readSvgFile(cleanOriginPath);
    const originSvg = parseSvg(originText, { includeGroups: options.includeGroups });
    const results = [];

    for (const candidatePath of cleanCandidatePaths) {
      try {
        const candidateText = await readSvgFile(candidatePath);
        const candidateSvg = parseSvg(candidateText, { includeGroups: options.includeGroups });
        const report = compareParsedSvgs(originSvg, candidateSvg, options);
        results.push(rankingItem({
          originPath: cleanOriginPath,
          candidatePath,
          report,
          detail: this.tunings.resultDetail
        }));
      } catch (error) {
        if (this.tunings.keepFailed) {
          results.push(rankingItem({
            originPath: cleanOriginPath,
            candidatePath,
            error,
            detail: this.tunings.resultDetail
          }));
        } else {
          throw error;
        }
      }
    }

    results.sort((a, b) => {
      const diff = (b.similarity?.score ?? 0) - (a.similarity?.score ?? 0);
      if (diff !== 0) return diff;
      return String(a.candidatePath).localeCompare(String(b.candidatePath));
    });

    return results.map((item, index) => ({ ...item, rank: index + 1 }));
  }

  async rank(originPath, candidatePaths) {
    return this.rankFiles(originPath, candidatePaths);
  }
}

async function rankSvgFiles(originPath, candidatePaths, tunings = {}) {
  const ranker = new SvgSimilarityRanker(tunings);
  return ranker.rankFiles(originPath, candidatePaths);
}

return { DEFAULT_TUNINGS, SvgSimilarityRanker, rankSvgFiles };
})();

const { parseSvg } = SvgParser;
const { compareParsedSvgs } = Matcher;
const { generateHtmlReport } = Reporter;
const { documentFingerprint, compareDocumentFingerprints } = Fingerprint;
const { DEFAULT_TUNINGS, SvgSimilarityRanker, rankSvgFiles } = ApiModule;
const { normalizeColor, hexToRgb, hexToLab, deltaE2000, getColorSimilarity, colorDistance } = Colors;

function compareSvgTexts(aText, bText, options = {}) {
  const a = parseSvg(aText, { includeGroups: options.includeGroups === true });
  const b = parseSvg(bText, { includeGroups: options.includeGroups === true });
  return compareParsedSvgs(a, b, options);
}

function compareSvgTextsWithHtml(aText, bText, options = {}) {
  const report = compareSvgTexts(aText, bText, options);
  return { report, html: generateHtmlReport(report, aText, bText) };
}

function rankingItemFromText(baseName, candidate, report, detail) {
  const item = {
    rank: null,
    originPath: baseName,
    candidatePath: candidate.path ?? candidate.name ?? "candidate.svg",
    similarity: report.summary.similarity,
    objectSimilarity: report.summary.objectSimilarity,
    documentSimilarity: report.summary.documentSimilarity,
    summary: report.summary,
    paletteChanges: report.paletteChanges,
    meta: report.meta
  };
  if (detail === "summary") return item;
  if (detail === "compact") {
    return { ...item, comparison: { meta: report.meta, summary: report.summary, paletteChanges: report.paletteChanges } };
  }
  return { ...item, comparison: report };
}

function rankSvgTexts(baseText, candidates, options = {}) {
  const base = parseSvg(baseText, { includeGroups: options.includeGroups === true });
  const detail = options.resultDetail || "full";
  const results = [];
  for (const candidate of candidates || []) {
    const text = typeof candidate === "string" ? candidate : candidate.text;
    const parsed = parseSvg(text, { includeGroups: options.includeGroups === true });
    const report = compareParsedSvgs(base, parsed, options);
    results.push(rankingItemFromText("origin.svg", typeof candidate === "string" ? { path: "candidate.svg" } : candidate, report, detail));
  }
  results.sort((a, b) => {
    const diff = (b.similarity?.score ?? 0) - (a.similarity?.score ?? 0);
    if (diff !== 0) return diff;
    return String(a.candidatePath).localeCompare(String(b.candidatePath));
  });
  return results.map((item, index) => ({ ...item, rank: index + 1 }));
}

async function runMinimalCli() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: node svg-similarity-ranker.js origin.svg candidate1.svg [candidate2.svg ...]");
    process.exitCode = 2;
    return;
  }
  const [originPath, ...candidatePaths] = args;
  const results = await rankSvgFiles(originPath, candidatePaths, { profile: "search", resultDetail: "full" });
  console.log(JSON.stringify(results, null, 2));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  runMinimalCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

export {
  DEFAULT_TUNINGS,
  SvgSimilarityRanker,
  rankSvgFiles,
  rankSvgFiles as rankFiles,
  parseSvg,
  compareParsedSvgs,
  compareSvgTexts,
  compareSvgTextsWithHtml,
  rankSvgTexts,
  generateHtmlReport,
  documentFingerprint,
  compareDocumentFingerprints,
  normalizeColor,
  hexToRgb,
  hexToLab,
  deltaE2000,
  getColorSimilarity,
  colorDistance
};

export default SvgSimilarityRanker;
