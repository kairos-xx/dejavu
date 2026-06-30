/*
 * DejaVu — automatic vendor (Inkscape) installer.
 *
 * Automatically downloads and extracts the platform-specific Inkscape binaries
 * from GitHub Releases on extension load if the vendor folder is missing or outdated.
 */
"use strict";

(() => {
    const VENDOR_VERSION_FILE = "vendor/.version";
    const VENDOR_HASH_FILE = "vendor/.hash";
    const VENDOR_LOCK_FILE = "vendor/.lock";
    const GITHUB_API_BASE = "https://api.github.com";
    const VENDOR_HASHES_FILE = "vendor-hashes.json";

    // SHA-256 hash computation
    const computeFileHash = (filePath) => {
        const crypto = require("crypto");
        const fs = require("fs");
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash("sha256");
            const stream = fs.createReadStream(filePath);
            stream.on("data", (data) => hash.update(data));
            stream.on("end", () => resolve(hash.digest("hex")));
            stream.on("error", reject);
        });
    };

    const getVendorHash = (root) => {
        if (!root) return null;
        try {
            const fs = require("fs");
            const path = require("path");
            const hashFile = path.join(root, VENDOR_HASH_FILE);
            if (fs.existsSync(hashFile)) {
                return fs.readFileSync(hashFile, "utf-8").trim();
            }
        } catch (e) {
            console.warn("Failed to read vendor hash:", e.message);
        }
        return null;
    };

    const setVendorHash = (root, hash) => {
        if (!root) return;
        try {
            const fs = require("fs");
            const path = require("path");
            const hashFile = path.join(root, VENDOR_HASH_FILE);
            fs.writeFileSync(hashFile, hash, "utf-8");
        } catch (e) {
            console.warn("Failed to write vendor hash:", e.message);
        }
    };

    const fetchVendorHashes = async (owner, repo) => {
        const https = require("https");
        return new Promise((resolve, reject) => {
            const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${VENDOR_HASHES_FILE}`;
            https.get(url, {
                headers: {
                    "User-Agent": "DejaVuAI",
                    "Accept": "application/vnd.github+json"
                }
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const content = JSON.parse(data);
                            if (content.content) {
                                const buffer = Buffer.from(content.content, "base64");
                                const hashes = JSON.parse(buffer.toString("utf-8"));
                                resolve(hashes);
                            } else {
                                resolve({});
                            }
                        } catch (e) {
                            reject(new Error("Failed to parse vendor hashes data"));
                        }
                    } else if (res.statusCode === 404) {
                        // File doesn't exist yet, return empty object
                        resolve({});
                    } else {
                        reject(new Error(`GitHub API returned ${res.statusCode}`));
                    }
                });
            }).on("error", reject).setTimeout(30000, () => {
                reject(new Error("GitHub API request timed out"));
            });
        });
    };

    // Progress bar UI helpers
    const showProgress = (label = "Downloading Inkscape...") => {
        const modal = document.getElementById("vendorDownloadModal");
        const titleEl = document.getElementById("vendorDownloadTitle");
        const statusEl = document.getElementById("vendorDownloadStatus");
        const progressBar = document.getElementById("vendorDownloadProgressBar");
        const dismissBtn = document.getElementById("vendorDownloadDismissBtn");
        if (modal) modal.classList.remove("update-install-modal--hidden");
        if (titleEl) titleEl.textContent = label;
        if (statusEl) statusEl.textContent = "Initializing...";
        if (progressBar) progressBar.style.width = "0%";
        if (dismissBtn) dismissBtn.classList.add("update-install-actions__hidden");
    };

    const hideProgress = () => {
        const modal = document.getElementById("vendorDownloadModal");
        if (modal) modal.classList.add("update-install-modal--hidden");
    };

    const updateProgress = (percent, status = null) => {
        const progressBar = document.getElementById("vendorDownloadProgressBar");
        const statusEl = document.getElementById("vendorDownloadStatus");
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (statusEl) statusEl.textContent = status !== null ? status : `${percent}%`;
    };

    const setProgressLabel = (label) => {
        const titleEl = document.getElementById("vendorDownloadTitle");
        if (titleEl) titleEl.textContent = label;
    };

    const setProgressComplete = () => {
        const dismissBtn = document.getElementById("vendorDownloadDismissBtn");
        if (dismissBtn) dismissBtn.classList.remove("update-install-actions__hidden");
    };

    // Platform detection (reused from inkscape-install.js)
    const platform = () => {
        if (typeof process !== "undefined" && process.platform) {
            return process.platform;
        }
        if (typeof require === "function") {
            const os = require("os");
            return os.platform();
        }
        return "";
    };

    const arch = () => {
        if (typeof process !== "undefined" && process.arch) return process.arch;
        if (typeof require === "function") {
            const os = require("os");
            return os.arch();
        }
        return "";
    };

    const platformTarget = () => {
        const p = platform();
        const a = arch();
        if (p === "darwin") return a === "arm64" ? "mac-arm64" : "mac-intel";
        if (p === "win32") return a === "arm64" ? "win-arm64" : "win-intel";
        return p || "unknown";
    };

    const getExtensionRoot = () => {
        if (typeof CSInterface !== "undefined") {
            const cs = new CSInterface();
            return cs.getSystemPath(SystemPath.EXTENSION);
        }
        if (typeof require === "function") {
            const path = require("path");
            // Try to find the extension root by walking up from __dirname
            let current = __dirname;
            for (let i = 0; i < 6; i++) {
                const manifest = path.join(current, "manifest.json");
                const fs = require("fs");
                if (fs.existsSync(manifest)) {
                    return current;
                }
                const parent = path.dirname(current);
                if (parent === current) break;
                current = parent;
            }
        }
        return null;
    };

    const getVendorVersion = (root) => {
        if (!root) return null;
        try {
            const fs = require("fs");
            const path = require("path");
            const versionFile = path.join(root, VENDOR_VERSION_FILE);
            if (fs.existsSync(versionFile)) {
                return fs.readFileSync(versionFile, "utf-8").trim();
            }
        } catch (e) {
            console.warn("Failed to read vendor version:", e.message);
        }
        return null;
    };

    const setVendorVersion = (root, version) => {
        if (!root) return;
        try {
            const fs = require("fs");
            const path = require("path");
            const versionFile = path.join(root, VENDOR_VERSION_FILE);
            fs.writeFileSync(versionFile, version, "utf-8");
        } catch (e) {
            console.warn("Failed to write vendor version:", e.message);
        }
    };

    const vendorExists = (root) => {
        if (!root) return false;
        try {
            const fs = require("fs");
            const path = require("path");
            const vendorDir = path.join(root, "vendor");
            const inkscapeDir = path.join(vendorDir, "inkscape");
            return fs.existsSync(inkscapeDir);
        } catch (e) {
            return false;
        }
    };

    const acquireLock = (root) => {
        if (!root) return false;
        try {
            const fs = require("fs");
            const path = require("path");
            const lockFile = path.join(root, VENDOR_LOCK_FILE);
            if (fs.existsSync(lockFile)) {
                const lockTime = fs.statSync(lockFile).mtimeMs;
                const now = Date.now();
                // Lock is valid for 10 minutes
                if (now - lockTime < 10 * 60 * 1000) {
                    return false;
                }
            }
            fs.writeFileSync(lockFile, String(Date.now()), "utf-8");
            return true;
        } catch (e) {
            console.warn("Failed to acquire lock:", e.message);
            return false;
        }
    };

    const releaseLock = (root) => {
        if (!root) return;
        try {
            const fs = require("fs");
            const path = require("path");
            const lockFile = path.join(root, VENDOR_LOCK_FILE);
            if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
            }
        } catch (e) {
            console.warn("Failed to release lock:", e.message);
        }
    };

    const fetchReleases = async (owner, repo) => {
        const https = require("https");
        return new Promise((resolve, reject) => {
            const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases?per_page=30`;
            https.get(url, {
                headers: {
                    "User-Agent": "DejaVuAI",
                    "Accept": "application/vnd.github+json"
                }
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const releases = JSON.parse(data);
                            resolve(Array.isArray(releases) ? releases : []);
                        } catch (e) {
                            reject(new Error("Failed to parse releases data"));
                        }
                    } else {
                        reject(new Error(`GitHub API returned ${res.statusCode}`));
                    }
                });
            }).on("error", reject).setTimeout(30000, () => {
                reject(new Error("GitHub API request timed out"));
            });
        });
    };

    const getLatestRelease = async (owner, repo, target) => {
        // The /releases/latest endpoint excludes prereleases, but vendor
        // assets may only be published on prerelease tags. Fetch the full
        // list (sorted newest-first) and pick the newest non-draft release
        // that actually contains a vendor asset for this platform.
        const releases = await fetchReleases(owner, repo);
        if (!releases.length) {
            throw new Error("No releases found");
        }
        if (target && target !== "unknown") {
            for (const release of releases) {
                if (release.draft) continue;
                if (findVendorAsset(release, target)) {
                    return release;
                }
            }
        }
        const nonDraft = releases.find((r) => !r.draft);
        return nonDraft || releases[0];
    };

    const findVendorAsset = (release, target) => {
        if (!release || !release.assets) return null;
        const assets = release.assets;
        const version = (release.tag_name || release.name || "").replace(/^v/, "");
        const targetName = target.replace("-", "_");
        const patterns = [
            new RegExp(`DejaVu-vendor-${version}-${target}\\.zip`, "i"),
            new RegExp(`DejaVu-vendor-.*-${target}\\.zip`, "i"),
            new RegExp(`Inkscape_${targetName}\\.zip`, "i"),
            new RegExp(`Inkscape_${targetName}\\.app\\.zip`, "i")
        ];
        for (const asset of assets) {
            if (patterns.some((pattern) => pattern.test(asset.name))) {
                return asset;
            }
        }
        for (const asset of assets) {
            if (asset.name.includes("vendor") && asset.name.includes(target) && asset.name.endsWith(".zip")) {
                return asset;
            }
        }
        for (const asset of assets) {
            if (asset.name.includes("Inkscape") && asset.name.includes(targetName) && asset.name.endsWith(".zip")) {
                return asset;
            }
        }
        return null;
    };

    const downloadFile = (url, targetPath, onProgress) => {
        const https = require("https");
        const http = require("http");
        const fs = require("fs");
        const protocol = url.startsWith("https:") ? https : http;
        
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(targetPath);
            protocol.get(url, {
                headers: { "User-Agent": "DejaVuAI" }
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    file.close();
                    fs.unlinkSync(targetPath);
                    resolve(downloadFile(res.headers.location, targetPath, onProgress));
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    file.close();
                    fs.unlinkSync(targetPath);
                    reject(new Error(`Download failed with HTTP ${res.statusCode}`));
                    return;
                }
                const total = parseInt(res.headers["content-length"] || "0", 10);
                let received = 0;
                res.on("data", (chunk) => {
                    received += chunk.length;
                    if (onProgress && total > 0) {
                        onProgress(received, total);
                    }
                });
                res.pipe(file);
                file.on("finish", () => {
                    file.close();
                    resolve(targetPath);
                });
                file.on("error", (err) => {
                    fs.unlinkSync(targetPath);
                    reject(err);
                });
            }).on("error", (err) => {
                file.close();
                if (fs.existsSync(targetPath)) {
                    fs.unlinkSync(targetPath);
                }
                reject(err);
            }).setTimeout(120000, () => {
                file.close();
                if (fs.existsSync(targetPath)) {
                    fs.unlinkSync(targetPath);
                }
                reject(new Error("Download timed out"));
            });
        });
    };

    const extractZip = (zipPath, targetDir) => {
        const fs = require("fs");
        const path = require("path");
        
        return new Promise((resolve, reject) => {
            // Try to use unzip command first (faster)
            const childProcess = require("child_process");
            
            const unzip = () => {
                childProcess.execFile(
                    "unzip",
                    ["-q", "-o", zipPath, "-d", targetDir],
                    { timeout: 120000 },
                    (error, stdout, stderr) => {
                        if (error) {
                            // Fallback to Node.js unzip if available
                            tryExtractWithNode();
                        } else {
                            resolve();
                        }
                    }
                );
            };

            const tryExtractWithNode = () => {
                try {
                    const admZip = require("adm-zip");
                    const zip = new admZip(zipPath);
                    zip.extractAllTo(targetDir, true);
                    resolve();
                } catch (e) {
                    reject(new Error("Failed to extract zip. Please install unzip or adm-zip package."));
                }
            };

            // Ensure target directory exists
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            unzip();
        });
    };

    const installVendor = async (owner, repo) => {
        const root = getExtensionRoot();
        if (!root) {
            throw new Error("Cannot determine extension root");
        }

        if (!acquireLock(root)) {
            console.log("Vendor installation already in progress");
            return;
        }

        try {
            const target = platformTarget();
            if (target === "unknown") {
                throw new Error("Unsupported platform");
            }

            showProgress("Checking for Inkscape update...");
            console.log(`Fetching latest release for ${owner}/${repo}...`);
            const release = await getLatestRelease(owner, repo, target);
            const version = release.tag_name || release.name || "unknown";

            console.log(`Latest release: ${version}`);
            console.log(`Platform target: ${target}`);

            const asset = findVendorAsset(release, target);
            if (!asset) {
                throw new Error(`No vendor asset found for platform ${target} in release ${version}`);
            }

            console.log(`Found asset: ${asset.name} (${asset.browser_download_url})`);

            const fs = require("fs");
            const path = require("path");
            const tempDir = path.join(root, "build", "temp");
            const zipPath = path.join(tempDir, asset.name);
            const vendorDir = path.join(root, "vendor");

            // Create temp directory
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            // Download
            setProgressLabel(`Downloading Inkscape (${version})...`);
            console.log("Downloading vendor zip...");
            await downloadFile(asset.browser_download_url, zipPath, (received, total) => {
                const pct = Math.round((received / total) * 100);
                updateProgress(pct);
                console.log(`Download progress: ${pct}%`);
            });

            // Compute hash before extraction
            setProgressLabel("Verifying download...");
            const hash = await computeFileHash(zipPath);
            console.log(`Downloaded zip hash: ${hash}`);

            // Extract
            setProgressLabel("Extracting Inkscape...");
            updateProgress(100, "Extracting...");
            console.log("Extracting vendor zip...");
            await extractZip(zipPath, vendorDir);

            // Clean up
            fs.unlinkSync(zipPath);

            // Store hash and version marker
            setVendorHash(root, hash);
            setVendorVersion(root, version);

            console.log("Vendor installation complete");
            setProgressComplete();
        } catch (e) {
            console.error("Vendor installation failed:", e.message);
            updateProgress(0, e && e.message ? e.message : String(e));
            setProgressComplete();
            throw e;
        } finally {
            releaseLock(root);
        }
    };

    const checkAndUpdateVendor = async () => {
        if (typeof require !== "function") {
            console.log("Vendor auto-install requires Node.js environment");
            return;
        }

        const root = getExtensionRoot();
        if (!root) {
            console.log("Cannot determine extension root");
            return;
        }

        // Get repo info from manifest
        let owner = "kairos-xx";
        let repo = "dejavu";
        try {
            const fs = require("fs");
            const path = require("path");
            const manifestPath = path.join(root, "manifest.json");
            if (fs.existsSync(manifestPath)) {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
                const updateCheck = manifest.dejavu?.updateCheck;
                if (updateCheck) {
                    owner = updateCheck.owner || owner;
                    repo = updateCheck.repo || repo;
                }
            }
        } catch (e) {
            console.warn("Failed to read repo info from manifest:", e.message);
        }

        const currentVersion = getVendorVersion(root);
        const currentHash = getVendorHash(root);
        const exists = vendorExists(root);
        const target = platformTarget();

        console.log(`Current vendor version: ${currentVersion || "none"}`);
        console.log(`Current vendor hash: ${currentHash || "none"}`);
        console.log(`Vendor exists: ${exists}`);
        console.log(`Platform target: ${target}`);

        if (!exists) {
            console.log("Vendor folder missing, installing...");
            try {
                await installVendor(owner, repo);
            } catch (e) {
                console.error("Vendor installation failed:", e.message);
                updateProgress(0, e && e.message ? e.message : String(e));
                setProgressComplete();
            }
            return;
        }

        // Check for updates using hash-based detection
        try {
            console.log("Checking for vendor updates...");
            const hashes = await fetchVendorHashes(owner, repo);
            const expectedHash = hashes[target];

            if (expectedHash) {
                console.log(`Expected hash for ${target}: ${expectedHash}`);
                if (currentHash !== expectedHash) {
                    console.log(`Vendor hash mismatch, updating...`);
                    try {
                        await installVendor(owner, repo);
                    } catch (e) {
                        console.error("Vendor update failed:", e.message);
                    }
                } else {
                    console.log("Vendor is up to date (hash matches)");
                }
            } else {
                // Fallback to version-based check if hash not available
                console.log("No hash found for platform, falling back to version check");
                const release = await getLatestRelease(owner, repo, target);
                const latestVersion = release.tag_name || release.name || "unknown";

                if (currentVersion !== latestVersion) {
                    console.log(`Vendor update available: ${currentVersion} -> ${latestVersion}`);
                    try {
                        await installVendor(owner, repo);
                    } catch (e) {
                        console.error("Vendor update failed:", e.message);
                    }
                } else {
                    console.log("Vendor is up to date (version matches)");
                }
            }
        } catch (e) {
            console.warn("Failed to check for vendor updates:", e.message);
            updateProgress(0, e && e.message ? e.message : String(e));
            setProgressComplete();
        }
    };

    // Export for use in main.js
    window.dejavu = window.dejavu || {};
    window.dejavu.autoInstallVendor = checkAndUpdateVendor;

    // Setup modal close button
    const closeBtn = document.getElementById("vendorDownloadCloseBtn");
    const dismissBtn = document.getElementById("vendorDownloadDismissBtn");
    const scrim = document.getElementById("vendorDownloadScrim");
    const modal = document.getElementById("vendorDownloadModal");

    const hideModal = () => {
        if (modal) modal.classList.add("update-install-modal--hidden");
    };

    if (closeBtn) closeBtn.addEventListener("click", hideModal);
    if (dismissBtn) dismissBtn.addEventListener("click", hideModal);
    if (scrim) scrim.addEventListener("click", hideModal);

    document.addEventListener("keydown", (evt) => {
        if (evt.key !== "Escape") return;
        if (!modal || modal.classList.contains("update-install-modal--hidden")) {
            return;
        }
        evt.preventDefault();
        hideModal();
    });

    // Auto-run on load if in CEP environment
    if (typeof CSInterface !== "undefined") {
        // Delay slightly to not block initial load
        setTimeout(() => {
            checkAndUpdateVendor().catch((e) => {
                console.error("Vendor auto-install error:", e.message);
            });
        }, 2000);
    }
})();
