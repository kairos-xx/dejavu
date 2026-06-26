<div align="center">

<img src="docs/logo.svg" alt="DejaVu logo" width="120" height="120" />

# DejaVu

### Never lose Adobe Illustrator work again.

**A local, change-aware autosave and recovery panel for Illustrator.**

[![CI](https://github.com/joaoslopes/dejavu/actions/workflows/ci.yml/badge.svg)](https://github.com/joaoslopes/dejavu/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/joaoslopes/dejavu?label=download&color=4d94d9)](https://github.com/joaoslopes/dejavu/releases/latest)
[![Illustrator](https://img.shields.io/badge/Adobe%20Illustrator-2022%2B-f5a623)](https://www.adobe.com/products/illustrator.html)
[![Privacy](https://img.shields.io/badge/privacy-local%20only-46a758)](#privacy)

</div>

---

## Why DejaVu exists

Illustrator is where expensive minutes disappear: a crash, a power cut, a bad save, a file closed in the wrong moment. DejaVu gives Illustrator a safety net that feels native: it keeps timestamped copies of your documents, tracks unsaved work, and puts every recoverable version in one panel.

No account. No cloud. No background service. Your artwork stays on your computer.

## Highlights

| Feature | Why it matters |
|---|---|
| **Change-aware autosave** | Saves only when artwork actually changed, so your backup folder stays useful instead of noisy. |
| **Timeline** | Browse previous versions by time, size, note, pin state, and file availability. |
| **Recovery Center** | Reopen recent autosave versions after a crash, including versions of documents that were never saved to disk. |
| **Open Documents** | See all currently open Illustrator files, save them individually, or bulk-save in one move. |
| **Named checkpoints** | Pin important versions like `Client approved`, `Before outline`, or `Print handoff`. |
| **Retention rules** | Keep the last N versions, the last N days, or stay under a folder-size cap. |
| **Smart paths** | Build folders and filenames with tokens such as `$filename`, `$YYYY`, `$hh`, and `$mm`. |
| **Native panel feel** | Matches Illustrator brightness themes and runs inside the Illustrator workspace. |
| **In-panel updates** | DejaVu can detect GitHub releases, download the zip, install it into the current CEP extension folder, and restart the panel. |

DejaVu respects the current document format where possible: `.ai`, `.pdf`, `.svg`, and other Illustrator save/export paths are kept consistent with the source document.

## Install

Download the latest release from [github.com/joaoslopes/dejavu/releases/latest](https://github.com/joaoslopes/dejavu/releases/latest).

### Recommended: zip install

1. Download `DejaVu-x.y.z.zip`.
2. Unzip it. You should get a folder named `DejaVu`.
3. Move that `DejaVu` folder into your CEP extensions folder:

| Platform | Folder |
|---|---|
| macOS | `~/Library/Application Support/Adobe/CEP/extensions/` |
| Windows | `%APPDATA%\Adobe\CEP\extensions\` |

4. Restart Illustrator.
5. Open **Window -> Extensions -> DejaVu**.

If the CEP folder does not exist yet, create it. If Illustrator hides unsigned CEP extensions on your machine, enable them once or install the signed `.zxp` package when a release includes one.

### Optional: zxp install

If the release includes `DejaVu-x.y.z.zxp`, install it with a ZXP installer such as [ZXP/UXP Installer](https://aescripts.com/learn/zxp-installer/), then restart Illustrator.

## First Run

1. Open an Illustrator document.
2. Open **DejaVu**.
3. Choose **On current** to protect one document or **On all** to protect every open document.
4. Pick a save interval.
5. Keep designing.

When you need to go back, open **Timeline**. After a crash, open **Recovery Center**. For everything currently open in Illustrator, use **Open Documents**.

## Updates

DejaVu checks GitHub Releases about once a week when update checks are enabled. If a newer version is available, the panel shows an update dialog.

In CEP builds with filesystem access, DejaVu can:

1. download the release zip,
2. back up the current installed panel files,
3. install the new panel files into the current extension folder,
4. restart the panel.

If direct install is unavailable, it still downloads the package and offers to reveal it so you can install manually.

Update checks are configured in `manifest.json`:

```jsonc
"updateCheck": {
  "enabled": true,
  "owner": "joaoslopes",
  "repo": "dejavu",
  "intervalDays": 7,
  "includePrereleases": false,
  "apiBase": "https://api.github.com",
  "releasesPageUrl": ""
}
```

## Privacy

DejaVu is local-first:

- autosave versions are written to folders you choose,
- update checks only read public GitHub Release metadata,
- document contents are never uploaded by DejaVu,
- no account, analytics, or external service is required.

## Development

DejaVu is a shared client with host bridges for Illustrator panel runtimes:

- `client/` contains the HTML, CSS, and panel JavaScript,
- `host/host.jsx` is the CEP ExtendScript bridge,
- `host/host.js` is the UXP-style bridge,
- `client/js/core.js` contains pure logic covered by Node tests.

Run checks:

```bash
npm install
npm test
npm run lint
```

Build a local package:

```bash
./scripts/build.sh
```

That writes:

- `build/DejaVu-<version>.zip`
- `build/DejaVu-<version>.zxp` when `ZXP_CERT`, `ZXP_PASS`, and `ZXPSignCmd` are available
- `build/SHA256SUMS.txt`
- `build/dejavu-release.json`

## Release

Run the release manager:

```bash
python3 scripts/release.py
```

The TUI can initialize local git, set or repair `origin`, configure the GitHub repository, bump versions, build packages, create the GitHub repo if needed, commit, tag, push, create the release, and upload artifacts.

For a non-interactive local package build:

```bash
python3 scripts/release.py --build-only --bump none
```

For a non-interactive GitHub release:

```bash
GITHUB_TOKEN=ghp_... python3 scripts/release.py --repo joaoslopes/dejavu --bump patch
```

If `GITHUB_TOKEN`/`GH_TOKEN` is not set, the TUI can use `gh auth token` from GitHub CLI or prompt for a token.

GitHub Actions also publishes releases automatically when you push a tag that matches the manifest version:

```bash
git tag v1.5.0
git push origin v1.5.0
```

## Support

DejaVu is free. If it saves a deadline, a client revision, or a long night of artwork, you can support development at [ko-fi.com/joaoslopes](https://ko-fi.com/joaoslopes).

<div align="center">

Made for designers who want to create without worrying about the next crash.

</div>
