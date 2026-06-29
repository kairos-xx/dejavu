/**
 * DejaVu — split from the original client/js/main.js.
 *
 * This file preserves the original statements and function bodies;
 * it only moves them into a responsibility-focused script file.
 */
"use strict";

const callHost = (fnName, args, retried) => {
    return host.call(fnName, args, retried);
};

if (typeof window !== "undefined") {
    window.callHost = callHost;
}

/**
 * Refreshes the status section with the active document's info.
 */
const refreshDocStatus = () => {
    return callHost("dejavu_getActiveDocInfo", [false]).then((info) => {
        if (!info || info.ok === false) {
            updateCurrentDocument(null);
            el.docNameValue.textContent = "host error";
            el.docNameValue.dataset.baseName = "";
            el.docNameValue.dataset.dejavuFormat = "ai";
            updateFormatIndicator("");
            syncDejavuModeUi();
            syncDejavuLoop();
            setHint(
                `Host error: ${(info && info.error ? info.error : "unknown")}`,
                "warn"
            );
            return info;
        }
        if (!info.hasDoc) {
            updateCurrentDocument(info);
            el.docNameValue.textContent = "no document open";
            el.docNameValue.dataset.baseName = "";
            el.docNameValue.dataset.dejavuFormat = "ai";
            updateFormatIndicator("");
            syncDejavuModeUi();
            syncDejavuLoop();
            return info;
        }
        const documentChanged = updateCurrentDocument(info);
        pruneRecoveryCandidatesForSavedDocument(info);
        el.docNameValue.textContent = info.docName;
        el.docNameValue.dataset.baseName = info.baseName;
        el.docNameValue.dataset.dejavuFormat = info.dejavuFormat || "ai";
        updateFormatIndicator(info.dejavuFormat);
        updatePreview();
        syncDejavuModeUi();
        syncDejavuLoop();
        if (documentChanged) scheduleDocumentSwitchDejavu();
        return finalizePendingFolderIfNeeded(info);
    });
};

/**
 * Sets the header status dot active/inactive (green when active).
 * Preserves the existing call sites that pass a boolean; routed
 * through the richer state machine in setDotState.
 * @param {boolean} active
 */
const setStatusDot = (active) => {
    // An explicit error state takes priority and is cleared only by
    // setDotState("idle"/"saving") on the next successful cycle.
    if (state.dotError && !active) return;
    // While a save is in flight, keep the pulsing "saving" state —
    // otherwise a setStatusDot(true) call mid-cycle would overwrite
    // it with steady green and the LED would never visibly blink.
    if (state.isSaving && active) {
        setDotState("saving");
        return;
    }
    setDotState(active ? "active" : "off");
};

/**
 * Drives the header LED through its visual states:
 *  - "off": dim (dejavu disabled / no document).
 *  - "active": steady green (enabled and idle).
 *  - "saving": pulsing green↔blue (a save is in flight).
 *  - "error": steady red (last operation failed), sticky until the
 *    next successful save clears it.
 * @param {string} stateName
 */
const setDotState = (stateName) => {
    if (!el.statusDot) return;
    const dot = el.statusDot;
    const title = el.appTitle || document.querySelector(".app__title");
    // Do not remove/re-add the saving class during mid-cycle status
    // refreshes: doing so restarts the finite three-pulse animation.
    if (
        stateName === "saving" &&
        dot.classList.contains("app__dot--saving")
    ) {
        dot.classList.add("app__dot--active");
        if (title) title.classList.add("app__title--running");
        state.dotError = false;
        return;
    }
    dot.classList.remove(
        "app__dot--active",
        "app__dot--saving",
        "app__dot--error"
    );
    if (stateName === "error") {
        state.dotError = true;
        if (title) title.classList.remove("app__title--running");
        dot.classList.add("app__dot--error");
        return;
    }
    // Any non-error state clears a previous error latch.
    state.dotError = false;
    if (stateName === "active") {
        if (title) title.classList.add("app__title--running");
        dot.classList.add("app__dot--active");
    } else if (stateName === "saving") {
        // Keep the green "active" base so the pulse reads as
        // green→blue rather than blue→off.
        if (title) title.classList.add("app__title--running");
        dot.classList.add("app__dot--active");
        dot.classList.add("app__dot--saving");
    } else if (title) {
        title.classList.remove("app__title--running");
    }
};

