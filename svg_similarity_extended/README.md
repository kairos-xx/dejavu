# SVG Similarity Extended

A host-ready vector similarity system for Illustrator extensions.

It accepts:

- SVG
- SVGZ in CEP/Node
- PDF through embedded SVG extraction, MuPDF, Inkscape, Ghostscript, or Illustrator fallback
- AI through PDF-compatible direct conversion when possible, Inkscape, or Illustrator fallback
- EPS through embedded SVG extraction, Inkscape, Ghostscript, or Illustrator fallback

The comparison engine works from normalized SVG. For non-SVG files, the package now tries non-Illustrator normalization first. Illustrator opening/export is only the final fallback. PDF-compatible `.ai` files usually start with `%PDF-` and can often be converted by MuPDF or Inkscape without opening the file in Illustrator.

## Files

```txt
config.json
schemas/svg-similarity-config.schema.json
lib/CSInterface.js
js/svg-similarity-config.js
js/svg-similarity-engine.js
js/svg-similarity-adapters.js
js/svg-similarity-env.js
js/svg-similarity-current-document.js
js/svg-similarity-index.js
js/similar-files-panel.js
js/uxp-similarity-fallback.js
jsx/svg_similarity_bridge.jsx
css/similar-files.css
example/index.html
MANIFEST_SNIPPET.xml
```

## What is compared

The engine compares many layers, then combines them through configurable weights:

- canvas size and aspect ratio
- element type distribution
- hierarchy/depth structure
- raw geometry
- translation/scale/rotation-normalized geometry
- extra 90/180/270 degree rotation matching
- bounding boxes
- fills
- strokes
- stroke widths
- opacity
- path command signatures
- primitive numeric signatures
- curvature signature
- complexity metrics
- image usage
- text usage
- defs/symbol/pattern usage
- gradient usage

The final result contains both `delta` and `similarity`:

```js
{
  delta: 0.12,
  similarity: 0.88,
  parts: {
    geometryNormalized: 0.04,
    fill: 0,
    stroke: 0.18
  }
}
```

## Configurable weights

Edit `config.json`:

```json
"weights": {
  "geometryNormalized": 0.31,
  "geometryRaw": 0.13,
  "fill": 0.075,
  "stroke": 0.065,
  "pathCommands": 0.055
}
```

Increasing a weight makes that signal more important. Set a weight to `0` to ignore it.

## CEP setup

Load these scripts in your panel. `lib/CSInterface.js` is a small fallback wrapper; it creates `window.CSInterface` from `window.__adobe_cep__` when Adobe's official CSInterface library was not bundled.

```html
<script src="./lib/CSInterface.js"></script>
<script src="./js/svg-similarity-config.js"></script>
<script src="./js/svg-similarity-engine.js"></script>
<script src="./js/svg-similarity-current-document.js"></script>
<script src="./js/svg-similarity-adapters.js"></script>
<script src="./js/svg-similarity-env.js"></script>
<script src="./js/svg-similarity-index.js"></script>
<script src="./js/similar-files-panel.js"></script>
```

Load the JSX bridge once from CEP, for example:

```js
var cs = new CSInterface();
cs.evalScript('$.evalFile("' + extensionRoot + '/jsx/svg_similarity_bridge.jsx")');
```

Your `manifest.xml` dispatch info needs Node access:

```xml
<CEFCommandLine>
    <Parameter>--enable-nodejs</Parameter>
    <Parameter>--mixed-context</Parameter>
    <Parameter>--allow-file-access</Parameter>
</CEFCommandLine>
```

Then run:

```js
createSimilarityApp('./config.json');
```

or programmatically:

```js
SVGSimilarityConfig.loadBrowser('./config.json').then(function (config) {
  var index = new SVGSimilarityIndex({ config: config });
  return index.findSimilarToCurrentIllustratorDocument('/path/to/library', config.index);
}).then(function (results) {
  console.log(results);
});
```


### When `CSInterface` is missing

The package no longer requires the global `CSInterface` constructor. In CEP it now checks both:

