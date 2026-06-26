/* Minimal CEP CSInterface fallback.
 * Prefer Adobe's official CSInterface.js when available, but this keeps the
 * panel working when the file was not bundled and window.__adobe_cep__ exists.
 */
(function (global) {
  "use strict";
  if (global.CSInterface) return;
  function CSInterface() {}
  CSInterface.prototype.evalScript = function evalScript(script, callback) {
    if (!global.__adobe_cep__ || typeof global.__adobe_cep__.evalScript !== "function") {
      throw new Error("CEP bridge unavailable: window.__adobe_cep__.evalScript is missing.");
    }
    global.__adobe_cep__.evalScript(script, callback || function () {});
  };
  CSInterface.prototype.getSystemPath = function getSystemPath(pathType) {
    if (global.__adobe_cep__ && typeof global.__adobe_cep__.getSystemPath === "function") {
      return global.__adobe_cep__.getSystemPath(pathType);
    }
    return "";
  };
  CSInterface.prototype.getHostEnvironment = function getHostEnvironment() {
    if (global.__adobe_cep__ && typeof global.__adobe_cep__.getHostEnvironment === "function") {
      try { return JSON.parse(global.__adobe_cep__.getHostEnvironment()); } catch (e) { return {}; }
    }
    return {};
  };
  CSInterface.prototype.getOSInformation = function getOSInformation() {
    if (global.__adobe_cep__ && typeof global.__adobe_cep__.getOSInformation === "function") {
      return global.__adobe_cep__.getOSInformation();
    }
    return (global.navigator && global.navigator.platform) || "unknown";
  };
  global.CSInterface = CSInterface;
})(this);
