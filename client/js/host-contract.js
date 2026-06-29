/*
 * DejaVu — host bridge response contract.
 *
 * The transport can be CEP evalScript or UXP direct calls, but callers should
 * receive the same object-shaped result either way.
 */
(function (root) {
    "use strict";

    const EMPTY_CEP_RESULTS = {
        undefined: true,
        "EvalScript error.": true
    };

    const missingFunctionPattern = /is not a function|Error 24/i;

    const errorResult = (message) => ({
        ok: false,
        error: message
    });

    const messageOf = (error) =>
        String(error && error.message ? error.message : error);

    const parseJson = (value) => JSON.parse(String(value));

    const parseUxpResult = (fnName, result) => {
        if (typeof result === "string") {
            try {
                return parseJson(result);
            } catch (error) {
                return errorResult(
                    `Bad UXP host response for ${fnName}(): ${result}`
                );
            }
        }
        return result || { ok: true };
    };

    const parseCepResult = (fnName, result, retried) => {
        if (
            result === undefined ||
            result === null ||
            Object.prototype.hasOwnProperty.call(EMPTY_CEP_RESULTS, result)
        ) {
            return errorResult(
                `ExtendScript call to ${fnName}() failed (host.jsx may not be loaded, or the function threw). Raw response: ${String(result)}`
            );
        }
        try {
            return parseJson(result);
        } catch (error) {
            if (!retried && missingFunctionPattern.test(String(result))) {
                return {
                    ok: false,
                    retryMissingHostFunction: true,
                    error: String(result)
                };
            }
            return errorResult(`Bad host response for ${fnName}(): ${result}`);
        }
    };

    const fromThrown = (error) => errorResult(messageOf(error));

    const missingFunction = (fnName, runtime) => errorResult(
        `${runtime || "Host"} function ${fnName}() is unavailable.`
    );

    const contract = {
        parseUxpResult,
        parseCepResult,
        fromThrown,
        missingFunction
    };

    root.DejaVuHostContract = contract;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = contract;
    }
})(typeof window !== "undefined" ? window : globalThis);