```js
window.CSInterface
window.__adobe_cep__.evalScript
```

So the bridge still works when `CSInterface.js` was not included. The file `lib/CSInterface.js` is bundled as a minimal fallback and is loaded by `example/index.html`. If both `CSInterface` and `window.__adobe_cep__` are missing, the panel is not running inside CEP and current-document export must use the UXP/manual target-file fallback.

## UXP fallback

UXP does not expose normal Node `fs`, `child_process`, or CEP `evalScript`. The included UXP fallback can:

- pick a folder through UXP storage APIs
- recursively list entries
- read SVG files
- fingerprint and compare SVGs

For AI/PDF/EPS in UXP, you need one of these:

1. host-specific Illustrator UXP APIs to export/open files as SVG, when available in your target Illustrator version;
2. a small local helper process;
3. a CEP bridge if your product ships both extension types;
4. user-provided SVG exports.

Example:

```js
const app = await createUXPSimilarityApp(configObject);
const folder = await app.pickFolder();
const results = await app.findSimilarSVGOnly(targetSVGText, folder);
```

## Parallel processing

The indexer uses staged pools:

- file listing is recursive and fast;
- conversion is pooled through `conversionConcurrency`;
- fingerprinting is pooled through `fingerprintConcurrency`.

Default conversion concurrency is `4` because the default order uses external converters before Illustrator. If most candidates fall back to Illustrator, reduce `conversionConcurrency` to `1` because Illustrator should not be driven with multiple simultaneous document opens.

```json
"index": {
  "ioConcurrency": 12,
  "conversionConcurrency": 4,
  "fingerprintConcurrency": 1
}
```

SVG path length sampling depends on browser SVG DOM APIs. Because of that, fingerprinting is safest on the panel DOM thread. Do not move it to a plain Node worker unless you replace sampling with a pure JS path parser/flattening implementation.

## Conversion order

Configured here:

```json
"externalConverters": {
  "enabled": true,
  "prefer": ["embeddedSVG", "mutool", "inkscape", "ghostscript", "illustrator"],
  "allowIllustratorFallback": true,
  "avoidIllustrator": false,
  "tryMutoolForEPS": false
}
```

The CEP adapter tries converters in this order. `embeddedSVG`, `mutool`, `inkscape`, and `ghostscript` do not open files in Illustrator. Illustrator conversion uses `jsx/svg_similarity_bridge.jsx` and is now only the last fallback by default. Set `avoidIllustrator: true` to completely disable opening candidate files in Illustrator.


## Avoid opening candidate files in Illustrator

For debug and safety, you can prevent candidate `.ai/.pdf/.eps` files from ever being opened by Illustrator:

```json
"externalConverters": {
  "enabled": true,
  "prefer": ["embeddedSVG", "mutool", "inkscape", "ghostscript"],
  "allowIllustratorFallback": false,
  "avoidIllustrator": true
}
```

With this mode, unsupported files are skipped with an error instead of being opened. This is the safest mode for large folders. The current active Illustrator document is still exported normally as the target.

## Recommended thresholds

```txt
90%+  near duplicate
75%+  similar
55%+  loose match
```

## Notes and limitations

- AI/PDF/EPS are not fully parsed directly by JavaScript. The package first tries embedded SVG extraction and external non-Illustrator conversion. Illustrator is only needed for files that cannot be normalized externally, especially old/non-PDF-compatible `.ai` files.
- Appearance may differ depending on the converter. Illustrator export is usually the most faithful for `.ai`.
- Raster images inside SVG/PDF/AI/EPS are compared by placement/bounding box, not pixels.
- Fonts may affect text geometry after conversion if the font is missing.
- PDF pages: most converters use the first page or generate multiple outputs depending on converter; for multi-page PDFs, pre-split or extend the converter wrapper.


## Manifests and icons

This package now includes both extension manifest styles:

- `CSXS/manifest.xml` for CEP panels.
- `manifest.cep.xml` as a root-level copy of the same CEP manifest for easier inspection.
- `manifest.json` for UXP panels.