/**
 * Swaps the header project mark between the static and running SVG.
 * The icon injector prioritizes data-icon over legacy classes, so
 * this must update the explicit icon name instead of only toggling a class.
 * @param {boolean} active True while a dejavu save is in flight.
 */
const setAppLogoSaving = (active) => {
    if (!el.appLogo) return;
    const iconName = active ? "app-logo-anim-css" : "app-logo";
    if (el.appLogo.getAttribute("data-icon") === iconName) return;
    el.appLogo.setAttribute("data-icon", iconName);
    el.appLogo.classList.toggle("app__logo--anim", !!active);
    if (window.dejavu && window.dejavu.injectIcon) {
        window.dejavu.injectIcon(el.appLogo);
    }
};

/**
 * Reflects the active save mode in the status area. Native dejavus
 * save the original and copy it to the snapshot path, so the active
 * document always stays attached to its original file.
 */
const updateModeIndicator = () => {
    if (!el.modeValue) return;
    const dejavuMode = getDejavuModeLabel(getDejavuDisplayMode());
    el.modeValue.textContent = `${dejavuMode} · Attached`;
    el.modeValue.classList.toggle(
        "status__value--warn",
        !isDejavuEnabledForCurrent()
    );
    setAppLogoSaving(!!state.isSaving);
};

/**
 * Shows the format the active document will dejavu as, derived
 * from its real extension (so a .svg shows "SVG", a .pdf "PDF",
 * etc.). Reinforces that dejavu preserves the document's own
 * format rather than always writing .ai.
 * @param {string} format Lowercase extension (ai/pdf/eps/svg).
 */
const updateFormatIndicator = (format) => {
    if (!el.formatValue) return;
    const normalized = (format || "ai").toUpperCase();
    const formatLower = (format || "ai").toLowerCase();
    const row = el.formatValue.closest(".status__row");
    if (row) {
        row.classList.remove(
            "status__row--format-ai",
            "status__row--format-pdf",
            "status__row--format-eps",
            "status__row--format-svg"
        );
        row.classList.add("status__row--format", `status__row--format-${formatLower}`);
    }

    el.formatValue.innerHTML = "";

    const iconClass = `icon-format-${formatLower}`;
    const icon = document.createElement("span");
    icon.className = DEJAVU.classNames("svg-icon", iconClass);
    icon.dataset.icon = `format-${formatLower}`;
    icon.setAttribute("aria-hidden", "true");
    if (window.dejavu && window.dejavu.injectIcon) {
        window.dejavu.injectIcon(icon);
    }
    el.formatValue.appendChild(icon);

    const text = document.createElement("span");
    text.textContent = normalized;
    el.formatValue.appendChild(text);
};

/**
 * Shows the resolved dejavu path (root folder + filename via the folder
 * template) in the status block. While there is no trusted root — i.e. the
 * typed default folder hasn't validated on disk — the previously shown
 * (last valid) value is kept rather than flickering to a placeholder
 * (3.1b). The default starting value is "~/" resolved on first validation.
 * @param {string=} path Optional caller-supplied root folder candidate.
 */
const updateFolderStatus = () => {
    if (!el.folderStatusValue) return;
    const rootFolder = resolveDejavuRootFolder();
    if (rootFolder === null) return; // keep the last valid value
    el.folderStatusValue.textContent = buildResolvedDejavuPath(rootFolder);
};

/**
 * Formats a Date as a short local time string for the status row.
 * @param {Date} d
 * @return {string}
 */
const formatTime = (d) => {
    return Fmt.time(d);
};

