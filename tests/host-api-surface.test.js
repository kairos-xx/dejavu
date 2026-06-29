"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");

const readClientScripts = () => {
    const dir = path.join(root, "client", "js");
    return fs.readdirSync(dir)
        .filter((name) => name.endsWith(".js"))
        .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
        .join("\n");
};

const uniqueMatches = (text, pattern, groupIndex) =>
    [...new Set([...text.matchAll(pattern)].map((match) => match[groupIndex]))]
        .sort();

test("UXP host surface covers client callHost calls", () => {
    const clientCalls = uniqueMatches(
        readClientScripts(),
        /callHost\("([^"]+)"/g,
        1
    );
    const hostApi = new Set(uniqueMatches(
        fs.readFileSync(path.join(root, "host", "host.js"), "utf8"),
        /\b(dejavu_[A-Za-z0-9_]+)\b/g,
        1
    ));
    const missing = clientCalls.filter((name) => !hostApi.has(name));
    assert.deepEqual(missing, []);
});