Icons are in `icons/` and include SVG plus PNG sizes:

- `icon.svg`, `icon-light.svg`, `icon-dark.svg`
- `icon-16.png`, `icon-23.png`, `icon-32.png`, `icon-46.png`, `icon-48.png`, `icon-64.png`, `icon-128.png`, `icon-256.png`
- dark variants such as `icon-23-dark.png` and `icon-48-dark.png`

The SVG icons intentionally use only simple paths, rectangles, fills, and strokes. They avoid masks, gradients, CSS animation, embedded styles, filters, and grayscale profiles so they are safer for Adobe CEP/UXP icon renderers.

### CEP placement

For CEP, keep the folder structure exactly like this:

```txt
YourExtension/
  CSXS/manifest.xml
  example/index.html
  js/
  jsx/
  css/
  icons/
  config.json
```

On macOS the development install folder is usually:

```txt
~/Library/Application Support/Adobe/CEP/extensions/
```

### UXP placement

For UXP, the root manifest is:

```txt
YourExtension/manifest.json
```

The UXP manifest points to:

```txt
uxp/index.html
```

UXP has a stricter filesystem model than CEP. The included UXP fallback directly supports picked SVG files/folders. AI/PDF/EPS conversion needs host-side support or an external helper because UXP cannot freely scan arbitrary disk paths like CEP with Node enabled.

## Current document export bridge

The package now includes `js/svg-similarity-current-document.js`.

Resolution order:

1. CEP: calls `CSInterface.evalScript("SVGSim_exportCurrentDocumentAsTempSVG()")`, then reads the temporary SVG with Node `fs`.
2. UXP: calls `window.SVGSimilarityUXPHost.exportCurrentDocumentSVG()` when your host implementation provides it.
3. UXP experimental fallback: tries a host DOM export API if the running Illustrator UXP build exposes one.
4. Manual fallback: use `pickTargetVectorFile()` to compare against a user-picked SVG/AI/PDF/EPS target instead of the unsaved active document.

For production Illustrator support, CEP remains the most reliable active-document export path because Illustrator ExtendScript exposes `ExportOptionsSVG` and document SVG export.

## Fix note: false 100% matches

If every file is shown as `100% similar · delta 0.0000`, delete old caches named
any `.svg_similarity_cache*.json` files from older package versions. This package writes
`.svg_similarity_cache_v6.json` and rejects stale/empty fingerprints.

The main cause was the hidden offscreen SVG measurement host. In some Adobe/CEF
contexts, `visibility:hidden` was inherited by the imported SVG, so all drawable
elements were filtered out as hidden. Empty fingerprint vs empty fingerprint then
scored as a false perfect match. The engine now keeps the measurement host
visible but offscreen, ignores only explicitly hidden source elements, and samples
basic primitives manually (`rect`, `circle`, `ellipse`, `line`, `polyline`,
`polygon`) instead of relying only on `getTotalLength()`.

For debugging, inspect each result summary. A valid SVG should have:

```txt
elementCount > 0
sampledPointCount > 0
```

If either is zero for a normal vector file, the host environment is not exposing
usable SVG geometry and the converter/export path should be checked.


## Scoring model v4

Version 4 defaults to asset similarity rather than page-layout similarity. This means moved or rotated copies of the same artwork remain highly similar. Placement is still reported separately as `geometryRaw`, and bounding-box size is still considered through `bbox`.

Color comparison now compares palette proportions instead of raw element counts, so one white circle and many white rectangles do not become “different colors” only because the element count differs. Shape/type/structure still penalize those cases.

Delete older cache files after upgrading:

```bash
find /path/to/search -name ".svg_similarity_cache*.json" -delete
```

## v6 richer comparison reports

The result object now includes `result.report` in addition to `delta`, `similarity`, `parts`, and `summary`.