const setHint = (message, kind) => {
    el.footerHint.textContent = message || "";
    el.footerHint.classList.remove(
        "footer__hint--warn",
        "footer__hint--ok"
    );
    if (kind === "warn") el.footerHint.classList.add("footer__hint--warn");
    if (kind === "ok") el.footerHint.classList.add("footer__hint--ok");
};

/**
 * Converts any raw donation amount to a safe positive integer.
 * @param {*} value Amount read from the input or settings.
 * @return {number} Positive whole-number amount.
 */
const normalizeDonationAmount = (value) => {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 1) return DONATION_CONFIG.defaultAmount;
    return parsed;
};

/**
 * Keeps the donation currency inside the currencies offered by the
 * splash. The selected support platform may still apply the
 * creator account's own currency rules after opening.
 * @param {*} value Raw currency value.
 * @return {string} EUR, USD, or GBP.
 */
const normalizeDonationCurrency = (value) => {
    const currency = String(value || DONATION_CONFIG.defaultCurrency)
        .toUpperCase();
    if (currency === "EUR" || currency === "USD" || currency === "GBP") {
        return currency;
    }
    return DONATION_CONFIG.defaultCurrency;
};

/**
 * Keeps the donation platform inside the configured support pages.
 * @param {*} value Raw platform key.
 * @return {string} Configured platform key.
 */
const normalizeDonationPlatform = (value) => {
    const platform = String(value || DONATION_CONFIG.defaultPlatform);
    if (DONATION_CONFIG.platforms[platform]) return platform;
    return DONATION_CONFIG.defaultPlatform;
};

/**
 * Builds a creator support URL for Ko-fi or Buy Me a Coffee. The
 * selected amount and currency are included as query parameters so
 * supported pages can prefill the payment form, while unsupported
 * pages still open safely on the creator profile. No payment
 * credentials or card details ever pass through the extension.
 * @param {number} amount Positive integer amount.
 * @param {string} currency ISO currency code.
 * @param {string} platform Support platform key.
 * @return {string} Creator support URL.
 */
const buildDonationUrl = (amount, currency, platform) => {
    const safeAmount = normalizeDonationAmount(amount);
    const safeCurrency = normalizeDonationCurrency(currency);
    const safePlatform = normalizeDonationPlatform(platform);
    const config = DONATION_CONFIG.platforms[safePlatform];
    const query = [
        `amount=${encodeURIComponent(String(safeAmount))}`,
        `currency=${encodeURIComponent(safeCurrency)}`,
        `message=${encodeURIComponent(DONATION_CONFIG.itemName)}`
    ];
    return `${config.baseUrl}?${query.join("&")}`;
};

/**
 * Persists that the splash was closed for the current install.
 */
const markDonationSplashDismissed = () => {
    let signature = state.installSignature ||
        state.settings.installSignature ||
        "unknown-install";
    state.settings.installSignature = signature;
    state.settings.donationDismissedInstallSignature = signature;
    state.settings.donationAmount = normalizeDonationAmount(
        el.donationAmountInput ? el.donationAmountInput.value :
            state.settings.donationAmount
    );
    state.settings.donationCurrency = normalizeDonationCurrency(
        el.donationCurrencySelect ? el.donationCurrencySelect.value :
            state.settings.donationCurrency
    );
    saveSettings();
};

/**
 * Opens the donation splash. Forced opens do not depend on first
 * launch state and are used by the small footer info button.
 * @param {boolean} forced True when opened by the info button.
 */
