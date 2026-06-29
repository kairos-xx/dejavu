/*
 * DejaVu — first-run Inkscape installer prompt.
 *
 * Inkscape keeps AI/PDF comparison from opening candidate files in
 * Illustrator. On first load, if it is missing, offer to download the official
 * Inkscape installer and launch it.
 */
"use strict";

(() => {
    const LS_PROMPT = "dejavu.inkscape.installPrompt.v1";
    const LS_NEVER = "dejavu.inkscape.installPrompt.never";
    const SS_DISMISSED = "dejavu.inkscape.installPrompt.dismissed";
    const DOWNLOAD_URL = "https://inkscape.org/release/";
    const DEFAULT_RELEASE = "1.4.4";
    const RELEASE_PAGE_URL = "https://inkscape.org/release/";

    const ui = {
        modal: document.getElementById("inkscapeInstallModal"),
        scrim: document.getElementById("inkscapeInstallScrim"),
        closeBtn: document.getElementById("inkscapeInstallCloseBtn"),
        runBtn: document.getElementById("inkscapeInstallRunBtn"),
        laterBtn: document.getElementById("inkscapeInstallLaterBtn"),
        doneBtn: document.getElementById("inkscapeInstallDoneBtn"),
        neverAsk: document.getElementById("inkscapeInstallNeverAsk"),
        progressBar: document.getElementById("inkscapeInstallProgressBar"),
        status: document.getElementById("inkscapeInstallStatus")
    };

    const hasNode = () => typeof require === "function";
    const node = () => {
        if (!hasNode()) return null;
        return {
            childProcess: require("child_process"),
            fs: require("fs"),
            http: require("http"),
            https: require("https"),
            os: require("os")
        };
    };

    const platform = () => {
        if (typeof process !== "undefined" && process.platform) {
            return process.platform;
        }
        const modules = node();
        return modules && modules.os && modules.os.platform
            ? modules.os.platform()
            : "";
    };

    const arch = () => {
        if (typeof process !== "undefined" && process.arch) return process.arch;
        const modules = node();
        return modules && modules.os && modules.os.arch ? modules.os.arch() : "";
    };

    const platformTarget = () => {
        const p = platform();
        const a = arch();
        if (p === "darwin") return a === "arm64" ? "mac-arm64" : "mac-intel";
        if (p === "win32") return a === "arm64" ? "win-arm64" : "win-intel";
        return p || "unknown";
    };

    const addUnique = (list, value) => {
        if (value && !list.includes(value)) list.push(value);
    };

    const appRootCandidates = () => {
        if (!hasNode()) return [];
        const path = require("path");
        const roots = [];
        const add = (dir) => {
            if (dir && !roots.includes(dir)) roots.push(dir);
        };
        try { add(process.cwd()); } catch {}
        try { add(path.dirname(process.execPath)); } catch {}
        try { add(__dirname); } catch {}
        roots.slice().forEach((dir) => {
            let current = dir;
            for (let i = 0; i < 6; i += 1) {
                add(current);
                const next = path.dirname(current);
                if (!next || next === current) break;
                current = next;
            }
        });
        return roots;
    };

    const bundledInkscapeCandidates = () => {
        const path = require("path");
        const p = platform();
        const target = platformTarget();
        const list = [];
        appRootCandidates().forEach((root) => {
            [path.join(root, "vendor", "inkscape"), root].forEach((dir) => {
                if (p === "darwin") {
                    if (target === "mac-arm64") {
                        addUnique(list, path.join(dir, "Inkscape_mac_arm64.app", "Contents", "MacOS", "inkscape"));
                    } else if (target === "mac-intel") {
                        addUnique(list, path.join(dir, "Inkscape_mac_intel.app", "Contents", "MacOS", "inkscape"));
                    }
                    addUnique(list, path.join(dir, "Inkscape.app", "Contents", "MacOS", "inkscape"));
                } else if (p === "win32" && target === "win-intel") {
                    addUnique(list, path.join(dir, "inkscape_windows_intel", "bin", "inkscape.com"));
                    addUnique(list, path.join(dir, "inkscape-win", "bin", "inkscape.com"));
                }
            });
        });
        return list;
    };

    const setStatus = (text) => {
        if (ui.status) ui.status.textContent = text;
    };

    const setBusy = (busy) => {
        [ui.runBtn, ui.laterBtn, ui.closeBtn, ui.doneBtn].forEach((button) => {
            if (button) button.disabled = !!busy;
        });
    };

    const setIndeterminate = (on) => {
        if (!ui.progressBar) return;
        ui.progressBar.style.width = on ? "" : "0%";
        ui.progressBar.classList.toggle(
            "update-install-progress__bar--indeterminate",
            !!on
        );
    };

    const showButton = (button, shown) => {
        if (!button) return;
        button.classList.toggle("update-install-actions__hidden", !shown);
    };

    const rememberNeverIfChecked = () => {
        if (!ui.neverAsk || !ui.neverAsk.checked) return false;
        try { window.localStorage.setItem(LS_NEVER, "1"); } catch {}
        try { window.localStorage.setItem(LS_PROMPT, "dismissed"); } catch {}
        return true;
    };

    const execFile = (cmd, args, opts) => {
        const modules = node();
        if (!modules || !modules.childProcess) {
            return Promise.reject(new Error("Shell access is unavailable."));
        }
        return new Promise((resolve, reject) => {
            modules.childProcess.execFile(
                cmd,
                args || [],
                Object.assign({ windowsHide: true, timeout: 20 * 60 * 1000 }, opts || {}),
                (error, stdout, stderr) => {
                    if (error) {
                        error.stdout = stdout;
                        error.stderr = stderr;
                        reject(error);
                        return;
                    }
                    resolve({ stdout, stderr });
                }
            );
        });
    };

    const commandWorks = (cmd, args) =>
        execFile(cmd, args || ["--version"], { timeout: 10000 })
            .then(() => true)
            .catch(() => false);

    const bundledBinaryExists = (cmd) => {
        if (!cmd || !hasNode()) return false;
        if (!/vendor\/inkscape|Inkscape_mac_|inkscape_windows_intel|inkscape-win|Inkscape\.app/.test(String(cmd))) {
            return false;
        }
        try {
            return require("fs").existsSync(cmd);
        } catch {
            return false;
        }
    };

    const spawnDetached = (cmd, args) => {
        const modules = node();
        if (!modules || !modules.childProcess) {
            return Promise.reject(new Error("Shell access is unavailable."));
        }
        return new Promise((resolve, reject) => {
            try {
                const child = modules.childProcess.spawn(cmd, args || [], {
                    detached: true,
                    stdio: "ignore",
                    windowsHide: false
                });
                child.once("error", reject);
                child.unref();
                window.setTimeout(resolve, 300);
            } catch (error) {
                reject(error);
            }
        });
    };

    const inkscapeCandidates = () => {
        const p = platform();
        const list = bundledInkscapeCandidates();
        addUnique(list, "inkscape");
        if (p === "darwin") {
            addUnique(list, "/Applications/Inkscape.app/Contents/MacOS/inkscape");
        } else if (p === "win32") {
            addUnique(list, "C:\\Program Files\\Inkscape\\bin\\inkscape.com");
        }
        return list;
    };

    const hasInkscape = async () => {
        if (!hasNode()) {
            if (typeof callHost === "function") {
                const result = await callHost("dejavu_checkInkscape", []);
                return !!(result && result.ok && result.installed);
            }
            return false;
        }
        const list = inkscapeCandidates();
        for (let i = 0; i < list.length; i += 1) {
            if (bundledBinaryExists(list[i])) return true;
            if (await commandWorks(list[i], ["--version"])) return true;
        }
        return false;
    };

    const openDownloadPage = () => {
        if (typeof callHost === "function") {
            callHost("dejavu_openExternalUrl", [DOWNLOAD_URL]);
            return;
        }
        window.open(DOWNLOAD_URL, "_blank");
    };

    const downloadDir = () => {
        const modules = node();
        if (!modules || !modules.os || !modules.fs) {
            throw new Error("Download access is unavailable.");
        }
        const path = require("path");
        const dir = path.join(modules.os.homedir(), "Downloads", "DejaVu", "Inkscape");
        modules.fs.mkdirSync(dir, { recursive: true });
        return dir;
    };

    const fileNameFromHeaders = (headers, fallbackName) => {
        const disposition = String(headers && headers["content-disposition"] || "");
        const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
        if (!match) return fallbackName;
        try {
            return decodeURIComponent(match[1].replace(/^"|"$/g, ""));
        } catch {
            return match[1].replace(/^"|"$/g, "") || fallbackName;
        }
    };

    const downloadLinkFromHtml = (html) => {
        const text = String(html || "");
        const refresh = text.match(/http-equiv=["']Refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i);
        if (refresh && refresh[1]) return refresh[1].replace(/&amp;/g, "&").trim();
        const direct = text.match(/href=["']([^"']+\.(?:dmg|exe|msi)(?:\?[^"']*)?)["']/i);
        return direct && direct[1] ? direct[1].replace(/&amp;/g, "&").trim() : "";
    };

    const fetchText = (url, redirects = 0) => {
        const modules = node();
        const net = String(url).startsWith("https:") ? modules.https : modules.http;
        return new Promise((resolve, reject) => {
            const req = net.get(url, { headers: { "User-Agent": "DejaVuAI" } }, (res) => {
                const location = res.headers.location;
                if (res.statusCode >= 300 && res.statusCode < 400 && location && redirects < 8) {
                    res.resume();
                    resolve(fetchText(new URL(location, url).toString(), redirects + 1));
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    reject(new Error(`Download page returned HTTP ${res.statusCode}.`));
                    return;
                }
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => { text += chunk; });
                res.on("end", () => resolve(text));
            });
            req.on("error", reject);
            req.setTimeout(30000, () => req.destroy(new Error("Connection timed out.")));
        });
    };

    const latestRelease = async () => {
        try {
            const text = await fetchText(RELEASE_PAGE_URL);
            const match = text.match(/\/release\/inkscape-([0-9][0-9A-Za-z.\-]*)\//);
            return match ? match[1] : DEFAULT_RELEASE;
        } catch {
            return DEFAULT_RELEASE;
        }
    };

    const installerUrl = async () => {
        const version = await latestRelease();
        const p = platform();
        const arch = typeof process !== "undefined" && process.arch ? process.arch : "";
        if (p === "darwin") {
            const dmgKind = arch === "arm64" ? "dmg-arm64" : "dmg";
            return `https://inkscape.org/release/inkscape-${version}/mac-os-x/${dmgKind}/dl/`;
        }
        if (p === "win32") {
            const winArch = arch === "arm64" ? "arm64" : "64-bit";
            return `https://inkscape.org/release/inkscape-${version}/windows/${winArch}/exe/dl/`;
        }
        return "";
    };

    const downloadFile = (url, fallbackName, redirects = 0) => {
        const modules = node();
        const path = require("path");
        const net = String(url).startsWith("https:") ? modules.https : modules.http;
        return new Promise((resolve, reject) => {
            const req = net.get(url, { headers: { "User-Agent": "DejaVuAI" } }, (res) => {
                const location = res.headers.location;
                if (res.statusCode >= 300 && res.statusCode < 400 && location && redirects < 8) {
                    res.resume();
                    resolve(downloadFile(new URL(location, url).toString(), fallbackName, redirects + 1));
                    return;
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    reject(new Error(`Download failed with HTTP ${res.statusCode}.`));
                    return;
                }
                const type = String(res.headers["content-type"] || "").toLowerCase();
                if (type.includes("text/html")) {
                    let html = "";
                    res.setEncoding("utf8");
                    res.on("data", (chunk) => { html += chunk; });
                    res.on("end", () => {
                        const nextUrl = downloadLinkFromHtml(html);
                        if (nextUrl && redirects < 8) {
                            resolve(downloadFile(new URL(nextUrl, url).toString(), fallbackName, redirects + 1));
                            return;
                        }
                        reject(new Error("Inkscape returned a download page instead of an installer."));
                    });
                    return;
                }
                const total = Number(res.headers["content-length"] || 0);
                let received = 0;
                const target = path.join(downloadDir(), fileNameFromHeaders(res.headers, fallbackName));
                const stream = modules.fs.createWriteStream(target);
                res.on("data", (chunk) => {
                    received += chunk.length;
                    if (total && ui.progressBar) {
                        const pct = Math.max(4, Math.min(98, Math.round((received / total) * 100)));
                        ui.progressBar.style.width = `${pct}%`;
                    }
                });
                res.pipe(stream);
                stream.on("finish", () => {
                    stream.close(() => resolve(target));
                });
                stream.on("error", reject);
            });
            req.on("error", reject);
            req.setTimeout(120000, () => req.destroy(new Error("Download timed out.")));
        });
    };

    const showInstallerLaunched = () => {
        setIndeterminate(false);
        if (ui.progressBar) ui.progressBar.style.width = "100%";
        setStatus("Installer opened. Finish the Inkscape setup, then click Check again.");
        showButton(ui.runBtn, false);
        showButton(ui.laterBtn, false);
        showButton(ui.doneBtn, true);
        if (ui.doneBtn) ui.doneBtn.textContent = "Check again";
    };

    const downloadAndOpenInstaller = async () => {
        const p = platform();
        const url = await installerUrl();
        if (!url) {
            openDownloadPage();
            throw new Error("Automatic install is only available on macOS and Windows.");
        }
        const fallbackName = p === "darwin" ? "Inkscape-macOS.dmg" : "Inkscape-Windows.exe";
        setIndeterminate(false);
        if (ui.progressBar) ui.progressBar.style.width = "4%";
        setStatus("Downloading the official Inkscape installer...");
        const installerPath = await downloadFile(url, fallbackName);
        setStatus("Opening the Inkscape installer...");
        if (p === "darwin") {
            await execFile("open", [installerPath], { timeout: 30000 });
        } else if (p === "win32") {
            await spawnDetached(installerPath, []);
        }
        showInstallerLaunched();
    };

    const installViaHost = async () => {
        if (typeof callHost !== "function") {
            throw new Error("No host installer is available.");
        }
        const result = await callHost("dejavu_installInkscape", []);
        if (!result || result.ok === false) {
            throw new Error((result && result.error) || "Inkscape install failed.");
        }
    };

    const install = async () => {
        rememberNeverIfChecked();
        setBusy(true);
        setIndeterminate(false);
        setStatus("Preparing Inkscape installer...");
        try {
            if (!hasNode()) {
                await installViaHost();
            } else {
                await downloadAndOpenInstaller();
                return;
            }

            setStatus("Checking Inkscape...");
            if (await hasInkscape()) {
                setIndeterminate(false);
                if (ui.progressBar) ui.progressBar.style.width = "100%";
                setStatus("Inkscape is installed. AI and PDF comparison can use it now.");
                showButton(ui.runBtn, false);
                showButton(ui.laterBtn, false);
                showButton(ui.doneBtn, true);
                try { window.localStorage.setItem(LS_PROMPT, "installed"); } catch {}
                return;
            }
            showInstallerLaunched();
        } catch (error) {
            setStatus(error && error.message ? error.message : String(error));
        } finally {
            setBusy(false);
            setIndeterminate(false);
        }
    };

    const hide = (remember) => {
        if (!ui.modal) return;
        ui.modal.classList.add("update-install-modal--hidden");
        if (!rememberNeverIfChecked() && remember) {
            try { window.sessionStorage.setItem(SS_DISMISSED, "1"); } catch {}
        }
    };

    const show = () => {
        if (!ui.modal) return;
        setBusy(false);
        setIndeterminate(false);
        setStatus("Ready to install");
        if (ui.doneBtn) ui.doneBtn.textContent = "Check again";
        if (ui.neverAsk) ui.neverAsk.checked = false;
        showButton(ui.runBtn, true);
        showButton(ui.laterBtn, true);
        showButton(ui.doneBtn, false);
        ui.modal.classList.remove("update-install-modal--hidden");
    };

    const checkAgain = async () => {
        setBusy(true);
        setIndeterminate(true);
        setStatus("Checking Inkscape...");
        try {
            if (await hasInkscape()) {
                try { window.localStorage.setItem(LS_PROMPT, "installed"); } catch {}
                setIndeterminate(false);
                if (ui.progressBar) ui.progressBar.style.width = "100%";
                setStatus("Inkscape is installed. AI and PDF comparison can use it now.");
                window.setTimeout(() => hide(false), 900);
                return;
            }
            setStatus("Inkscape is still not available. Finish the installer, then check again.");
        } finally {
            setBusy(false);
            setIndeterminate(false);
        }
    };

    const maybePrompt = async () => {
        if (!ui.modal) return;
        // Suppress in browser dev mode
        if (typeof window.__adobe_cep__ === "undefined" &&
            typeof CSInterface === "undefined") {
            return;
        }
        let never = "";
        let sessionDismissed = "";
        try { never = window.localStorage.getItem(LS_NEVER) || ""; } catch {}
        try { sessionDismissed = window.sessionStorage.getItem(SS_DISMISSED) || ""; } catch {}
        if (never === "1") return;
        if (sessionDismissed === "1") return;
        const installed = await hasInkscape();
        let seen = "";
        try { seen = window.localStorage.getItem(LS_PROMPT) || ""; } catch {}
        if (installed) {
            try { window.localStorage.setItem(LS_PROMPT, "installed"); } catch {}
            return;
        }
        if (seen === "installed") {
            try { window.localStorage.removeItem(LS_PROMPT); } catch {}
            seen = "";
        }
        if (seen === "dismissed") {
            try { window.localStorage.removeItem(LS_PROMPT); } catch {}
        }
        show();
    };

    if (ui.runBtn) ui.runBtn.addEventListener("click", install);
    if (ui.laterBtn) ui.laterBtn.addEventListener("click", () => hide(true));
    if (ui.closeBtn) ui.closeBtn.addEventListener("click", () => hide(true));
    if (ui.scrim) ui.scrim.addEventListener("click", () => hide(true));
    if (ui.doneBtn) ui.doneBtn.addEventListener("click", checkAgain);

    window.setTimeout(() => {
        maybePrompt().catch(() => {});
    }, 1800);
})();
