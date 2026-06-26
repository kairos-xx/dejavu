/*
 * DejaVu — GitHub update check.
 *
 * Pings the project's GitHub Releases once per configured interval (default
 * weekly), compares the latest published version to the installed one, and
 * shows a single dismissible banner when a newer build exists. Everything is
 * configurable from manifest.json → dejavu.updateCheck (read into the
 * global DEJAVU_CONFIG by main.js): enabled, owner, repo, intervalDays,
 * includePrereleases, apiBase, releasesPageUrl.
 *
 * Fully self-contained and defensive: if config/network/fetch is unavailable
 * it silently does nothing — it never blocks the panel.
 */
"use strict";

(() => {
    const STORAGE_KEY = "dejavuai.updateCheck.v1";
    const DAY_MS = 86400000;
    const STARTUP_DELAY_MS = 1500;

    const getConfig = () => (typeof DEJAVU_CONFIG !== "undefined" &&
        DEJAVU_CONFIG.updateCheck) || null;

    const installedVersion = () => (typeof DEJAVU_CONFIG !== "undefined" &&
        DEJAVU_CONFIG.version) || "0.0.0";

    const readState = () => {
        try {
            return JSON.parse(window.localStorage.getItem(STORAGE_KEY)) || {};
        } catch {
            return {};
        }
    };

    const writeState = (state) => {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {}
    };

    /** Parse "v1.5.0" → [1,5,0]. */
    const parseVersion = (value) => {
        return String(value || "")
            .replace(/^v/i, "")
            .split(/[.\-+]/)
            .map((n) => parseInt(n, 10) || 0);
    };

    /** True when version `a` is strictly newer than version `b`. */
    const isNewer = (a, b) => {
        const pa = parseVersion(a);
        const pb = parseVersion(b);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const x = pa[i] || 0;
            const y = pb[i] || 0;
            if (x > y) return true;
            if (x < y) return false;
        }
        return false;
    };

    const releasesUrl = (config, state) => {
        return (state && state.latestUrl) ||
            config.releasesPageUrl ||
            `https://github.com/${config.owner}/${config.repo}/releases`;
    };

    const openExternal = (url) => {
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

    const showBanner = (version, url) => {
        if (document.querySelector(".update-banner")) return;
        const bar = document.createElement("div");
        bar.className = "update-banner";
        bar.setAttribute("role", "status");

        const text = document.createElement("span");
        text.className = "update-banner__text";
        text.textContent = `DejaVu ${version} is available`;

        const action = document.createElement("button");
        action.type = "button";
        action.className = "update-banner__action";
        action.textContent = "What's new";
        action.addEventListener("click", () => openExternal(url));

        const close = document.createElement("button");
        close.type = "button";
        close.className = "update-banner__close";
        close.setAttribute("aria-label", "Dismiss");
        close.textContent = "×";
        close.addEventListener("click", () => {
            const state = readState();
            state.dismissed = version;
            writeState(state);
            bar.remove();
        });

        bar.appendChild(text);
        bar.appendChild(action);
        bar.appendChild(close);

        const app = document.querySelector(".app") || document.body;
        app.insertBefore(bar, app.firstChild);
    };

    const selectReleaseAsset = (assets) => {
        if (!Array.isArray(assets)) return null;
        const downloadable = assets.filter((asset) =>
            asset && typeof asset.browser_download_url === "string"
        );
        const zip = downloadable.find((asset) =>
            /\.zip$/i.test(String(asset.name || ""))
        );
        if (zip) return zip;
        const zxp = downloadable.find((asset) =>
            /\.zxp$/i.test(String(asset.name || ""))
        );
        return zxp || downloadable[0] || null;
    };

    const fetchLatestRelease = async (config) => {
        const base = config.apiBase || "https://api.github.com";
        const repo = `${config.owner}/${config.repo}`;
        const headers = { Accept: "application/vnd.github+json" };
        if (config.includePrereleases) {
            const res = await fetch(
                `${base}/repos/${repo}/releases?per_page=1`,
                { headers }
            );
            if (!res.ok) return null;
            const list = await res.json();
            return Array.isArray(list) && list[0] ? list[0] : null;
        }
        const res = await fetch(
            `${base}/repos/${repo}/releases/latest`,
            { headers }
        );
        if (!res.ok) return null;
        return res.json();
    };

    /** Shows the banner if a known-latest version beats the installed one. */
    const maybeShow = (config, state) => {
        if (!state.latest) return;
        if (!isNewer(state.latest, installedVersion())) return;
        // Don't re-nag for a version the user already dismissed (a brand-new
        // version newer than the dismissed one will still surface).
        if (state.dismissed && !isNewer(state.latest, state.dismissed)) return;
        const asset = config.latestAsset || null;
        const assetUrl = state.latestAssetUrl ||
            (asset && asset.browser_download_url) ||
            "";
        const assetName = state.latestAssetName ||
            (asset && asset.name) ||
            "";
        if (typeof window.dejavu_showUpdateInstall === "function") {
            window.dejavu_showUpdateInstall(
                state.latest,
                assetUrl,
                assetName,
                releasesUrl(config, state)
            );
        } else {
            showBanner(state.latest, releasesUrl(config, state));
        }
    };

    const isUpdateCheckEnabled = () => {
        const config = getConfig();
        if (!config || config.enabled === false) return false;
        if (typeof window.dejavu_isUpdateCheckEnabled === "function") {
            return window.dejavu_isUpdateCheckEnabled();
        }
        return true;
    };

    const check = async (config, state) => {
        if (!config || !config.owner || !config.repo) return;
        if (typeof fetch !== "function") return;

        try {
            const release = await fetchLatestRelease(config);
            if (!release || !release.tag_name) return;
            state.latest = release.tag_name;
            state.latestUrl = release.html_url || releasesUrl(config, state);
            const assets = Array.isArray(release.assets) ? release.assets : [];
            config.latestAsset = selectReleaseAsset(assets);
            state.latestAssetUrl = config.latestAsset
                ? config.latestAsset.browser_download_url
                : "";
            state.latestAssetName = config.latestAsset
                ? config.latestAsset.name
                : "";
            writeState(state);
        } catch {
            // Network/parse failure — try again next interval.
        }
    };

    const run = async () => {
        if (!isUpdateCheckEnabled()) return;
        const config = getConfig();
        if (!config || !config.owner || !config.repo) return;
        if (typeof fetch !== "function") return;

        const state = readState();
        const intervalMs =
            Math.max(1, Number(config.intervalDays) || 7) * DAY_MS;
        const now = Date.now();

        // Within the throttle window: don't hit the network, but still show a
        // previously-discovered update.
        if (state.lastCheck && now - state.lastCheck < intervalMs) {
            maybeShow(config, state);
            return;
        }

        // Record the attempt up front so a failed/offline check still respects
        // the once-per-interval cadence.
        state.lastCheck = now;
        writeState(state);

        await check(config, state);
        maybeShow(config, state);
    };

    const checkNow = async () => {
        if (typeof window.dejavu_showUpdateChecking === "function") {
            window.dejavu_showUpdateChecking();
        }
        const config = getConfig();
        if (!config || !config.owner || !config.repo) {
            if (typeof window.dejavu_showUpdateUpToDate === "function") {
                window.dejavu_showUpdateUpToDate();
            }
            return;
        }
        const state = readState();
        await check(config, state);
        if (state.latest && isNewer(state.latest, installedVersion())) {
            maybeShow(config, state);
        } else if (typeof window.dejavu_showUpdateUpToDate === "function") {
            window.dejavu_showUpdateUpToDate();
        }
    };

    window.dejavu_checkForUpdatesNow = checkNow;

    const start = () => window.setTimeout(run, STARTUP_DELAY_MS);
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