const showDonationSplash = (forced) => {
    if (!el.donationModal) return;
    if (!forced) {
        let signature = state.installSignature || "unknown-install";
        const dismissed = state.settings.donationDismissedInstallSignature;
        if (dismissed && dismissed === signature) return;
    }
    const amount = normalizeDonationAmount(state.settings.donationAmount);
    const currency = normalizeDonationCurrency(state.settings.donationCurrency);
    if (el.donationAmountInput) el.donationAmountInput.value = amount;
    if (el.donationCurrencySelect) el.donationCurrencySelect.value = currency;
    if (el.donationVersion && typeof DEJAVU_CONFIG !== "undefined") {
        el.donationVersion.textContent = `v${DEJAVU_CONFIG.version}`;
    }
    if (el.donationGithubUrl && typeof DEJAVU_CONFIG !== "undefined") {
        const owner = DEJAVU_CONFIG.updateCheck.owner;
        const repo = DEJAVU_CONFIG.updateCheck.repo;
        const githubUrl = `https://github.com/${owner}/${repo}`;
        el.donationGithubUrl.textContent = githubUrl;
        el.donationGithubUrl.href = githubUrl;
        el.donationGithubUrl.title = `Open ${githubUrl} in browser`;
    }
    Tooltip.hide();
    el.donationModal.classList.remove("donation-modal--hidden");
    window.setTimeout(() => {
        if (el.donationAmountInput) {
            el.donationAmountInput.focus();
            el.donationAmountInput.select();
        }
    }, 30);
};

/**
 * Closes the splash and remembers it for this installed copy.
 */
const closeDonationSplash = () => {
    if (!el.donationModal) return;
    markDonationSplashDismissed();
    el.donationModal.classList.add("donation-modal--hidden");
};

/**
 * Opens a Ko-fi or Buy Me a Coffee support page with the selected amount.
 * @param {string} platform Support platform key.
 */
const openDonationPayment = (platform) => {
    const amount = normalizeDonationAmount(
        el.donationAmountInput ? el.donationAmountInput.value :
            DONATION_CONFIG.defaultAmount
    );
    const currency = normalizeDonationCurrency(
        el.donationCurrencySelect ? el.donationCurrencySelect.value :
            DONATION_CONFIG.defaultCurrency
    );
    const safePlatform = normalizeDonationPlatform(platform);
    state.settings.donationAmount = amount;
    state.settings.donationCurrency = currency;
    state.settings.donationPlatform = safePlatform;
    const url = buildDonationUrl(amount, currency, safePlatform);
    try {
        if (window.DejaVuHost &&
                typeof window.DejaVuHost.dejavu_openExternalUrl === "function") {
            window.DejaVuHost.dejavu_openExternalUrl(url);
        } else {
            window.open(url, "_blank");
        }
        setHint("Donation page opened in your browser.", "ok");
    } catch (e) {
        window.open(url, "_blank");
        setHint("Donation page opened.", "ok");
    }
    closeDonationSplash();
};

/**
 * Reads a filesystem-based installation signature from UXP host.
 * A reinstall produces a different created/modified timestamp on
 * the bundled files, so old localStorage does not suppress the
 * first-run splash for a new copy.
 */
const syncInstallSignatureAndSplash = () => {
    callHost("dejavu_getInstallSignature", []).then((result) => {
        let signature = "unknown-install";
        if (result && result.ok && result.signature) {
            signature = String(result.signature);
        }
        state.installSignature = signature;
        state.settings.installSignature = signature;
        saveSettings();
        showDonationSplash(false);
    });
};
/**
 * Shows or hides the thin indeterminate saving bar and recolors
 * the countdown ring to signal "saving now". The panel runs in its
 * own process, so this animation stays smooth even while
 * Illustrator's main thread is busy performing the actual save.
 * @param {boolean} active
 */
const setSaving = (active) => {
    if (state.savingClearTimer) {
        window.clearTimeout(state.savingClearTimer);
        state.savingClearTimer = null;
    }
    if (active) {
        state.savingShownAt = Date.now();
        applySavingVisuals(true);
        return;
    }
    // A save can finish in well under a frame, so hold the saving
    // indicator (bar + pulsing LED) for a short minimum so it is
    // actually perceptible as a blink rather than never showing.
    const elapsed = Date.now() - (state.savingShownAt || 0);
    const remaining = Math.max(0, SAVING_MIN_VISIBLE_MS - elapsed);
    if (remaining === 0) {
        applySavingVisuals(false);
        return;
    }
    state.savingClearTimer = window.setTimeout(() => {
        state.savingClearTimer = null;
        applySavingVisuals(false);
    }, remaining);
};

