# Integration Notes

## Suggested extension flow

1. Load `config.json`.
2. Export the current Illustrator document to temporary SVG.
3. Build/update the disk cache for the selected search folder.
4. Convert candidate AI/PDF/EPS files to temporary SVG when needed.
5. Fingerprint all candidates.
6. Fast-rank candidates.
7. Deep-compare only the shortlist.
8. Render results with delta breakdown.

## Cache key

The CEP index cache uses path, size, and modified time. If a file changes, it is reprocessed automatically.

## Why direct AI/PDF/EPS comparison is not used

AI, PDF, and EPS can contain complex PostScript/PDF drawing instructions, placed assets, fonts, appearance stacks, effects, and private Illustrator data. A reliable direct parser is a large rendering engine. The robust extension strategy is to normalize through Illustrator or a known vector converter.


## Manifest files

CEP uses `CSXS/manifest.xml`. UXP uses `manifest.json`. Both are included. The CEP manifest enables Node.js and mixed context for recursive disk scanning. The UXP manifest requests local filesystem access and falls back to picker-based file access.

## Active document export

The placeholder error has been replaced by a bridge module:

```html
<script src="../js/svg-similarity-current-document.js"></script>
```

CEP works through `CSInterface` + `jsx/svg_similarity_bridge.jsx`.

UXP does not have a universally stable Illustrator SVG export surface across all builds, so the module supports an injectable host hook:

```js
window.SVGSimilarityUXPHost = {
  exportCurrentDocumentSVG: async function () {
    // Return SVG text for the current document.
  }
};
```

If that hook is missing, the UXP adapter tries a defensive host-DOM export. If unavailable, it fails with an actionable message and the UI can use `pickTargetVectorFile()` instead.


## CEP without global CSInterface

Some panels fail with `CEP CSInterface is not available` because the JavaScript helper was not bundled, even though the native CEP bridge exists. This package includes `lib/CSInterface.js`, which maps `CSInterface.evalScript()` to `window.__adobe_cep__.evalScript()` when possible. Load it before `svg-similarity-current-document.js` and `svg-similarity-adapters.js`.

If `window.__adobe_cep__` is also missing, the page is not executing as a CEP panel. In that case use the UXP/manual file fallback or fix the extension manifest/loading path.

## Rich result report

Every final result now includes `result.report`, designed for UI panels and diagnostics:

- `report.documents.a` and `report.documents.b`: path/name, size, modified date, canvas, bbox, element count, group count.
- `report.sizes`: canvas and content bbox for both documents.
- `report.dates`: raw and ISO modification dates where available.
- `report.counts`: element/group/sample counts.
- `report.elementTypes`: per-document primitive/type histograms.
- `report.elementMatching`: greedy individual element/group matching report with similar, changed, new, and removed counts.

CEP can fill candidate file size and modification dates from Node `fs.stat`. Current Illustrator document exports usually do not have an original file mtime unless you pass your own `targetMeta` when comparing a selected source file.

Example when comparing a manually chosen target SVG:

```js
index.findSimilarToSVGText(svgText, folderPath, {
  targetMeta: {
    name: "target.svg",
    path: "/Users/me/target.svg",
    sizeBytes: 12345,
    mtimeMs: 1782460800000
  }
});
```


## v6 debug default folder + path sampling notes

For debugging, the search folder input now auto-fills with the folder of the active Illustrator document when the document is saved on disk. CEP uses `SVGSim_getCurrentDocumentInfo()` from `jsx/svg_similarity_bridge.jsx`; UXP uses `window.SVGSimilarityUXPHost.getCurrentDocumentInfo()` when available, then tries the host DOM. Unsaved documents still require a manual folder.

The engine also adopted two useful ideas from the uploaded path-interpolator project: sampled points can be de-duplicated by minimum distance and optionally rounded/snapped before comparison. Configure this in `config.json` with `engine.pathSampleMinDistance` and `engine.pathSampleRoundToNearest`. This reduces noisy path samples in complex grouped documents and makes element matching more stable.

The cache was bumped to `.svg_similarity_cache_v6.json`; delete old `.svg_similarity_cache*.json` files before retesting.


### v9 cache

The cache file is now `.svg_similarity_cache_v9.json`. Remove older `.svg_similarity_cache*.json` files after upgrading.


## v10 temporary-document cleanup fix

This build fixes Illustrator state cleanup during AI/PDF/EPS conversion and current-document export:

- Converted candidate documents opened through Illustrator are always closed with `SaveOptions.DONOTSAVECHANGES`.
- The original document is captured before conversion and reactivated after each conversion attempt.
- The converter no longer closes the active document when the candidate path is the same file as the currently open Illustrator document. In that case, it exports the active document directly.
- Temporary SVG exports are deleted immediately after the CEP/Node side has read them.
- External-converter temporary SVGs from Inkscape, MuPDF, and Ghostscript are also deleted after reading or after conversion failure.
- The JSX bridge exposes `SVGSim_cleanupTempFile(path)` as a backup cleanup hook.

If Illustrator was previously left on a temporary document, restart Illustrator once, then use this build.


## Non-Illustrator conversion first

Version 11 tries `embeddedSVG`, `mutool`, `inkscape`, and `ghostscript` before Illustrator. This avoids opening candidate AI/PDF/EPS files whenever possible. To completely disable Illustrator candidate-file opening, set:

```json
"externalConverters": {
  "prefer": ["embeddedSVG", "mutool", "inkscape", "ghostscript"],
  "allowIllustratorFallback": false,
  "avoidIllustrator": true
}
```

Use `conversionConcurrency: 4` for external conversion-heavy workflows. Use `1` if many files still fall back to Illustrator.
