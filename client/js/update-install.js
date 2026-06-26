/*
 * DejaVu — auto-install update panel.
 *
 * Downloads a GitHub Release package, installs the zip into the current CEP
 * extension folder when filesystem access is available, and then offers to
 * restart the panel. In restricted runtimes it falls back to a normal download.
 */
"use strict";

(() => {
    const PANEL_DOWNLOADS_DIR = "DejaVu/updates";
    const EXTENSION_DIR_NAME = "DejaVu";
    const MAX_PROGRESS = 100;
    const INSTALL_ITEMS = ["client", "host", "icons", "CSXS", "manifest.json"];
    const STALE_ITEMS = [
        "client/js/main_es6.js",
        "host/host.legacy.jsx"
    ];

    const ui = {
        modal: document.getElementById("updateInstallModal"),
        scrim: document.getElementById("updateInstallScrim"),
        closeBtn: document.getElementById("updateInstallCloseBtn"),
        downloadBtn: document.getElementById("updateInstallDownloadBtn"),
        laterBtn: document.getElementById("updateInstallLaterBtn"),
        refreshBtn: document.getElementById("updateInstallRefreshBtn"),
        revealBtn: document.getElementById("updateInstallRevealBtn"),
        progressBar: document.getElementById("updateInstallProgressBar"),
        status: document.getElementById("updateInstallStatus")
    };

    const state = {
        version: "",
        assetUrl: "",
        assetName: "",
        releaseUrl: "",
        downloadedPath: "",
        installedPath: "",
        busy: false
    };

    const hasNode = () => typeof require === "function";

    const node = () => {
        if (!hasNode()) return null;
        return {
            fs: require("fs"),
            os: require("os"),
            path: require("path"),
            childProcess: require("child_process")
        };
    };

    const hideButton = (button) => {
        if (button) button.classList.add("update-install-actions__hidden");
    };

    const showButton = (button) => {
        if (button) button.classList.remove("update-install-actions__hidden");
    };

    const setBusy = (busy) => {
        state.busy = busy;
        [ui.downloadBtn, ui.laterBtn, ui.refreshBtn, ui.revealBtn].forEach((button) => {
            if (button) button.disabled = busy;
        });
    };

    const setProgress = (percent) => {
        if (!ui.progressBar) return;
        const value = Math.max(0, Math.min(MAX_PROGRESS, Math.round(percent)));
        ui.progressBar.style.width = `${value}%`;
        ui.progressBar.classList.remove("update-install-progress__bar--indeterminate");
        ui.progressBar.setAttribute("aria-valuenow", String(value));
    };

    const setIndeterminate = () => {
        if (!ui.progressBar) return;
        ui.progressBar.style.width = "";
        ui.progressBar.classList.add("update-install-progress__bar--indeterminate");
        ui.progressBar.setAttribute("aria-valuenow", "0");
    };

    const setStatus = (text) => {
        if (ui.status) ui.status.textContent = text;
    };

    const setLaterLabel = (text) => {
        if (!ui.laterBtn) return;
        ui.laterBtn.textContent = text;
        ui.laterBtn.classList.toggle(
            "update-install-later--close",
            text === "Close"
        );
    };

    const canUseCepRoot = () => {
        return typeof window.__adobe_cep__ !== "undefined" &&
            typeof CSInterface === "function" &&
            typeof SystemPath !== "undefined";
    };

    const extensionRoot = () => {
        try {
            if (canUseCepRoot()) {
                const cs = window.__dejavuUpdateInstallCsInterface ||
                    new CSInterface();
                window.__dejavuUpdateInstallCsInterface = cs;
                return cs.getSystemPath(SystemPath.EXTENSION) || "";
            }
        } catch {}
        return "";
    };

    const canInstallInPlace = () => {
        return hasNode() && Boolean(extensionRoot());
    };

    const isArchiveAsset = () => {
        return /\.(zip|zxp)$/i.test(state.assetName || state.assetUrl || "");
    };

    const primaryLabel = () => {
        if (!state.assetUrl) return "Open release";
        if (canInstallInPlace() && isArchiveAsset()) return "Install update";
        return "Download update";
    };

    const show = () => {
        if (!ui.modal) return;
        ui.modal.classList.remove("update-install-modal--hidden");
        setBusy(false);
        setProgress(0);
        setStatus("Ready to install");
        setLaterLabel("Later");
        if (ui.downloadBtn) ui.downloadBtn.textContent = primaryLabel();
        showButton(ui.downloadBtn);
        showButton(ui.laterBtn);
        hideButton(ui.refreshBtn);
        hideButton(ui.revealBtn);
    };

    const hide = () => {
        if (state.busy || !ui.modal) return;
        ui.modal.classList.add("update-install-modal--hidden");
    };

    const showRefresh = () => {
        hideButton(ui.downloadBtn);
        hideButton(ui.laterBtn);
        hideButton(ui.revealBtn);
        showButton(ui.refreshBtn);
    };

    const showDownloaded = () => {
        hideButton(ui.downloadBtn);
        setLaterLabel("Close");
        showButton(ui.laterBtn);
        showButton(ui.revealBtn);
        hideButton(ui.refreshBtn);
    };

    const ensureDownloadsFolder = () => {
        const modules = node();
        if (!modules) {
            throw new Error("Cannot save downloaded update in this runtime.");
        }
        const folder = modules.path.join(
            modules.os.homedir(),
            "Downloads",
            PANEL_DOWNLOADS_DIR
        );
        modules.fs.mkdirSync(folder, { recursive: true });
        return folder;
    };

    const execFile = (cmd, args) => {
        const modules = node();
        if (!modules) return Promise.reject(new Error("Node is unavailable."));
        return new Promise((resolve, reject) => {
            modules.childProcess.execFile(
                cmd,
                args,
                { windowsHide: true },
                (error, stdout, stderr) => {
                    if (error) {
                        error.stderr = stderr;
                        reject(error);
                        return;
                    }
                    resolve({ stdout, stderr });
                }
            );
        });
    };

    const revealPath = (targetPath) => {
        if (!targetPath) return;
        try {
            if (typeof callHost === "function") {
                callHost("dejavu_revealPath", [targetPath]);
                return;
            }
        } catch {}
        const modules = node();
        if (!modules) return;
        const folder = modules.fs.existsSync(targetPath) &&
            modules.fs.statSync(targetPath).isDirectory()
            ? targetPath
            : modules.path.dirname(targetPath);
        if (process.platform === "win32") {
            execFile("explorer.exe", [folder]);
        } else if (process.platform === "darwin") {
            execFile("open", [folder]);
        } else {
            execFile("xdg-open", [folder]);
        }
    };

    const openRelease = () => {
        const url = state.releaseUrl || state.assetUrl;
        if (!url) return;
        try {
            if (typeof callHost === "function") {
                callHost("dejavu_openExternalUrl", [url]);
                return;
            }
        } catch {}
        try {
            window.open(url, "_blank");
        } catch {}
    };

    const downloadWithProgress = async (url, folder) => {
        const modules = node();
        if (!modules) {
            throw new Error("Cannot save downloaded update in this runtime.");
        }
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Download failed: ${response.status} ${response.statusText}`);
        }
        const total = Number(response.headers.get("content-length")) || 0;
        const reader = response.body && typeof response.body.getReader === "function"
            ? response.body.getReader()
            : null;
        const chunks = [];
        let received = 0;

        if (reader) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (total > 0) {
                    setProgress((received / total) * MAX_PROGRESS);
                }
            }
        } else {
            setIndeterminate();
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            chunks.push(new Uint8Array(arrayBuffer));
            received = chunks[0].length;
        }

        const all = new Uint8Array(received);
        let offset = 0;
        chunks.forEach((chunk) => {
            all.set(chunk, offset);
            offset += chunk.length;
        });

        const name = state.assetName || url.split("/").pop() || "DejaVu-update.zip";
        const targetPath = modules.path.join(folder, name);
        modules.fs.writeFileSync(targetPath, all);
        return targetPath;
    };

    const removePath = (targetPath) => {
        const modules = node();
        if (!modules || !modules.fs.existsSync(targetPath)) return;
        if (typeof modules.fs.rmSync === "function") {
            modules.fs.rmSync(targetPath, { recursive: true, force: true });
            return;
        }
        const stat = modules.fs.lstatSync(targetPath);
        if (stat.isDirectory()) {
            modules.fs.readdirSync(targetPath).forEach((entry) => {
                removePath(modules.path.join(targetPath, entry));
            });
            modules.fs.rmdirSync(targetPath);
        } else {
            modules.fs.unlinkSync(targetPath);
        }
    };

    const copyRecursive = (source, target) => {
        const modules = node();
        if (!modules) throw new Error("Node is unavailable.");
        const stat = modules.fs.lstatSync(source);
        if (stat.isDirectory()) {
            modules.fs.mkdirSync(target, { recursive: true });
            modules.fs.readdirSync(source).forEach((entry) => {
                copyRecursive(
                    modules.path.join(source, entry),
                    modules.path.join(target, entry)
                );
            });
            return;
        }
        modules.fs.mkdirSync(modules.path.dirname(target), { recursive: true });
        modules.fs.copyFileSync(source, target);
    };

    const extractArchive = async (archivePath) => {
        const modules = node();
        if (!modules) throw new Error("Node is unavailable.");
        const tempRoot = modules.fs.mkdtempSync(
            modules.path.join(modules.os.tmpdir(), "dejavu-update-")
        );
        if (process.platform === "win32") {
            const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
            await execFile("powershell.exe", [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(tempRoot)} -Force`
            ]);
        } else {
            const unzipCmd = process.platform === "darwin" ? "/usr/bin/unzip" : "unzip";
            await execFile(unzipCmd, ["-oq", archivePath, "-d", tempRoot]);
        }
        return tempRoot;
    };

    const hasManifest = (folder) => {
        const modules = node();
        if (!modules) return false;
        return modules.fs.existsSync(modules.path.join(folder, "manifest.json")) &&
            modules.fs.existsSync(modules.path.join(folder, "CSXS", "manifest.xml")) &&
            modules.fs.existsSync(modules.path.join(folder, "client", "index.html"));
    };

    const findExtractedExtensionRoot = (tempRoot) => {
        const modules = node();
        if (!modules) throw new Error("Node is unavailable.");
        const direct = modules.path.join(tempRoot, EXTENSION_DIR_NAME);
        if (hasManifest(direct)) return direct;
        if (hasManifest(tempRoot)) return tempRoot;
        const children = modules.fs.readdirSync(tempRoot);
        for (let i = 0; i < children.length; i++) {
            const candidate = modules.path.join(tempRoot, children[i]);
            if (modules.fs.existsSync(candidate) &&
                modules.fs.statSync(candidate).isDirectory() &&
                hasManifest(candidate)) {
                return candidate;
            }
        }
        throw new Error("The downloaded package does not look like DejaVu.");
    };

    const backupCurrentInstall = (root) => {
        const modules = node();
        if (!modules) throw new Error("Node is unavailable.");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupRoot = modules.path.join(
            ensureDownloadsFolder(),
            "backups",
            `${EXTENSION_DIR_NAME}-${stamp}`
        );
        modules.fs.mkdirSync(backupRoot, { recursive: true });
        INSTALL_ITEMS.forEach((item) => {
            const source = modules.path.join(root, item);
            if (modules.fs.existsSync(source)) {
                copyRecursive(source, modules.path.join(backupRoot, item));
            }
        });
        return backupRoot;
    };

    const installExtractedPackage = (packageRoot) => {
        const modules = node();
        if (!modules) throw new Error("Node is unavailable.");
        const root = extensionRoot();
        if (!root) {
            throw new Error("Could not locate the installed extension folder.");
        }
        if (!hasManifest(packageRoot)) {
            throw new Error("The downloaded package is missing DejaVu files.");
        }
        const backupRoot = backupCurrentInstall(root);
        INSTALL_ITEMS.forEach((item) => {
            const source = modules.path.join(packageRoot, item);
            const target = modules.path.join(root, item);
            if (!modules.fs.existsSync(source)) return;
            removePath(target);
            copyRecursive(source, target);
        });
        STALE_ITEMS.forEach((item) => {
            removePath(modules.path.join(root, item));
        });
        return { root, backupRoot };
    };

    const installUpdate = async () => {
        if (!state.assetUrl) {
            openRelease();
            return;
        }
        setBusy(true);
        setProgress(0);
        setStatus("Downloading update...");
        try {
            const folder = ensureDownloadsFolder();
            const downloadedPath = await downloadWithProgress(state.assetUrl, folder);
            state.downloadedPath = downloadedPath;
            setProgress(MAX_PROGRESS);

            if (!canInstallInPlace() || !isArchiveAsset()) {
                setStatus(`Downloaded to ${downloadedPath}`);
                showDownloaded();
                return;
            }

            setIndeterminate();
            setStatus("Installing update...");
            const tempRoot = await extractArchive(downloadedPath);
            const packageRoot = findExtractedExtensionRoot(tempRoot);
            const installed = installExtractedPackage(packageRoot);
            state.installedPath = installed.root;
            setProgress(MAX_PROGRESS);
            setStatus(`Installed in ${installed.root}`);
            showRefresh();
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setStatus(`Update failed: ${message}`);
            if (state.downloadedPath) showDownloaded();
        } finally {
            setBusy(false);
        }
    };

    const refreshPanel = () => {
        window.location.reload(true);
    };

    if (ui.closeBtn) ui.closeBtn.addEventListener("click", hide);
    if (ui.scrim) ui.scrim.addEventListener("click", hide);
    if (ui.laterBtn) ui.laterBtn.addEventListener("click", hide);
    if (ui.downloadBtn) ui.downloadBtn.addEventListener("click", installUpdate);
    if (ui.refreshBtn) ui.refreshBtn.addEventListener("click", refreshPanel);
    if (ui.revealBtn) {
        ui.revealBtn.addEventListener("click", () => {
            revealPath(state.downloadedPath || ensureDownloadsFolder());
        });
    }

    document.addEventListener("keydown", (evt) => {
        if (evt.key !== "Escape") return;
        if (!ui.modal || ui.modal.classList.contains("update-install-modal--hidden")) {
            return;
        }
        evt.preventDefault();
        hide();
    });

    const showChecking = () => {
        show();
        setIndeterminate();
        setStatus("Checking for updates...");
        setLaterLabel("Close");
        hideButton(ui.downloadBtn);
        hideButton(ui.refreshBtn);
        hideButton(ui.revealBtn);
        showButton(ui.laterBtn);
    };

    const showUpToDate = () => {
        show();
        setProgress(MAX_PROGRESS);
        setStatus("DejaVu is up to date.");
        setLaterLabel("Close");
        hideButton(ui.downloadBtn);
        hideButton(ui.refreshBtn);
        hideButton(ui.revealBtn);
        showButton(ui.laterBtn);
        const title = document.getElementById("updateInstallTitle");
        if (title) title.textContent = "DejaVu is up to date";
        const description = document.getElementById("updateInstallDescription");
        if (description) {
            description.textContent =
                "You are running the latest version of DejaVu.";
        }
    };

    window.dejavu_showUpdateInstall = (version, assetUrl, assetName, releaseUrl) => {
        state.version = version || "";
        state.assetUrl = assetUrl || "";
        state.assetName = assetName || "";
        state.releaseUrl = releaseUrl || "";
        state.downloadedPath = "";
        state.installedPath = "";
        const title = document.getElementById("updateInstallTitle");
        if (title) title.textContent = `DejaVu ${version} is available`;
        const description = document.getElementById("updateInstallDescription");
        if (description) {
            description.textContent = canInstallInPlace() && isArchiveAsset()
                ? "Install the new version into this Illustrator panel, then restart the panel to load it."
                : "A newer version is available. Download it, then install it from the package.";
        }
        show();
        setProgress(0);
        setStatus(canInstallInPlace() && isArchiveAsset()
            ? "Ready to install"
            : "Ready to download");
    };

    window.dejavu_showUpdateChecking = showChecking;
    window.dejavu_showUpdateUpToDate = showUpToDate;
})();