/**
 * Applies (or clears) the in-progress save visuals: the thin top
 * progress bar, the countdown ring tint, and the pulsing header LED.
 * @param {boolean} active
 */
const applySavingVisuals = (active) => {
    setAppLogoSaving(!!active);
    if (el.savingBar) {
        el.savingBar.classList.toggle("is-active", !!active);
        el.savingBar.setAttribute(
            "aria-hidden",
            active ? "false" : "true"
        );
    }
    if (el.countdownPie) {
        el.countdownPie.classList.toggle("is-saving", !!active);
    }
    if (active) {
        setDotState("saving");
    } else if (!state.dotError) {
        // Return to steady green/idle unless an error was just
        // latched by the failing cycle.
        setDotState(isDejavuEnabledForCurrent() ? "active" : "off");
    }
};

/**
 * Paints the countdown ring to reflect the fraction of the current
 * interval still remaining. A full ring means "just saved / full
 * wait ahead"; it sweeps down to empty as the next dejavu nears.
 * Driven by requestAnimationFrame so the sweep is smooth rather
 * than ticking once per second.
 */
const updateCountdownPie = () => {
    if (!el.countdownPieSweep) return;
    let fractionRemaining = 0;
    const snoozed = isSnoozed();
    const retryIsNext = !!(
        state.retryAt &&
        (!state.nextTickAt || state.retryAt < state.nextTickAt)
    );
    const dueAt = snoozed
        ? state.snoozeUntil
        : (retryIsNext ? state.retryAt : state.nextTickAt);
    const totalMs = snoozed
        ? state.snoozeTotalMs
        : (retryIsNext ? state.retryDelayMs : state.intervalTotalMs);
    if (dueAt && totalMs > 0) {
        const remainingMs = dueAt - Date.now();
        fractionRemaining = Math.max(
            0,
            Math.min(1, remainingMs / totalMs)
        );
    }
    // stroke-dashoffset 0 = full ring; full circumference = empty.
    const offset = COUNTDOWN_RING_CIRCUMFERENCE *
        (1 - fractionRemaining) * (snoozed ? -1 : 1);
    el.countdownPieSweep.style.strokeDashoffset = String(offset);
};

/**
 * Runs the smooth ring repaint loop while the loop is active.
 * Uses requestAnimationFrame and reschedules itself; stopLoop
 * cancels it.
 */
const startPieAnimation = () => {
    stopPieAnimation();
    const tick = () => {
        updateCountdownPie();
        state.pieRafId = window.requestAnimationFrame(tick);
    };
    state.pieRafId = window.requestAnimationFrame(tick);
};

const stopPieAnimation = () => {
    if (state.pieRafId !== null) {
        window.cancelAnimationFrame(state.pieRafId);
        state.pieRafId = null;
    }
};

/**
 * Updates the "next check" countdown text every second.
 */
const updateCountdown = () => {
    if (isSnoozed()) {
        const snoozeRemainingMs = state.snoozeUntil - Date.now();
        const snoozeSeconds = Math.max(
            0,
            Math.ceil(snoozeRemainingMs / 1000)
        );
        const snoozeMinutes = Math.floor(snoozeSeconds / 60);
        const snoozeRemainder = snoozeSeconds % 60;
        el.nextCheckValue.textContent =
            `${snoozeMinutes > 0 ? `${snoozeMinutes}m ` : ""}${snoozeRemainder}s`;
        return;
    }
    const retryIsNext = !!(
        state.retryAt &&
        (!state.nextTickAt || state.retryAt < state.nextTickAt)
    );
    const dueAt = retryIsNext ? state.retryAt : state.nextTickAt;
    if (!dueAt) {
        el.nextCheckValue.textContent = "—";
        return;
    }
    const remainingMs = dueAt - Date.now();
    if (remainingMs <= 0) {
        el.nextCheckValue.textContent = "now";
        return;
    }
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    el.nextCheckValue.textContent =
        `${retryIsNext ? "retry " : ""}${m > 0 ? `${m}m ` : ""}${s}s`;
};
