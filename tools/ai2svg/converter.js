"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function getInkscapePath() {
    const platform = os.platform();
    const arch = os.arch();
    const baseDir = path.dirname(process.execPath);
    const candidates = [];

    if (platform === "darwin") {
        if (arch === "arm64") {
            candidates.push(path.join(baseDir, "Inkscape_mac_arm64.app", "Contents", "MacOS", "inkscape"));
        } else {
            candidates.push(path.join(baseDir, "Inkscape_mac_intel.app", "Contents", "MacOS", "inkscape"));
        }
        candidates.push(path.join(baseDir, "Inkscape.app", "Contents", "MacOS", "inkscape"));
    } else if (platform === "win32") {
        if (arch === "arm64") {
            throw new Error("No bundled Windows ARM64 Inkscape binary is available.");
        }
        candidates.push(path.join(baseDir, "inkscape_windows_intel", "bin", "inkscape.com"));
        candidates.push(path.join(baseDir, "inkscape-win", "bin", "inkscape.com"));
    } else {
        throw new Error(`Unsupported operating system: ${platform}`);
    }

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`Bundled Inkscape binary was not found for ${platform}/${arch}.`);
}

function convertAiToSvg() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log("Usage: ai2svg <input.ai|input.pdf> <output.svg>");
        process.exit(1);
    }

    const inputFile = path.resolve(args[0]);
    const outputFile = path.resolve(args[1]);

    if (!fs.existsSync(inputFile)) {
        console.error(`Error: input file does not exist at ${inputFile}`);
        process.exit(1);
    }

    try {
        const inkscapeBin = getInkscapePath();
        execFileSync(inkscapeBin, [
            `--export-filename=${outputFile}`,
            inputFile
        ], { stdio: "inherit" });
    } catch (error) {
        console.error("Inkscape conversion engine failed:", error.message);
        process.exit(1);
    }
}

convertAiToSvg();