```js
{
  documents: {
    a: {
      name: "Current document",
      path: null,
      sizeBytes: null,
      modifiedAt: null,
      canvas: { width: 100, height: 100 },
      elementCount: 42,
      groupCount: 8
    },
    b: {
      name: "candidate.ai",
      path: "/path/to/candidate.ai",
      sizeBytes: 48120,
      modifiedAt: "2026-06-26T08:30:00.000Z",
      canvas: { width: 100, height: 100 },
      elementCount: 44,
      groupCount: 9,
      converted: true,
      format: "ai"
    }
  },
  elementMatching: {
    totalA: 50,
    totalB: 53,
    matchedSimilar: 47,
    matchedChanged: 2,
    newInB: 4,
    removedFromA: 1,
    avgMatchedSimilarity: 0.94,
    matchedElements: [],
    changedElements: [],
    newElements: [],
    removedElements: []
  }
}
```

The element matcher now fingerprints individual drawable elements and groups. It compares tag type, local normalized geometry, bbox size/proportion, style, command structure, hierarchy depth, and group child type histograms. This makes the system more useful for complex Illustrator documents with many groups, nested elements, text, images, masks, clipping paths, symbols, and converted AI/PDF/EPS content.

Config additions:

```json
{
  "engine": {
    "elementMatchThreshold": 0.42,
    "reportSampleLimit": 24
  },
  "ui": {
    "showElementReport": true,
    "showFileMetadata": true
  }
}
```

Cache version changed to `.svg_similarity_cache_v6.json`. Delete older cache files when testing a new scoring/report version:

```bash
find /path/to/search/folder -name ".svg_similarity_cache*.json" -delete
```


## v6 debug default folder + path sampling notes

For debugging, the search folder input now auto-fills with the folder of the active Illustrator document when the document is saved on disk. CEP uses `SVGSim_getCurrentDocumentInfo()` from `jsx/svg_similarity_bridge.jsx`; UXP uses `window.SVGSimilarityUXPHost.getCurrentDocumentInfo()` when available, then tries the host DOM. Unsaved documents still require a manual folder.

The engine also adopted two useful ideas from the uploaded path-interpolator project: sampled points can be de-duplicated by minimum distance and optionally rounded/snapped before comparison. Configure this in `config.json` with `engine.pathSampleMinDistance` and `engine.pathSampleRoundToNearest`. This reduces noisy path samples in complex grouped documents and makes element matching more stable.

The cache was bumped to `.svg_similarity_cache_v6.json`; delete old `.svg_similarity_cache*.json` files before retesting.


## v8 fix: ExtendScript without JSON

Some Illustrator/ExtendScript hosts do not expose a global `JSON` object. The
CEP bridge now includes internal `SVGSim_jsonStringify` and `SVGSim_jsonParse`
fallbacks, so `SVGSim_getCurrentDocumentInfo()` and
`SVGSim_exportCurrentDocumentAsTempSVGWithInfo()` always return parseable JSON
objects instead of failing with `JSON is undefined`.


## v9 fix

- Fixed `this.cleanSamplePoints is not a function` by adding the missing
  sample cleanup helper used by `pathSampleMinDistance` and
  `pathSampleRoundToNearest`.
- Fingerprint/cache version bumped to v9. Delete older caches before testing:

```bash
find /Users/joaolopes/Downloads/t -name ".svg_similarity_cache*.json" -delete
```


## v10 temporary-document cleanup fix

This build fixes Illustrator state cleanup during AI/PDF/EPS conversion and current-document export:

- Converted candidate documents opened through Illustrator are always closed with `SaveOptions.DONOTSAVECHANGES`.
- The original document is captured before conversion and reactivated after each conversion attempt.
- The converter no longer closes the active document when the candidate path is the same file as the currently open Illustrator document. In that case, it exports the active document directly.
- Temporary SVG exports are deleted immediately after the CEP/Node side has read them.
- External-converter temporary SVGs from Inkscape, MuPDF, and Ghostscript are also deleted after reading or after conversion failure.
- The JSX bridge exposes `SVGSim_cleanupTempFile(path)` as a backup cleanup hook.

If Illustrator was previously left on a temporary document, restart Illustrator once, then use this build.
