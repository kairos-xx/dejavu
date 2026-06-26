"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const DEJAVU = require("../client/js/core.js");

test("formatBytes", () => {
    assert.equal(DEJAVU.formatBytes(0), "0 KB");
    assert.equal(DEJAVU.formatBytes(-5), "0 KB");
    assert.equal(DEJAVU.formatBytes(512), "1 KB"); // rounds 0.5 KB up
    assert.equal(DEJAVU.formatBytes(1024), "1 KB");
    assert.equal(DEJAVU.formatBytes(1024 * 1024), "1.0 MB");
    assert.equal(DEJAVU.formatBytes(3.4 * 1024 * 1024), "3.4 MB");
});

test("intervalToMs", () => {
    assert.equal(DEJAVU.intervalToMs(2, 60), 120000); // 2 minutes
    assert.equal(DEJAVU.intervalToMs(30, 1), 30000); // 30 seconds
    assert.equal(DEJAVU.intervalToMs(1, 3600), 3600000); // 1 hour
    assert.equal(DEJAVU.intervalToMs(0, 60), 60000); // value floored to 1
    assert.equal(DEJAVU.intervalToMs("5", "60"), 300000); // string inputs
    assert.equal(DEJAVU.intervalToMs(NaN, NaN), 60000); // defaults: 1 * 60
});

test("collapseSlashes", () => {
    assert.equal(DEJAVU.collapseSlashes("/a//b///c"), "/a/b/c");
    assert.equal(DEJAVU.collapseSlashes("a/b"), "a/b");
    assert.equal(DEJAVU.collapseSlashes(""), "");
});

test("resolveFolderTemplate — default template", () => {
    assert.equal(
        DEJAVU.resolveFolderTemplate("$defaultFolder/$filename", {
            $defaultFolder: "/Users/joaolopes",
            $filename: "Untitled-6"
        }),
        "/Users/joaolopes/Untitled-6"
    );
});

test("resolveFolderTemplate — collapses trailing-slash root (no //)", () => {
    // resolveTildePath("~/") yields a trailing slash; the leaf must not double.
    assert.equal(
        DEJAVU.resolveFolderTemplate("$defaultFolder/$filename", {
            $defaultFolder: "/Users/joaolopes/",
            $filename: "Untitled-6"
        }),
        "/Users/joaolopes/Untitled-6"
    );
});

test("resolveFolderTemplate — does NOT double the leaf (regression)", () => {
    // The status bug: $defaultFolder must be the *default* folder, not the
    // already-resolved per-document folder. Given the correct default folder
    // there is exactly one leaf segment.
    const out = DEJAVU.resolveFolderTemplate("$defaultFolder/$filename", {
        $defaultFolder: "/Users/joaolopes",
        $filename: "Untitled-6"
    });
    assert.equal(out, "/Users/joaolopes/Untitled-6");
    assert.equal((out.match(/Untitled-6/g) || []).length, 1);
});

test("resolveFolderTemplate — middle subfolder text", () => {
    assert.equal(
        DEJAVU.resolveFolderTemplate("$defaultFolder/Backups/$filename", {
            $defaultFolder: "/root",
            $filename: "Doc"
        }),
        "/root/Backups/Doc"
    );
});

test("mergeSettings — adds new defaults, keeps stored values", () => {
    const defaults = { a: 1, b: 2, nested: { x: 1, y: 2 } };
    const stored = { b: 9, nested: { y: 5 }, extra: 7 };
    assert.deepEqual(DEJAVU.mergeSettings(defaults, stored), {
        a: 1,
        b: 9,
        nested: { x: 1, y: 5 },
        extra: 7
    });
});

test("mergeSettings — arrays replace, not merge", () => {
    assert.deepEqual(
        DEJAVU.mergeSettings({ list: [1, 2, 3] }, { list: [9] }),
        { list: [9] }
    );
});

test("pad2", () => {
    assert.equal(DEJAVU.pad2(7), "07");
    assert.equal(DEJAVU.pad2(12), "12");
});

test("formatTime / formatTimestamp", () => {
    const d = new Date(2026, 5, 26, 4, 9, 5); // local time 04:09:05, 26 Jun
    assert.equal(DEJAVU.formatTime(d), "04:09:05");
    assert.equal(DEJAVU.formatTimestamp(d.getTime()), "04:09:05 · 26/06");
    assert.equal(DEJAVU.formatTimestamp(0), "—");
});

test("relativeAge — deterministic with injected now", () => {
    const now = 1000000000000;
    assert.equal(DEJAVU.relativeAge(0, now), "");
    assert.equal(DEJAVU.relativeAge(now - 10 * 1000, now), "just now");
    assert.equal(DEJAVU.relativeAge(now - 5 * 60 * 1000, now), "5 min ago");
    assert.equal(DEJAVU.relativeAge(now - 3 * 3600 * 1000, now), "3 hr ago");
    assert.equal(DEJAVU.relativeAge(now - 24 * 3600 * 1000, now), "yesterday");
    assert.equal(DEJAVU.relativeAge(now - 5 * 86400 * 1000, now), "5 days ago");
    assert.equal(DEJAVU.relativeAge(now - 60 * 86400 * 1000, now), "2 months ago");
    assert.equal(DEJAVU.relativeAge(now - 400 * 86400 * 1000, now), "1 yr ago");
});

