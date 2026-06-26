/*
 * Flat ESLint config (ESLint v9+).
 *
 * The client still shares state across files via implicit globals + script
 * load order (R3 in the assessment is in progress), so `no-undef` is off
 * for now — turning it on before the DEJAVU-namespace migration would bury
 * real findings under hundreds of cross-file-global false positives.
 */
"use strict";

module.exports = [
    {
        files: ["client/js/**/*.js", "host/**/*.js", "*.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "script"
        },
        rules: {
            "no-undef": "off",
            "no-unused-vars": "warn",
            "prefer-const": "warn",
            "no-var": "off",
            "eqeqeq": ["warn", "smart"]
        }
    },
    {
        // core.js is self-contained (no cross-file globals), so it can hold
        // itself to the stricter no-undef bar the rest of the client can't yet.
        files: ["client/js/core.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "script",
            globals: {
                window: "readonly",
                globalThis: "readonly",
                module: "writable"
            }
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": "warn",
            "prefer-const": "warn",
            "eqeqeq": ["warn", "smart"]
        }
    },
    {
        files: ["host/host.jsx", "host/host.legacy.jsx"],
        languageOptions: {
            // ExtendScript is ES3 — don't flag legacy syntax in the CEP host.
            ecmaVersion: 5,
            sourceType: "script"
        },
        rules: {
            "no-undef": "off",
            "no-unused-vars": "off"
        }
    },
    {
        files: ["tests/**/*.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "commonjs"
        },
        rules: {
            "no-unused-vars": "warn"
        }
    }
];
