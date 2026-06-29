"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const HostContract = require("../client/js/host-contract.js");

test("host contract parses object UXP results", () => {
    assert.deepEqual(
        HostContract.parseUxpResult("dejavu_getHostVersion", {
            ok: true,
            version: "x"
        }),
        { ok: true, version: "x" }
    );
});

test("host contract parses string UXP JSON results", () => {
    assert.deepEqual(
        HostContract.parseUxpResult("dejavu_checkFolder", "{\"ok\":true}"),
        { ok: true }
    );
});

test("host contract reports bad UXP string responses", () => {
    assert.deepEqual(
        HostContract.parseUxpResult("dejavu_checkFolder", "not-json"),
        {
            ok: false,
            error: "Bad UXP host response for dejavu_checkFolder(): not-json"
        }
    );
});

test("host contract parses CEP evalScript JSON", () => {
    assert.deepEqual(
        HostContract.parseCepResult(
            "dejavu_getActiveDocInfo",
            "{\"ok\":true,\"hasDoc\":false}",
            false
        ),
        { ok: true, hasDoc: false }
    );
});

test("host contract marks missing CEP function as retryable once", () => {
    assert.deepEqual(
        HostContract.parseCepResult(
            "dejavu_newFunction",
            "Error 24: dejavu_newFunction is not a function",
            false
        ),
        {
            ok: false,
            retryMissingHostFunction: true,
            error: "Error 24: dejavu_newFunction is not a function"
        }
    );
    assert.deepEqual(
        HostContract.parseCepResult(
            "dejavu_newFunction",
            "Error 24: dejavu_newFunction is not a function",
            true
        ),
        {
            ok: false,
            error:
                "Bad host response for dejavu_newFunction(): Error 24: dejavu_newFunction is not a function"
        }
    );
});

test("host contract reports empty CEP evalScript results", () => {
    assert.deepEqual(
        HostContract.parseCepResult("dejavu_dejavu", "EvalScript error.", false),
        {
            ok: false,
            error:
                "ExtendScript call to dejavu_dejavu() failed (host.jsx may not be loaded, or the function threw). Raw response: EvalScript error."
        }
    );
});

test("host contract converts thrown errors", () => {
    assert.deepEqual(HostContract.fromThrown(new Error("boom")), {
        ok: false,
        error: "boom"
    });
});

test("host contract reports missing runtime functions clearly", () => {
    assert.deepEqual(
        HostContract.missingFunction("dejavu_closeDocument", "UXP host"),
        {
            ok: false,
            error: "UXP host function dejavu_closeDocument() is unavailable."
        }
    );
});
