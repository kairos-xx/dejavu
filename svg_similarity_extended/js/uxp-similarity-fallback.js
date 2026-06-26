(function (global) {
  "use strict";

  async function createUXPSimilarityApp(configObject) {
    var config = SVGSimilarityConfig.fromObject(configObject || {});
    var adapter = new SVGSimilarityUXPAdapter(config);
    var engine = new SVGSimilarityEngine(config.engine);
    var index = new SVGSimilarityIndex({ config: config, engine: engine, adapter: adapter });

    return {
      pickFolder: function () { return adapter.pickFolder(); },
      pickTargetVectorFile: function () { return adapter.pickTargetVectorFile(); },
      exportCurrentDocumentSVG: function () { return adapter.exportCurrentDocumentSVG(); },
      getCurrentDocumentInfo: function () { return adapter.getCurrentDocumentInfo(); },
      findSimilarToCurrentDocument: function (folderEntry, options) {
        return index.findSimilarToCurrentIllustratorDocument(folderEntry, options || config.index);
      },
      findSimilarSVGOnly: function (targetSVGText, folderEntry, options) {
        return index.findSimilarToSVGText(targetSVGText, folderEntry, options || config.index);
      },
      note: "UXP can process picked SVG files directly. Current-document export uses SVGSimilarityUXPHost.exportCurrentDocumentSVG when supplied, then tries the host DOM, then falls back to manual target-file picking. Current-document folder defaults require SVGSimilarityUXPHost.getCurrentDocumentInfo() or a host DOM exposing document path."
    };
  }

  global.createUXPSimilarityApp = createUXPSimilarityApp;
})(this);