test("sizeDelta", () => {
    assert.deepEqual(DEJAVU.sizeDelta(100, 100), { text: "no change", dir: "flat" });
    assert.deepEqual(DEJAVU.sizeDelta(682, 0), { text: "+682 B", dir: "up" });
    assert.deepEqual(DEJAVU.sizeDelta(0, 2048), { text: "−2 KB", dir: "down" });
    assert.deepEqual(
        DEJAVU.sizeDelta(3.4 * 1024 * 1024, 0),
        { text: "+3.4 MB", dir: "up" }
    );
});

test("applyTokens — longest token first ($YYYY before $YY)", () => {
    assert.equal(
        DEJAVU.applyTokens("$YY-$YYYY", { $YY: "26", $YYYY: "2026" }),
        "26-2026"
    );
    assert.equal(
        DEJAVU.applyTokens("$filename_$hh", { $filename: "Doc", $hh: "04" }),
        "Doc_04"
    );
});

test("tokenIsInTemplate — boundary-aware", () => {
    assert.equal(DEJAVU.tokenIsInTemplate("$defaultFolder/$filename", "$filename"), true);
    assert.equal(DEJAVU.tokenIsInTemplate("$YYYY", "$YY"), false); // not a prefix match
    assert.equal(DEJAVU.tokenIsInTemplate("a/$filename/b", "$filename"), true);
    assert.equal(DEJAVU.tokenIsInTemplate("nothing", "$filename"), false);
});

test("tokenizeTemplate — text + tokens, longest match", () => {
    const tokens = ["$filename", "$hh", "$mm", "$YYYY", "$YY"];
    assert.deepEqual(DEJAVU.tokenizeTemplate("$filename_$hh", tokens), [
        { type: "token", trigger: "$", path: ["filename"] },
        { type: "text", value: "_" },
        { type: "token", trigger: "$", path: ["hh"] }
    ]);
    // $YYYY must win over its prefix $YY
    assert.deepEqual(DEJAVU.tokenizeTemplate("$YYYY", tokens), [
        { type: "token", trigger: "$", path: ["YYYY"] }
    ]);
    assert.deepEqual(DEJAVU.tokenizeTemplate("plain", tokens), [
        { type: "text", value: "plain" }
    ]);
});

test("folderTemplateMidValue", () => {
    assert.equal(
        DEJAVU.folderTemplateMidValue("$defaultFolder/$filename"),
        ""
    );
    assert.equal(
        DEJAVU.folderTemplateMidValue("$defaultFolder/Backups/$filename"),
        "Backups"
    );
    assert.equal(
        DEJAVU.folderTemplateMidValue("$defaultFolder/a/b/$filename"),
        "a/b"
    );
});

test("adoptKnownKeys — drops unknown keys, adopts known ones", () => {
    const defaults = { folder: "~/", keepCount: 20, enabled: false };
    const parsed = { folder: "~/Docs", stale: "x", keepCount: 5 };
    assert.deepEqual(DEJAVU.adoptKnownKeys(defaults, parsed), {
        folder: "~/Docs",
        keepCount: 5,
        enabled: false // not in parsed -> keeps default
    });
});

test("adoptKnownKeys — null/garbage parsed returns defaults copy", () => {
    const defaults = { a: 1, b: 2 };
    assert.deepEqual(DEJAVU.adoptKnownKeys(defaults, null), { a: 1, b: 2 });
    assert.deepEqual(DEJAVU.adoptKnownKeys(defaults, "nope"), { a: 1, b: 2 });
});

const FOLDER_TOKENS = ["$defaultFolder", "$filename"];

test("forceTemplateSlashes — single separators, tokens intact", () => {
    assert.equal(
        DEJAVU.forceTemplateSlashes("$defaultFolder//Backups///$filename", FOLDER_TOKENS),
        "$defaultFolder/Backups/$filename"
    );
    assert.equal(
        DEJAVU.forceTemplateSlashes("/a/b/", FOLDER_TOKENS),
        "a/b"
    );
    assert.equal(
        DEJAVU.forceTemplateSlashes("$defaultFolder/$filename", FOLDER_TOKENS),
        "$defaultFolder/$filename"
    );
});

test("normalizeFolderTemplate — keeps a valid template", () => {
    assert.equal(
        DEJAVU.normalizeFolderTemplate("$defaultFolder/$filename", FOLDER_TOKENS),
        "$defaultFolder/$filename"
    );
    assert.equal(
        DEJAVU.normalizeFolderTemplate("$defaultFolder/Backups/$filename", FOLDER_TOKENS),
        "$defaultFolder/Backups/$filename"
    );
});

test("normalizeFolderTemplate — re-adds missing required tokens", () => {
    // No tokens at all -> both root and leaf added around the free text.
    assert.equal(
        DEJAVU.normalizeFolderTemplate("Backups", FOLDER_TOKENS),
        "$defaultFolder/Backups/$filename"
    );
    // Missing leaf only.
    assert.equal(
        DEJAVU.normalizeFolderTemplate("$defaultFolder/Sub", FOLDER_TOKENS),
        "$defaultFolder/Sub/$filename"
    );
});

test("normalizeFolderTemplate — strips text before the root token", () => {
    assert.equal(
        DEJAVU.normalizeFolderTemplate("junk/$defaultFolder/$filename", FOLDER_TOKENS),
        "$defaultFolder/$filename"
    );
});
