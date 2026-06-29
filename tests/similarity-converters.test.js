"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Converters = require("../client/js/similarity/svg-similarity-converters.js");

const support = {
    embeddedSVG: true,
    ai2svg: true,
    inkscape: true,
    illustrator: true
};

test("converter planner keeps configured order and appends missing fallbacks", () => {
    assert.deepEqual(
        Converters.resolvePlan({
            prefer: ["embeddedSVG", "illustrator"],
            supported: support
        }),
        ["embeddedSVG", "illustrator", "ai2svg", "inkscape"]
    );
});

test("converter planner skips unsupported converters", () => {
    assert.deepEqual(
        Converters.resolvePlan({
            prefer: ["ai2svg", "inkscape"],
            supported: Object.assign({}, support, { ai2svg: false })
        }),
        ["inkscape", "illustrator"]
    );
});

test("converter planner expands auto to the default plan", () => {
    assert.deepEqual(
        Converters.resolvePlan({
            prefer: ["auto"],
            supported: support
        }),
        ["embeddedSVG", "ai2svg", "inkscape", "illustrator"]
    );
});

test("AI and PDF conversion plans skip embedded SVG probing", () => {
    assert.deepEqual(
        Converters.planForExtension(".ai", { supported: support }),
        ["ai2svg", "inkscape", "illustrator"]
    );
    assert.deepEqual(
        Converters.planForExtension(".pdf", { supported: support }),
        ["ai2svg", "inkscape", "illustrator"]
    );
});

test("EPS conversion stays Illustrator-only", () => {
    assert.deepEqual(
        Converters.planForExtension(".eps", { supported: support }),
        ["illustrator"]
    );
});
