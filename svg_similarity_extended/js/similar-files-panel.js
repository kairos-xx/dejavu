(function (global) {
  "use strict";

  function createSimilarityApp(configUrl) {
    var configPromise = SVGSimilarityConfig.loadBrowser(configUrl || "../config.json").catch(function () {
      return SVGSimilarityConfig.defaults();
    });

    return configPromise.then(function (config) {
      var statusEl = document.getElementById("similar-status");
      var resultsEl = document.getElementById("similar-results");
      var folderEl = document.getElementById("search-folder");
      var weightsEl = document.getElementById("weights-json");

      if (weightsEl) weightsEl.value = JSON.stringify(config.engine.weights, null, 2);

      function setSearchFolderFromDocumentInfo(info) {
        if (!folderEl || !info || !info.folder || folderEl.value) return;
        folderEl.value = info.folder;
        if (statusEl) {
          statusEl.textContent = "Ready. Search folder defaulted to active document folder: " + info.folder;
        }
      }

      function autoFillSearchFolder() {
        var enabled = !config.ui || config.ui.defaultSearchFolderFromCurrentDocument !== false;
        if (!enabled || !folderEl || folderEl.value) return Promise.resolve(null);
        var c = SVGSimilarityConfig.fromObject(config);
        var index = new SVGSimilarityIndex({ config: c, onProgress: progress });
        return index.getCurrentDocumentInfo().then(function (info) {
          setSearchFolderFromDocumentInfo(info);
          return info;
        }).catch(function (error) {
          if (statusEl && !folderEl.value) {
            statusEl.textContent = "Ready. Could not auto-fill the search folder: " + ((error && error.message) || String(error)) + ". Save/open a document or set it manually.";
          }
          return null;
        });
      }

      function progress(evt) {
        if (!statusEl || !evt) return;
        if (evt.stage === "listed") statusEl.textContent = "Found " + evt.total + " candidate files.";
        else statusEl.textContent = evt.stage + " " + (evt.done || 0) + "/" + (evt.total || "?");
      }

      function currentConfig() {
        var c = SVGSimilarityConfig.fromObject(config);
        if (weightsEl && weightsEl.value.trim()) {
          try { c.engine.weights = JSON.parse(weightsEl.value); } catch (e) { throw new Error("Invalid weights JSON: " + e.message); }
        }
        return c;
      }


      function formatBytes(value) {
        if (!value) return "unknown size";
        var units = ["B", "KB", "MB", "GB"];
        var n = Number(value), idx = 0;
        while (n >= 1024 && idx < units.length - 1) { n /= 1024; idx += 1; }
        return (idx === 0 ? Math.round(n) : Math.round(n * 10) / 10) + " " + units[idx];
      }

      function formatCanvas(canvas) {
        if (!canvas) return "unknown";
        return Math.round(canvas.width * 100) / 100 + "×" + Math.round(canvas.height * 100) / 100;
      }

      function render(results) {
        if (!resultsEl) return;
        resultsEl.innerHTML = "";
        results.forEach(function (item) {
          var row = document.createElement("div");
          row.className = "similar-file-row";
          var score = Math.round(item.similarity * 1000) / 10;
          var report = item.report || {};
          var docs = report.documents || {};
          var counts = report.counts || {};
          var match = report.elementMatching || {};
          row.innerHTML =
            '<div class="similar-file-title"></div>' +
            '<div class="similar-file-meta"></div>' +
            '<div class="similar-file-parts"></div>' +
            '<div class="similar-file-report"></div>';
          row.querySelector(".similar-file-title").textContent = item.filePath;
          row.querySelector(".similar-file-meta").textContent = score + "% similar · delta " + item.delta.toFixed(4) + (item.meta && item.meta.converted ? " · converted from " + item.meta.format : "");
          row.querySelector(".similar-file-parts").textContent =
            "shape " + Math.round((1 - item.parts.geometryNormalized) * 100) +
            "% · placement " + Math.round((1 - item.parts.geometryRaw) * 100) +
            "% · bbox " + Math.round((1 - item.parts.bbox) * 100) +
            "% · color " + Math.round((1 - item.parts.fill) * 100) +
            "% · stroke " + Math.round((1 - item.parts.stroke) * 100) +
            "% · structure " + Math.round((1 - item.parts.structure) * 100) + "%";

          var b = docs.b || {};
          var bSize = formatBytes(b.sizeBytes);
          var bDate = b.modifiedAt ? b.modifiedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "unknown date";
          var canvasA = formatCanvas((docs.a || {}).canvas);
          var canvasB = formatCanvas(b.canvas);
          row.querySelector(".similar-file-report").innerHTML =
            '<div><strong>Elements:</strong> ' +
            (match.matchedSimilar || 0) + ' similar · ' +
            (match.matchedChanged || 0) + ' changed · ' +
            (match.newInB || 0) + ' new · ' +
            (match.removedFromA || 0) + ' removed</div>' +
            '<div><strong>Document size:</strong> A ' + canvasA + ' · B ' + canvasB + '</div>' +
            '<div><strong>File B:</strong> ' + bSize + ' · modified ' + bDate + '</div>' +
            '<div><strong>Counts:</strong> A ' + (counts.aElements || 0) + ' elements / ' + (counts.aGroups || 0) + ' groups · B ' + (counts.bElements || 0) + ' elements / ' + (counts.bGroups || 0) + ' groups</div>';
          resultsEl.appendChild(row);
        });
      }

      function runFromCurrentDocument() {
        var c = currentConfig();
        var index = new SVGSimilarityIndex({ config: c, onProgress: progress });
        return autoFillSearchFolder().then(function () {
          var folder = folderEl && folderEl.value ? folderEl.value : null;
          if (!folder) throw new Error("Set a search folder first, or save/open the current document so its folder can be used automatically.");
          if (statusEl) statusEl.textContent = "Exporting current document...";
          return index.findSimilarToCurrentIllustratorDocument(folder, c.index).then(function (results) {
            if (statusEl) statusEl.textContent = "Done. " + results.length + " results.";
            render(results);
            return results;
          });
        });
      }

      function runFromSVGText(svgText, folder) {
        var c = currentConfig();
        var index = new SVGSimilarityIndex({ config: c, onProgress: progress });
        return index.findSimilarToSVGText(svgText, folder, c.index).then(function (results) { render(results); return results; });
      }

      var btn = document.getElementById("find-similar-button");
      if (btn) btn.addEventListener("click", function () { Promise.resolve().then(runFromCurrentDocument).catch(function (e) { if (statusEl) statusEl.textContent = e.message || String(e); }); });

      autoFillSearchFolder();

      return { config: config, runFromCurrentDocument: runFromCurrentDocument, runFromSVGText: runFromSVGText, render: render, autoFillSearchFolder: autoFillSearchFolder };
    });
  }

  global.createSimilarityApp = createSimilarityApp;
})(this);
