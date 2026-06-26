#!/usr/bin/env python3
"""DejaVu — one-command release manager."""

from __future__ import annotations

import signal
from argparse import ArgumentParser, Namespace
from dataclasses import dataclass
from datetime import UTC, datetime
from getpass import getpass
from hashlib import sha256
from http.client import HTTPResponse, HTTPSConnection
from json import dumps, loads
from logging import INFO, Formatter, Logger, StreamHandler, getLogger
from mimetypes import guess_type
from os import environ
from pathlib import Path
from re import compile as re_compile
from re import findall as re_findall
from re import split as re_split
from re import sub as re_sub
from shutil import copy2, copytree, rmtree, which
from subprocess import DEVNULL, CompletedProcess
from subprocess import run as subprocess_run
from sys import argv as sys_argv
from sys import exit as sys_exit
from typing import TYPE_CHECKING, NoReturn, TextIO, TypedDict, cast

if TYPE_CHECKING:
    from collections.abc import Callable
from urllib.parse import SplitResult, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile

from rich import box
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskID,
    TaskProgressColumn,
    TextColumn,
)
from rich.table import Table
from rich.text import Text

type Json = None | bool | int | float | str | list[Json] | dict[str, Json]

ROOT: Path = Path(__file__).resolve().parent.parent
MANIFEST_JSON: Path = ROOT / "manifest.json"
MANIFEST_XML: Path = ROOT / "CSXS" / "manifest.xml"
BUILD_DIR: Path = ROOT / "build"
API: str = "https://api.github.com"
UPLOADS: str = "https://uploads.github.com"

_LOGGER: Logger = getLogger(name="dejavu")
_LOGGER.setLevel(level=INFO)
if not _LOGGER.handlers:
    _HANDLER: StreamHandler[TextIO] = StreamHandler(stream=None)
    _HANDLER.setFormatter(
        fmt=Formatter(
            fmt="%(message)s",
            datefmt=None,
            style="%",
            validate=True,
            defaults=None,
        ),
    )
    _LOGGER.addHandler(hdlr=_HANDLER)

_CONSOLE: Console = Console()


def _make_progress() -> Progress:
    """Create a rich Progress bar for long-running operations."""
    return Progress(
        SpinnerColumn(),
        TextColumn("[bold cyan]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TextColumn("[dim]{task.fields[status]}"),
        console=_CONSOLE,
    )

HTTP_OK: int = 200
HTTP_CREATED: int = 201
HTTP_NOT_FOUND: int = 404
VERSION_PARTS: int = 3
REPO_PARTS: int = 2
BYTES_PER_KB: int = 1024
PACKAGE_NAME: str = "DejaVu"
EXTENSION_DIR_NAME: str = "DejaVu"
ANSI_ESCAPE_RE = re_compile(r"\x1b\[[0-9;]*[A-Za-z]")
STAGE_DIR: Path = BUILD_DIR / "staging"
CHECKSUMS_PATH: Path = BUILD_DIR / "SHA256SUMS.txt"
RELEASE_INFO_PATH: Path = BUILD_DIR / "dejavu-release.json"
STATE_FILE: Path = Path.home() / ".dejavu_release_state.json"


def _state_key() -> str:
    """Return a stable key for the current project in the global state file."""
    return str(ROOT.resolve())


def sanitize_input(value: str) -> str:
    """Strip ANSI escape sequences and control characters from a string."""
    value = ANSI_ESCAPE_RE.sub(repl="", string=value)
    value = "".join(
        char for char in value if char.isprintable() or char in " \t"
    )
    return value.strip()


def load_release_state() -> dict[str, Json]:
    """Load persisted release settings from the user's home directory."""
    if not STATE_FILE.exists():
        return {}
    try:
        text: str = STATE_FILE.read_text(encoding="utf-8")
        data: Json = cast(typ="Json", val=loads(s=text))
        if not isinstance(data, dict):
            return {}
        key = _state_key()
        project_state = data.get(key)
        if isinstance(project_state, dict):
            return project_state
        # Legacy: flat file written before project scoping.
        if any(
            field in data
            for field in ("repo", "branch", "bump", "token", "private")
        ):
            return cast(typ="dict[str, Json]", val=data)
    except (ValueError, OSError):
        pass
    return {}


def _write_state_file(state: dict[str, Json]) -> None:
    """Write the project-scoped release state to disk."""
    all_state: dict[str, Json] = {}
    if STATE_FILE.exists():
        try:
            text: str = STATE_FILE.read_text(encoding="utf-8")
            loaded: Json = cast(typ="Json", val=loads(s=text))
            if isinstance(loaded, dict):
                all_state = loaded
        except (ValueError, OSError):
            pass
    all_state[_state_key()] = state
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        data=dumps(obj=all_state, indent=2) + "\n",
        encoding="utf-8",
        errors="strict",
    )
    STATE_FILE.chmod(mode=0o600)


def persist_token(token: str) -> None:
    """Persist only the GitHub token to the release state file."""
    state: dict[str, Json] = load_release_state()
    state["token"] = token
    _write_state_file(state=state)


def save_release_state(args: Args) -> None:
    """Persist release settings (not the token) for later runs."""
    state: dict[str, Json] = load_release_state()
    state["repo"] = sanitize_input(value=str(args.repo or "")) or None
    state["branch"] = sanitize_input(value=str(args.branch or "")) or "main"
    state["private"] = args.private
    state["bump"] = args.bump
    state["prerelease"] = args.prerelease
    state["no_sign"] = args.no_sign
    _write_state_file(state=state)


def apply_release_state(args: Args) -> None:
    """Fill missing CLI defaults from previously saved release settings."""
    state: dict[str, Json] = load_release_state()
    if args.repo is None and isinstance(state.get("repo"), str):
        repo = sanitize_input(value=str(state["repo"]))
        if repo and len([p for p in repo.split("/") if p]) == REPO_PARTS:
            args.repo = repo
    if args.branch == "main" and isinstance(state.get("branch"), str):
        args.branch = sanitize_input(value=str(state["branch"])) or "main"
    if args.bump == "patch" and state.get("bump") in {
        "patch",
        "minor",
        "major",
        "none",
    }:
        args.bump = str(state["bump"])
    if not args.private and isinstance(state.get("private"), bool):
        args.private = bool(state["private"])
    if not args.prerelease and isinstance(state.get("prerelease"), bool):
        args.prerelease = bool(state["prerelease"])
    if not args.no_sign and isinstance(state.get("no_sign"), bool):
        args.no_sign = bool(state["no_sign"])


DEAD_FILES: tuple[str, ...] = (
    "client/js/main_es6.js",
    "host/host.legacy.jsx",
)
REQUIRED_PACKAGE_PATHS: tuple[str, ...] = (
    "manifest.json",
    "CSXS/manifest.xml",
    "client/index.html",
    "host/host.jsx",
)


# --------------------------------------------------------------------------- #
# Rich TUI helpers
# --------------------------------------------------------------------------- #
def info(msg: str) -> None:
    """Log a bold cyan section header."""
    _CONSOLE.print(f"[bold cyan]⟴[/bold cyan] {msg}")


def ok(msg: str) -> None:
    """Log a green success marker."""
    _CONSOLE.print(f"[green]  ✓[/green] {msg}")


def warn(msg: str) -> None:
    """Log a yellow warning marker."""
    _CONSOLE.print(f"[yellow]  ![/yellow] [dim]{msg}[/dim]")


def die(msg: str) -> NoReturn:
    """Log a fatal error and exit."""
    _CONSOLE.print(
        f"[bold red]  ✗[/bold red] [bold red]{msg}[/bold red]",
    )
    sys_exit(1)


def section(title: str) -> None:
    """Print a prominent section header with a surrounding rule."""
    _CONSOLE.rule(title=f"[bold cyan]{title}")


def tui_input(label: str, default: str = "", *, secret: bool = False) -> str:
    """Prompt for text in the release TUI."""
    _CONSOLE.print(
        f"[dim]DEBUG tui_input: label={label!r} default={default!r}[/dim]",
    )
    default = sanitize_input(value=default)
    suffix: str = f" [{default}]" if default else ""
    prompt: str = f"{label}{suffix}: "
    if secret:
        value: str = getpass(prompt=prompt).strip()
    else:
        value = _CONSOLE.input(prompt).strip()
    value = sanitize_input(value=value)
    return value or default


def tui_confirm(label: str, *, default: bool = True) -> bool:
    """Prompt for a yes/no answer in the release TUI."""
    hint: str = "Y/n" if default else "y/N"
    while True:
        answer: str = _CONSOLE.input(f"{label} [{hint}]: ").strip().lower()
        if not answer:
            return default
        if answer in {"y", "yes"}:
            return True
        if answer in {"n", "no"}:
            return False
        warn(msg="Please answer y or n.")


def tui_choice(label: str, choices: list[str], default: str) -> str:
    """Prompt for one value from a numbered list."""
    while True:
        _CONSOLE.print("")
        _CONSOLE.print(f"[bold]{label}[/bold]")
        for index, choice in enumerate(choices, start=1):
            if choice == default:
                _CONSOLE.print(
                    f"[bold green] * {index}. {choice}[/bold green]",
                )
            else:
                _CONSOLE.print(f"   {index}. {choice}")
        answer: str = _CONSOLE.input(f"Choose [{default}]: ").strip()
        if not answer:
            return default
        if answer.isdigit():
            idx: int = int(answer) - 1
            if 0 <= idx < len(choices):
                return choices[idx]
        if answer in choices:
            return answer
        warn(msg="Choose one of the listed options.")


def _gh_message(body: dict[str, Json] | str, code: int | str) -> str:
    """Extract a human-readable message from a GitHub response body."""
    if isinstance(body, dict):
        return str(body.get("message", code))
    return str(body)


def run(args: list[str]) -> CompletedProcess[str]:
    """Run a command at the repo root, raising on failure."""
    result: CompletedProcess[str] = subprocess_run(
        args=args,
        cwd=ROOT,
        stdin=None,
        stdout=None,
        stderr=None,
        capture_output=False,
        shell=False,
        check=True,
        encoding=None,
        errors=None,
        text=True,
        env=None,
    )
    return result


def run_ok(args: list[str]) -> bool:
    """Run a command, returning True on success (no raise)."""
    result: CompletedProcess[str] = subprocess_run(
        args=args,
        cwd=ROOT,
        stdin=None,
        stdout=DEVNULL,
        stderr=DEVNULL,
        capture_output=False,
        shell=False,
        check=False,
        encoding=None,
        errors=None,
        text=True,
        env=None,
    )
    return result.returncode == 0


def capture(args: list[str]) -> str:
    """Run a command and return its stripped stdout."""
    result: CompletedProcess[str] = subprocess_run(
        args=args,
        cwd=ROOT,
        stdin=None,
        capture_output=True,
        shell=False,
        check=False,
        encoding=None,
        errors=None,
        text=True,
        env=None,
    )
    stdout: str = result.stdout
    return stdout.strip()


def sha256_file(path: Path) -> str:
    """Return the SHA-256 hex digest for a file."""
    digest = sha256()
    with path.open(mode="rb") as handle:
        for chunk in iter(
            lambda: handle.read(BYTES_PER_KB * BYTES_PER_KB),
            b"",
        ):
            digest.update(chunk)
    return digest.hexdigest()


def format_size(size: int) -> str:
    """Format bytes as a compact human-readable size."""
    if size < BYTES_PER_KB:
        return f"{size} B"
    if size < BYTES_PER_KB * BYTES_PER_KB:
        return f"{size / BYTES_PER_KB:.1f} KB"
    return f"{size / BYTES_PER_KB / BYTES_PER_KB:.2f} MB"


def parse_origin_repo() -> str | None:
    """Best-effort OWNER/REPO inference from git remote origin."""
    remote: str = capture(args=["git", "remote", "get-url", "origin"])
    if not remote:
        return None
    remote = remote.removesuffix(".git")
    if remote.startswith("git@github.com:"):
        return remote.removeprefix("git@github.com:")
    if "github.com/" in remote:
        return remote.rsplit("github.com/", maxsplit=1)[-1]
    return None


def manifest_repo() -> str | None:
    """Return OWNER/REPO from manifest.json update-check settings."""
    manifest: dict[str, Json] = read_manifest()
    dejavu_cfg = manifest.get("dejavu", {})
    if not isinstance(dejavu_cfg, dict):
        return None
    update_cfg = dejavu_cfg.get("updateCheck", {})
    if not isinstance(update_cfg, dict):
        return None
    owner = str(update_cfg.get("owner", "")).strip()
    repo = str(update_cfg.get("repo", "")).strip()
    if owner and repo:
        return f"{owner}/{repo}"
    return None


def default_repo() -> str:
    """Best available default GitHub repository for the release manager."""
    return manifest_repo() or parse_origin_repo() or "OWNER/dejavu"


def default_repo_for_login(login: str | None) -> str:
    """Default OWNER/NAME from manifest, git origin, or authenticated login."""
    if repo := manifest_repo():
        return repo
    if origin := parse_origin_repo():
        return origin
    if login:
        return f"{login}/dejavu"
    return "OWNER/dejavu"


def gh_cli_token() -> str:
    """Return a GitHub CLI token when gh is installed and authenticated."""
    if not which(cmd="gh"):
        return ""
    return capture(args=["gh", "auth", "token"])


def discover_token(*, prompt: bool) -> tuple[str, str | None]:
    """Return (token, login), asking only when requested.

    A token entered via prompt is stored in the current process environment
    under GITHUB_TOKEN so the rest of the script and any child processes can
    reuse it without asking again. It is also persisted to the release state
    file so later runs do not need to re-prompt.
    """
    token: str = (
        environ.get("GITHUB_TOKEN")
        or environ.get("GH_TOKEN")
        or gh_cli_token()
        or ""
    ).strip()
    if not token:
        state: dict[str, Json] = load_release_state()
        saved_token: str = str(state.get("token", "")).strip()
        if saved_token:
            token = saved_token
            environ["GITHUB_TOKEN"] = token
            ok(msg="loaded saved GitHub token")

    prompted: bool = False
    if not token and prompt:
        token = tui_input(
            label="GitHub token (repo scope; input hidden)",
            secret=True,
        )
        prompted = bool(token)
    if not token:
        return "", None

    status: int
    user: dict[str, Json] | str
    status, user = gh(method="GET", url="/user", token=token)
    if status != HTTP_OK:
        if prompt:
            warn(msg=f"Token check failed ({status}).")
        return "", None
    if prompted:
        environ["GITHUB_TOKEN"] = token
        persist_token(token=token)
        ok(msg="token stored in $GITHUB_TOKEN and release state")
    user_dict: dict[str, Json] = cast(typ="dict[str, Json]", val=user)
    login = cast(typ="str | None", val=user_dict.get("login"))
    return token, login


def split_repo(repo_arg: str, login: str | None) -> tuple[str, str]:
    """Resolve OWNER/NAME or NAME into (owner, repo)."""
    cleaned: str = repo_arg.strip().removesuffix(".git")
    if cleaned.startswith("git@github.com:"):
        cleaned = cleaned.removeprefix("git@github.com:")
    if "github.com/" in cleaned:
        cleaned = cleaned.rsplit("github.com/", maxsplit=1)[-1]
    if "/" in cleaned:
        owner, repo = cleaned.split(sep="/", maxsplit=1)
    else:
        owner, repo = (login or "OWNER"), cleaned
    owner = owner.strip()
    repo = repo.strip()
    if not owner or not repo or owner == "OWNER":
        die(msg="GitHub repository must be OWNER/NAME.")
    return owner, repo


def write_update_repo(owner: str, repo: str) -> None:
    """Persist the release repository into manifest.json update checks."""
    manifest: dict[str, Json] = read_manifest()
    dejavu_cfg = manifest.get("dejavu")
    if not isinstance(dejavu_cfg, dict):
        dejavu_cfg = {}
        manifest["dejavu"] = dejavu_cfg
    update_cfg = dejavu_cfg.get("updateCheck")
    if not isinstance(update_cfg, dict):
        update_cfg = {}
        dejavu_cfg["updateCheck"] = update_cfg
    update_cfg["owner"] = owner
    update_cfg["repo"] = repo
    MANIFEST_JSON.write_text(
        data=dumps(obj=manifest, indent=2) + "\n",
        encoding="utf-8",
        errors="strict",
    )
    ok(msg=f"manifest update-check repo set to {owner}/{repo}")


def ensure_local_git(branch: str) -> str:
    """Initialize git when needed and return the current branch."""
    if not (ROOT / ".git").exists():
        info(msg="Initializing local git repository")
        run(args=["git", "init", "-q"])
        run(args=["git", "checkout", "-q", "-B", branch])
        ok(msg=f"local git initialized on {branch}")
        return branch

    current_branch: str = capture(
        args=["git", "rev-parse", "--abbrev-ref", "HEAD"],
    )
    if current_branch in {"", "HEAD"}:
        run(args=["git", "checkout", "-q", "-B", branch])
        current_branch = branch
    ok(msg=f"local git ready on {current_branch}")
    return current_branch


def ensure_git_remote(owner: str, repo: str) -> None:
    """Create or update origin so the local repo points to GitHub."""
    target: str = f"https://github.com/{owner}/{repo}.git"
    current: str = capture(args=["git", "remote", "get-url", "origin"])
    if not current:
        run(args=["git", "remote", "add", "origin", target])
        ok(msg=f"git remote origin added: {target}")
        return
    if current != target:
        run(args=["git", "remote", "set-url", "origin", target])
        ok(msg=f"git remote origin updated: {target}")
        return
    ok(msg="git remote origin already correct")


def git_dirty_summary() -> str:
    """Return a compact status string for the TUI dashboard."""
    if not (ROOT / ".git").exists():
        return "not initialized"
    status: str = capture(args=["git", "status", "--porcelain"])
    if not status:
        return "clean"
    count: int = len([line for line in status.splitlines() if line.strip()])
    return f"{count} changed file{'' if count == 1 else 's'}"


# --------------------------------------------------------------------------- #
# HTTPS request helper
# --------------------------------------------------------------------------- #
def _urlopen_https(
    method: str,
    full_url: str,
    body: bytes | None,
    headers: dict[str, str],
) -> tuple[int, bytes]:
    """Open an HTTPS URL and return (status, raw payload)."""
    parsed: SplitResult = urlsplit(
        url=full_url,
        scheme="",
        allow_fragments=True,
    )
    if parsed.scheme != "https":
        die(msg=f"Unsupported URL scheme: {parsed.scheme!r}")
    if parsed.hostname is None:
        die(msg="URL has no hostname")

    conn: HTTPSConnection = HTTPSConnection(
        host=parsed.hostname,
        port=parsed.port or 443,
    )
    try:
        path: str = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        conn.request(
            method=method,
            url=path,
            body=body,
            headers=headers,
        )
        resp: HTTPResponse = conn.getresponse()
        status: int = resp.status
        payload: bytes = resp.read()
    finally:
        conn.close()
    return status, payload


# --------------------------------------------------------------------------- #
# GitHub REST helpers (stdlib only)
# --------------------------------------------------------------------------- #
class GhOptions(TypedDict, total=False):
    """Optional overrides for the GitHub REST helper."""

    base: str
    content_type: str
    raw: bytes


@dataclass
class Args:
    """Typed container for the release CLI arguments."""

    repo: str | None = None
    bump: str = "patch"
    private: bool = False
    branch: str = "main"
    dry_run: bool = False
    build_only: bool = False
    skip_build: bool = False
    skip_commit: bool = False
    skip_push: bool = False
    no_sign: bool = False
    prerelease: bool = False
    tui: bool = False


def gh(
    method: str,
    url: str,
    token: str,
    data: dict[str, Json] | None = None,
    options: GhOptions | None = None,
) -> tuple[int, dict[str, Json] | str]:
    """Make a GitHub REST request and return (status, parsed_body)."""
    opts: GhOptions = options or {}
    base: str = opts.get("base") or API
    content_type: str = opts.get("content_type") or "application/json"
    raw: bytes | None = opts.get("raw")

    full: str = url if url.startswith("http") else f"{base}{url}"
    body: bytes | None
    if raw is not None:
        body = raw
    elif data is not None:
        body = dumps(obj=data, indent=2).encode(encoding="utf-8")
    else:
        body = None

    headers: dict[str, str] = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "dejavu-ai-release-script",
    }
    if body is not None:
        headers["Content-Type"] = content_type

    status: int
    payload: bytes
    status, payload = _urlopen_https(
        method=method,
        full_url=full,
        body=body,
        headers=headers,
    )

    parsed: dict[str, Json] | str
    try:
        parsed = cast(
            typ="dict[str, Json]",
            val=loads(s=payload) if payload else {},
        )
    except (ValueError, UnicodeDecodeError):
        parsed = {
            "message": payload.decode(
                encoding="utf-8",
                errors="replace",
            ),
        }
    return status, parsed


# --------------------------------------------------------------------------- #
# Version handling
# --------------------------------------------------------------------------- #
def read_version() -> str:
    """Read the current version from manifest.json."""
    manifest: dict[str, Json] = read_manifest()
    version: str = cast(typ="str", val=manifest["version"])
    return version


def read_manifest() -> dict[str, Json]:
    """Read manifest.json as a typed JSON object."""
    text: str = MANIFEST_JSON.read_text(encoding="utf-8")
    return cast(
        typ="dict[str, Json]",
        val=loads(s=text),
    )


def bump(version: str, part: str) -> str:
    """Bump a semantic version by the requested part."""
    if part == "none":
        return version
    parts: list[str] = re_split(
        pattern=r"[.\-+]",
        string=version,
        maxsplit=0,
        flags=0,
    )
    nums: list[int] = [int(n) for n in parts[:VERSION_PARTS]]
    while len(nums) < VERSION_PARTS:
        nums.append(0)
    major: int
    minor: int
    patch: int
    major, minor, patch = nums
    if part == "major":
        major, minor, patch = major + 1, 0, 0
    elif part == "minor":
        minor, patch = minor + 1, 0
    else:  # patch
        patch += 1
    return f"{major}.{minor}.{patch}"


def write_version(new_version: str) -> None:
    """Write the new version to manifest.json and CSXS/manifest.xml."""
    text: str = MANIFEST_JSON.read_text(encoding="utf-8")
    data: dict[str, Json] = cast(
        typ="dict[str, Json]",
        val=loads(s=text),
    )
    data["version"] = new_version
    _ = MANIFEST_JSON.write_text(
        data=dumps(obj=data, indent=2) + "\n",
        encoding="utf-8",
        errors="strict",
    )

    if MANIFEST_XML.exists():
        xml: str = MANIFEST_XML.read_text(encoding="utf-8")
        xml = re_sub(
            pattern=r'(ExtensionBundleVersion=")[^"]*(")',
            repl=rf"\g<1>{new_version}\g<2>",
            string=xml,
            count=0,
            flags=0,
        )
        xml = re_sub(
            pattern=r'(<Extension\b[^>]*\bVersion=")[^"]*(")',
            repl=rf"\g<1>{new_version}\g<2>",
            string=xml,
            count=0,
            flags=0,
        )
        _ = MANIFEST_XML.write_text(
            data=xml,
            encoding="utf-8",
            errors="strict",
        )


def _csxs_versions() -> tuple[str | None, list[str]]:
    """Return bundle and extension versions from CSXS/manifest.xml."""
    xml: str = MANIFEST_XML.read_text(encoding="utf-8")
    bundle_pattern: str = (
        r'<ExtensionManifest\b[^>]*\bExtensionBundleVersion='
        r'"([^"]*)"'
    )
    bundle_versions: list[str] = re_findall(
        pattern=bundle_pattern,
        string=xml,
    )
    bundle_version: str | None = (
        bundle_versions[0] if bundle_versions else None
    )
    extension_pattern: str = (
        r'<Extension\b[^>]*\bVersion='
        r'"([^"]*)"'
    )
    extension_versions: list[str] = re_findall(
        pattern=extension_pattern,
        string=xml,
    )
    return bundle_version, extension_versions


def validate_project(version: str) -> None:
    """Validate the files and versions required for a shippable package."""
    info(msg="Validating release inputs")
    for rel in REQUIRED_PACKAGE_PATHS:
        path: Path = ROOT / rel
        if not path.exists():
            die(msg=f"Missing required package file: {rel}")

    manifest: dict[str, Json] = read_manifest()
    manifest_version: str = str(manifest.get("version", ""))
    if manifest_version != version:
        die(msg=f"manifest.json version {manifest_version!r} != {version!r}")

    bundle_version: str | None
    extension_versions: list[str]
    bundle_version, extension_versions = _csxs_versions()
    if bundle_version != version:
        die(msg=f"CSXS bundle version {bundle_version!r} != {version!r}")
    mismatches = [v for v in extension_versions if v != version]
    if mismatches:
        die(msg=f"CSXS extension version mismatch: {', '.join(mismatches)}")

    dejavu_cfg = manifest.get("dejavu", {})
    update_cfg: dict[str, Json] = {}
    if isinstance(dejavu_cfg, dict):
        maybe_update = dejavu_cfg.get("updateCheck", {})
        if isinstance(maybe_update, dict):
            update_cfg = maybe_update
    if not update_cfg.get("owner") or not update_cfg.get("repo"):
        warn(msg="manifest.json has no dejavu.updateCheck owner/repo.")

    ok(msg="manifest and required files look shippable")


# --------------------------------------------------------------------------- #
# Steps
# --------------------------------------------------------------------------- #
def _stage_files(stage: Path) -> None:
    """Copy the production file whitelist into the staging directory."""
    copytree(src=ROOT / "client", dst=stage / "client", dirs_exist_ok=True)
    copytree(src=ROOT / "host", dst=stage / "host", dirs_exist_ok=True)
    copytree(src=ROOT / "icons", dst=stage / "icons", dirs_exist_ok=True)
    copytree(src=ROOT / "CSXS", dst=stage / "CSXS", dirs_exist_ok=True)
    # JSX bridge for the Similarity drawer (auto-loaded by the engine).
    copytree(src=ROOT / "jsx", dst=stage / "jsx", dirs_exist_ok=True)
    # Bundled similarity engine (js / lib / config / schemas) used by the
    # Similarity drawer; loaded via ../similarity/... from client/index.html.
    for sub in ("js", "lib", "schemas"):
        src = ROOT / "similarity" / sub
        if src.exists():
            copytree(src=src, dst=stage / "similarity" / sub,
                     dirs_exist_ok=True)
    copy2(src=ROOT / "similarity" / "config.json",
          dst=stage / "similarity" / "config.json")
    copy2(src=ROOT / "manifest.json", dst=stage / "manifest.json")


def _prune_dead_files(stage: Path) -> None:
    """Remove dev-only and transient files from the staging tree."""
    for rel in DEAD_FILES:
        path: Path = stage / rel
        if path.exists():
            path.unlink()
    for path in list(stage.rglob(pattern="*")):
        if path.is_dir() and path.name == "__pycache__":
            rmtree(path=path)
            continue
        if path.is_file() and (
            path.name == ".DS_Store"
            or path.suffix in {".map", ".pyc"}
        ):
            path.unlink()


def _verify_stage(stage: Path) -> None:
    """Validate the staged package before it is archived."""
    missing: list[str] = [
        rel for rel in REQUIRED_PACKAGE_PATHS if not (stage / rel).exists()
    ]
    if missing:
        die(msg=f"Staged package is missing: {', '.join(missing)}")
    forbidden: list[str] = [
        str(path.relative_to(stage))
        for path in stage.rglob(pattern="*")
        if (
            path.name in {".debug", ".DS_Store"}
            or path.suffix in {".map", ".pyc"}
            or "__pycache__" in path.parts
        )
    ]
    if forbidden:
        die(msg=f"Staged package contains dev files: {', '.join(forbidden)}")
    ok(msg="staging tree verified")


def _build_zip(version: str) -> Path:
    """Create a manual-install zip archive from the staging directory."""
    zip_path: Path = BUILD_DIR / f"{PACKAGE_NAME}-{version}.zip"
    if zip_path.exists():
        zip_path.unlink()
    with ZipFile(file=zip_path, mode="w", compression=ZIP_DEFLATED) as zf:
        for path in STAGE_DIR.rglob(pattern="*"):
            if path.is_file():
                arcname: str = str(
                    Path(EXTENSION_DIR_NAME) / path.relative_to(STAGE_DIR),
                )
                zf.write(filename=path, arcname=arcname)
    return zip_path


def _sign_zxp(version: str) -> Path | None:
    """Sign the staging directory into a .zxp if a cert is available."""
    cert: str | None = environ.get("ZXP_CERT")
    password: str | None = environ.get("ZXP_PASS")
    if not cert or not password:
        warn(msg="Skipping .zxp signing (set ZXP_CERT + ZXP_PASS).")
        return None
    if not which(cmd="ZXPSignCmd"):
        warn(msg="ZXPSignCmd not found in PATH; skipping .zxp signing.")
        return None
    zxp_path: Path = BUILD_DIR / f"{PACKAGE_NAME}-{version}.zxp"
    if zxp_path.exists():
        zxp_path.unlink()
    info(msg="Signing .zxp package")
    if run_ok(
        args=[
            "ZXPSignCmd",
            "-sign",
            str(STAGE_DIR),
            str(zxp_path),
            cert,
            password,
        ],
    ):
        ok(msg=".zxp signed")
        return zxp_path
    warn(msg=".zxp signing failed; only the .zip will be released")
    return None


def write_release_metadata(version: str, artifacts: list[Path]) -> list[Path]:
    """Write checksum and release metadata files for GitHub Releases."""
    generated_at = datetime.now(tz=UTC).isoformat(timespec="seconds")
    artifact_info: list[dict[str, Json]] = []
    checksum_lines: list[str] = []
    for artifact in artifacts:
        digest = sha256_file(path=artifact)
        size = artifact.stat().st_size
        artifact_info.append(
            {
                "name": artifact.name,
                "size": size,
                "sha256": digest,
            },
        )
        checksum_lines.append(f"{digest}  {artifact.name}")

    CHECKSUMS_PATH.write_text(
        data="\n".join(checksum_lines) + "\n",
        encoding="utf-8",
        errors="strict",
    )
    RELEASE_INFO_PATH.write_text(
        data=dumps(
            obj={
                "name": PACKAGE_NAME,
                "version": version,
                "generatedAt": generated_at,
                "extensionFolder": EXTENSION_DIR_NAME,
                "artifacts": artifact_info,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
        errors="strict",
    )
    ok(msg=f"wrote {CHECKSUMS_PATH.relative_to(ROOT)}")
    ok(msg=f"wrote {RELEASE_INFO_PATH.relative_to(ROOT)}")
    return [CHECKSUMS_PATH, RELEASE_INFO_PATH]


def build(
    *,
    no_sign: bool = False,
    progress_cb: Callable[[str], None] | None = None,
) -> list[Path]:
    """Build the distributable artifacts and return their paths."""
    section(title="Building package")
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    if STAGE_DIR.exists():
        rmtree(path=STAGE_DIR)
    STAGE_DIR.mkdir(parents=True)

    version: str = read_version()
    steps: list[tuple[str, Callable[[], object]]] = [
        ("Validate project", lambda: validate_project(version=version)),
        ("Stage files", lambda: _stage_files(stage=STAGE_DIR)),
        ("Prune dev files", lambda: _prune_dead_files(stage=STAGE_DIR)),
        ("Verify staging tree", lambda: _verify_stage(stage=STAGE_DIR)),
        ("Build zip archive", lambda: _build_zip(version=version)),
    ]
    if not no_sign:
        steps.append(("Sign .zxp package", lambda: _sign_zxp(version=version)))

    if progress_cb is None:
        with _make_progress() as progress:
            tasks = [
                progress.add_task(description=name, total=1, status="")
                for name, _ in steps
            ]
            for index, (name, fn) in enumerate(steps):
                progress.update(tasks[index], description=name)
                fn()
                progress.update(tasks[index], completed=1, status="done")
    else:
        for name, fn in steps:
            progress_cb(name)
            fn()

    artifacts: list[Path] = [
        BUILD_DIR / f"{PACKAGE_NAME}-{version}.zip",
    ]
    if not no_sign:
        zxp_path: Path = BUILD_DIR / f"{PACKAGE_NAME}-{version}.zxp"
        if zxp_path.exists():
            artifacts.append(zxp_path)
    if progress_cb:
        progress_cb("Write metadata")
    meta_artifacts = write_release_metadata(
        version=version,
        artifacts=artifacts,
    )

    artifact: Path
    for artifact in artifacts:
        size: int = artifact.stat().st_size
        rel: Path = artifact.relative_to(ROOT)
        ok(msg=f"artifact: {rel} ({format_size(size)})")
    return artifacts + meta_artifacts


def find_existing_artifacts() -> list[Path]:
    """Return artifacts already present in build/ for the current version."""
    version: str = read_version()
    zips: list[Path] = sorted(
        BUILD_DIR.glob(pattern=f"{PACKAGE_NAME}-{version}.zip"),
        key=None,
        reverse=False,
    )
    zxps: list[Path] = sorted(
        BUILD_DIR.glob(pattern=f"{PACKAGE_NAME}-{version}.zxp"),
        key=None,
        reverse=False,
    )
    sidecars: list[Path] = [
        path for path in (CHECKSUMS_PATH, RELEASE_INFO_PATH) if path.exists()
    ]
    return zips + zxps + sidecars


def ensure_git_identity() -> None:
    """Ensure a git user identity is configured for the release commit."""
    if not capture(args=["git", "config", "user.email"]):
        _ = run(
            args=[
                "git",
                "config",
                "user.email",
                "dejavu@users.noreply.github.com",
            ],
        )
    if not capture(args=["git", "config", "user.name"]):
        _ = run(
            args=["git", "config", "user.name", "DejaVu Release Bot"],
        )


def git_commit(version: str, branch: str) -> None:
    """Stage the release changes and commit them on the given branch."""
    git_dir: Path = ROOT / ".git"
    if not git_dir.exists():
        info(msg="Initializing git repository")
        _ = run(args=["git", "init", "-q"])
        _ = run(args=["git", "checkout", "-q", "-B", branch])
    else:
        current_branch: str = capture(
            args=["git", "rev-parse", "--abbrev-ref", "HEAD"],
        )
        if current_branch and current_branch != branch:
            warn(
                msg=(
                    f"committing on current branch {current_branch}; "
                    f"push target remains {branch}"
                ),
            )
    ensure_git_identity()
    _ = run(args=["git", "add", "-A"])
    if capture(args=["git", "status", "--porcelain"]):
        info(msg=f"Committing release v{version}")
        _ = run(args=["git", "commit", "-q", "-m", f"Release v{version}"])
        ok(msg="committed")
    else:
        warn(msg="nothing to commit (working tree clean)")


def ensure_repo(
    owner: str,
    repo: str,
    login: str | None,
    token: str,
    *,
    private: bool,
) -> None:
    """Create the GitHub repo if it does not already exist."""
    status: int
    body: dict[str, Json] | str
    status, body = gh(
        method="GET",
        url=f"/repos/{owner}/{repo}",
        token=token,
    )
    if status == HTTP_OK:
        ok(msg=f"repository exists: {owner}/{repo}")
        return
    if status != HTTP_NOT_FOUND:
        die(msg=f"Unexpected response checking repo ({status}).")

    info(msg=f"Creating repository {owner}/{repo}")
    payload: dict[str, Json] = {
        "name": repo,
        "private": private,
        "description": (
            "Timed, change-aware DejaVu panel for Adobe Illustrator."
        ),
    }
    code: int
    if owner == login:
        code, body = gh(
            method="POST",
            url="/user/repos",
            token=token,
            data=payload,
        )
    else:
        code, body = gh(
            method="POST",
            url=f"/orgs/{owner}/repos",
            token=token,
            data=payload,
        )
    if code not in (HTTP_OK, HTTP_CREATED):
        die(msg=f"Could not create repo: {_gh_message(body=body, code=code)}")
    ok(msg="repository created")


def git_push(
    owner: str,
    repo: str,
    token: str,
    branch: str,
    version: str,
) -> None:
    """Push the branch and the version tag to GitHub."""
    remote: str = (
        f"https://x-access-token:{token}@github.com/{owner}/{repo}.git"
    )
    info(msg=f"Pushing {branch} and tag v{version}")
    if not run_ok(args=["git", "push", remote, f"HEAD:{branch}"]):
        die(msg="git push failed (is the remote ahead? pull/rebase first).")

    # (Re)create the tag locally and push it.
    _ = run_ok(args=["git", "tag", "-d", f"v{version}"])
    _ = run(args=["git", "tag", f"v{version}"])
    if not run_ok(args=["git", "push", "-f", remote, f"v{version}"]):
        die(msg="Pushing the tag failed.")
    ok(msg="pushed branch + tag")


def get_or_create_release(
    owner: str,
    repo: str,
    token: str,
    version: str,
    *,
    prerelease: bool,
) -> dict[str, Json]:
    """Fetch an existing release or create a new one for the version."""
    tag: str = f"v{version}"
    status: int
    body: dict[str, Json] | str
    status, body = gh(
        method="GET",
        url=f"/repos/{owner}/{repo}/releases/tags/{tag}",
        token=token,
    )
    if status == HTTP_OK:
        ok(msg=f"release {tag} already exists — reusing")
        return cast(typ="dict[str, Json]", val=body)

    info(msg=f"Creating release {tag}")
    code: int
    code, body = gh(
        method="POST",
        url=f"/repos/{owner}/{repo}/releases",
        token=token,
        data={
            "tag_name": tag,
            "name": f"DejaVu {version}",
            "generate_release_notes": True,
            "draft": False,
            "prerelease": prerelease,
        },
    )
    if code not in (HTTP_OK, HTTP_CREATED):
        message: str = _gh_message(body=body, code=code)
        die(msg=f"Could not create release: {message}")
    ok(msg="release created")
    return cast(typ="dict[str, Json]", val=body)


def upload_assets(  # noqa: PLR0913
    owner: str,
    repo: str,
    token: str,
    release: dict[str, Json],
    artifacts: list[Path],
    progress_cb: Callable[[str], None] | None = None,
) -> None:
    """Upload build artifacts to an existing GitHub release."""
    assets: list[dict[str, Json]] = cast(
        typ="list[dict[str, Json]]",
        val=release.get("assets", []),
    )
    existing: dict[str, int] = {
        cast(typ="str", val=asset["name"]): cast(typ="int", val=asset["id"])
        for asset in assets
    }
    upload_url: str = cast(typ="str", val=release["upload_url"])
    upload_base: str = upload_url.split(sep="{")[0]

    if progress_cb is None:
        with _make_progress() as progress:
            task = progress.add_task(
                description="Uploading release assets",
                total=len(artifacts),
                status="",
            )
            _upload_assets_loop(
                artifacts=artifacts,
                existing=existing,
                upload_base=upload_base,
                owner=owner,
                repo=repo,
                token=token,
                progress=progress,
                task=task,
            )
    else:
        _upload_assets_loop(
            artifacts=artifacts,
            existing=existing,
            upload_base=upload_base,
            owner=owner,
            repo=repo,
            token=token,
            progress_cb=progress_cb,
        )


def _upload_assets_loop(  # noqa: PLR0913
    artifacts: list[Path],
    existing: dict[str, int],
    upload_base: str,
    owner: str,
    repo: str,
    token: str,
    progress: Progress | None = None,
    task: TaskID | None = None,
    progress_cb: Callable[[str], None] | None = None,
) -> None:
    """Inner upload loop shared by standalone and global progress modes."""
    path: Path
    for path in artifacts:
        name: str = path.name
        size = format_size(path.stat().st_size)
        status: str = f"{name} ({size})"
        if progress is not None and task is not None:
            progress.update(task, status=status)
        if progress_cb is not None:
            progress_cb(f"Uploading {status}")
        if name in existing:
            _ = gh(
                method="DELETE",
                url=f"/repos/{owner}/{repo}/releases/assets/{existing[name]}",
                token=token,
            )
        ctype: str = guess_type(url=name)[0] or "application/octet-stream"
        code: int
        body: dict[str, Json] | str
        code, body = gh(
            method="POST",
            url=f"{upload_base}?name={name}",
            token=token,
            options={
                "raw": path.read_bytes(),
                "base": "",
                "content_type": ctype,
            },
        )
        if code not in (HTTP_OK, HTTP_CREATED):
            message: str = _gh_message(body=body, code=code)
            die(msg=f"Asset upload failed: {message}")
        if progress is not None and task is not None:
            progress.advance(task)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def _parse_args() -> Args:
    """Parse and return the CLI arguments."""
    parser: ArgumentParser = ArgumentParser(
        description="Build and publish DejaVu to GitHub in one command.",
    )
    _ = parser.add_argument(
        "--repo",
        dest="repo",
        default=None,
        type=str,
        help="OWNER/NAME or just NAME",
    )
    _ = parser.add_argument(
        "--bump",
        dest="bump",
        default="patch",
        type=str,
        choices=["patch", "minor", "major", "none"],
    )
    _ = parser.add_argument(
        "--private",
        dest="private",
        default=False,
        action="store_true",
    )
    _ = parser.add_argument(
        "--branch",
        dest="branch",
        default="main",
        type=str,
    )
    _ = parser.add_argument(
        "--dry-run",
        dest="dry_run",
        default=False,
        action="store_true",
        help="Prepare everything but do not push or publish to GitHub.",
    )
    _ = parser.add_argument(
        "--build-only",
        dest="build_only",
        default=False,
        action="store_true",
        help="Build local release artifacts without GitHub or git steps.",
    )
    _ = parser.add_argument(
        "--skip-build",
        dest="skip_build",
        default=False,
        action="store_true",
        help="Use existing artifacts in build/ instead of rebuilding.",
    )
    _ = parser.add_argument(
        "--skip-commit",
        dest="skip_commit",
        default=False,
        action="store_true",
        help="Do not commit the version bump.",
    )
    _ = parser.add_argument(
        "--skip-push",
        dest="skip_push",
        default=False,
        action="store_true",
        help="Do not push the branch or tag to GitHub.",
    )
    _ = parser.add_argument(
        "--no-sign",
        dest="no_sign",
        default=False,
        action="store_true",
        help="Skip CEP .zxp signing even if a certificate is available.",
    )
    _ = parser.add_argument(
        "--prerelease",
        dest="prerelease",
        default=False,
        action="store_true",
        help="Mark the GitHub Release as a pre-release.",
    )
    _ = parser.add_argument(
        "--tui",
        dest="tui",
        default=False,
        action="store_true",
        help="Open the interactive release manager.",
    )
    ns: Namespace = parser.parse_args()
    return Args(
        repo=cast("str | None", ns.repo),
        bump=cast("str", ns.bump),
        private=cast("bool", ns.private),
        branch=cast("str", ns.branch),
        dry_run=cast("bool", ns.dry_run),
        build_only=cast("bool", ns.build_only),
        skip_build=cast("bool", ns.skip_build),
        skip_commit=cast("bool", ns.skip_commit),
        skip_push=cast("bool", ns.skip_push),
        no_sign=cast("bool", ns.no_sign),
        prerelease=cast("bool", ns.prerelease),
        tui=cast("bool", ns.tui),
    )


def _resolve_repo_and_token(args: Args) -> tuple[str, str, str | None, str]:
    """Return (owner, repo, login, token) from the parsed arguments."""
    if args.build_only and args.repo is None:
        return "local", "dejavu", None, ""

    needs_github: bool = not args.dry_run and not args.build_only
    token: str
    login: str | None
    token, login = discover_token(prompt=needs_github)
    if not token and needs_github:
        die(msg="A GitHub token is required (set $GITHUB_TOKEN).")

    repo_arg: str
    if args.repo is not None:
        repo_arg = args.repo
    else:
        repo_arg = default_repo_for_login(login=login)
    repo_arg = repo_arg.strip()
    if not repo_arg:
        die(msg="A repository name is required.")

    owner, repo = split_repo(repo_arg=repo_arg, login=login)
    return owner, repo, login, token or ""


def _local_release_work(
    args: Args,
    step: Callable[[str], None],
    progress_cb: Callable[[str], None],
) -> tuple[str, list[Path]]:
    """Bump version, build, commit, and return (new_version, artifacts)."""
    current: str = read_version()
    new_version: str = bump(version=current, part=args.bump)
    if new_version != current:
        step(f"Bumping version {current} → {new_version}")
        write_version(new_version=new_version)
        ok(msg="version files updated")
    else:
        step(f"Version stays at {new_version}")

    artifacts: list[Path]
    if args.skip_build:
        step("Using existing artifacts")
        artifacts = find_existing_artifacts()
        if not artifacts:
            die(msg="--skip-build requested but no artifacts found in build/.")
        ok(msg=f"using {len(artifacts)} existing artifact(s)")
    else:
        step("Building package")
        artifacts = build(no_sign=args.no_sign, progress_cb=progress_cb)

    if args.build_only:
        warn(msg="build-only mode: skipping git commit")
    elif not args.skip_commit:
        step("Committing release")
        git_commit(version=new_version, branch=args.branch)
    else:
        warn(msg="skipping version-bump commit")
    return new_version, artifacts


def _build_summary_table(new_version: str, artifacts: list[Path]) -> Panel:
    """Return a rich Panel summarizing a local build."""
    table = Table(
        title="Build summary",
        title_style="bold cyan",
        box=box.ROUNDED,
        show_header=False,
    )
    table.add_column(style="dim cyan")
    table.add_column(style="green")
    table.add_row("Version", f"v{new_version}")
    table.add_row(
        "Artifacts",
        ", ".join(path.name for path in artifacts),
    )
    return Panel(table, border_style="green")


def _dry_run_summary_table(
    owner: str,
    repo: str,
    new_version: str,
    artifacts: list[Path],
) -> Panel:
    """Return a rich Panel summarizing a dry-run release."""
    table = Table(
        title="Dry-run summary",
        title_style="bold cyan",
        box=box.ROUNDED,
        show_header=False,
    )
    table.add_column(style="dim cyan")
    table.add_column(style="green")
    table.add_row("Repository", f"{owner}/{repo}")
    table.add_row("Version", f"v{new_version}")
    table.add_row(
        "Artifacts",
        ", ".join(path.name for path in artifacts),
    )
    return Panel(table, border_style="yellow")


def _release_summary_table(
    owner: str,
    repo: str,
    new_version: str,
    artifacts: list[Path],
) -> Panel:
    """Return a rich Panel summarizing a published release."""
    table = Table(
        title="Release summary",
        title_style="bold cyan",
        box=box.ROUNDED,
        show_header=False,
    )
    table.add_column(style="dim cyan")
    table.add_column(style="green")
    table.add_row("Repository", f"{owner}/{repo}")
    table.add_row("Version", f"v{new_version}")
    table.add_row(
        "Artifacts",
        ", ".join(path.name for path in artifacts),
    )
    url = f"https://github.com/{owner}/{repo}/releases/tag/v{new_version}"
    table.add_row("Release URL", f"[link={url}]{url}[/link]")
    return Panel(table, border_style="green")


def run_release_pipeline(
    args: Args,
    owner: str,
    repo: str,
    login: str | None,
    token: str,
) -> None:
    """Run the shared local build + GitHub publish pipeline."""
    total_steps = 1 if args.build_only or args.dry_run else 5
    with _make_progress() as progress:
        task = progress.add_task(
            description="[bold cyan]Release pipeline[/bold cyan]",
            total=total_steps,
            status="",
        )

        def step(label: str) -> None:
            progress.update(
                task,
                description=f"[bold cyan]{label}[/bold cyan]",
            )

        def advance() -> None:
            progress.advance(task)

        if not args.build_only:
            write_update_repo(owner=owner, repo=repo)
        if not args.build_only and not args.skip_commit:
            _ = ensure_local_git(branch=args.branch)

        new_version: str
        artifacts: list[Path]
        new_version, artifacts = _local_release_work(
            args=args,
            step=step,
            progress_cb=step,
        )
        step("Build complete")
        advance()

        if args.build_only:
            _CONSOLE.print(_build_summary_table(new_version, artifacts))
            ok(msg="local package build complete")
            return

        if args.dry_run:
            _CONSOLE.print(
                _dry_run_summary_table(owner, repo, new_version, artifacts),
            )
            warn(msg="Skipping GitHub create/push/release.")
            return

        if not token:
            die(msg="A GitHub token is required (set $GITHUB_TOKEN).")

        step("Ensuring GitHub repository")
        ensure_repo(
            owner=owner,
            repo=repo,
            login=login,
            token=token,
            private=args.private,
        )
        ensure_git_remote(owner=owner, repo=repo)
        advance()

        if args.skip_push:
            warn(msg="skipping git push (--skip-push)")
        else:
            step("Pushing branch and tag")
            git_push(
                owner=owner,
                repo=repo,
                token=token,
                branch=args.branch,
                version=new_version,
            )
        advance()

        step("Creating release")
        release: dict[str, Json] = get_or_create_release(
            owner=owner,
            repo=repo,
            token=token,
            version=new_version,
            prerelease=args.prerelease,
        )
        advance()

        step("Uploading assets")
        upload_assets(
            owner=owner,
            repo=repo,
            token=token,
            release=release,
            artifacts=artifacts,
            progress_cb=step,
        )
        advance()

        _CONSOLE.print(
            _release_summary_table(owner, repo, new_version, artifacts),
        )
        ok(msg="release complete")
        step("Done")


def tui_status(args: Args) -> None:
    """Print the release manager dashboard."""
    current: str = read_version()
    next_version: str = bump(version=current, part=args.bump)
    auth_source: str = "env"
    if not (environ.get("GITHUB_TOKEN") or environ.get("GH_TOKEN")):
        auth_source = "gh cli or prompt" if which(cmd="gh") else "will prompt"
    repo_value: str = args.repo or default_repo()
    artifacts = find_existing_artifacts()

    table = Table(
        title="DejaVu release manager",
        title_style="bold cyan",
        box=box.ROUNDED,
        show_header=True,
        header_style="bold magenta",
    )
    table.add_column("Setting", style="dim cyan", no_wrap=True)
    table.add_column("Value", style="green")
    table.add_row("Repository", repo_value)
    table.add_row("Version", f"{current} -> {next_version}")
    table.add_row("Branch", args.branch)
    table.add_row("Git", git_dirty_summary())
    table.add_row(
        "Visibility",
        "[yellow]private" if args.private else "[green]public",
    )
    table.add_row(
        "Release type",
        "[yellow]pre-release" if args.prerelease else "[green]stable",
    )
    table.add_row(
        "Signing",
        "[yellow]skip .zxp" if args.no_sign else "auto if configured",
    )
    table.add_row("GitHub auth", auth_source)
    table.add_row(
        "Artifacts",
        ", ".join(path.name for path in artifacts) if artifacts else "none",
    )
    _CONSOLE.print(Panel(table, border_style="cyan"))


def tui_configure_repo(args: Args) -> None:
    """Prompt for repository and branch settings."""
    section(title="Repository")
    token, login = discover_token(prompt=False)
    _ = token
    repo_arg: str = tui_input(
        label="GitHub repository OWNER/NAME",
        default=args.repo or default_repo(),
    )
    owner, repo = split_repo(repo_arg=repo_arg, login=login)
    args.repo = f"{owner}/{repo}"
    args.branch = tui_input(label="Release branch", default=args.branch)
    args.private = tui_confirm(
        label="Create GitHub repo as private if it does not exist?",
        default=args.private,
    )
    write_update_repo(owner=owner, repo=repo)
    save_release_state(args=args)


def tui_configure_options(args: Args) -> None:
    """Prompt for release build options."""
    section(title="Release options")
    args.bump = tui_choice(
        label="Version bump",
        choices=["patch", "minor", "major", "none"],
        default=args.bump,
    )
    args.prerelease = tui_confirm(
        label="Publish as a GitHub pre-release?",
        default=args.prerelease,
    )
    args.no_sign = tui_confirm(
        label="Skip .zxp signing even if ZXP_CERT/ZXP_PASS exist?",
        default=args.no_sign,
    )
    save_release_state(args=args)


def tui_plan(args: Args, owner: str, repo: str) -> None:
    """Print the full release plan before autopilot starts."""
    current: str = read_version()
    next_version: str = bump(version=current, part=args.bump)
    table = Table(
        title="Autopilot plan",
        title_style="bold cyan",
        box=box.ROUNDED,
        show_header=False,
    )
    table.add_column(style="dim cyan")
    table.add_column(style="green")
    table.add_row("Repository", f"{owner}/{repo}")
    table.add_row("Version", f"{current} -> {next_version}")
    table.add_row("Branch", args.branch)
    table.add_row("Git", "init/repair, add all, commit release")
    table.add_row("GitHub", "create repo if missing, push branch + tag")
    table.add_row("Release", "create/reuse release and upload assets")
    _CONSOLE.print(Panel(table, border_style="cyan"))


def tui_autopilot(args: Args) -> None:
    """Run the complete guided release flow."""
    section(title="Release autopilot")
    token, login = discover_token(prompt=True)
    if not token:
        die(msg="GitHub auth is required for autopilot.")

    repo_default: str = args.repo or default_repo_for_login(login=login)
    debug_msg: str = f"DEBUG: autopilot repo default={repo_default!r}"
    _CONSOLE.print(f"[dim]{debug_msg}[/dim]")
    repo_arg: str = tui_input(
        label="GitHub repository OWNER/NAME",
        default=repo_default,
    )
    owner, repo = split_repo(repo_arg=repo_arg, login=login)
    args.repo = f"{owner}/{repo}"
    save_release_state(args=args)

    if tui_confirm(
        label="Review release options before running?", default=False,
    ):
        tui_configure_options(args=args)

    tui_plan(args=args, owner=owner, repo=repo)
    if not tui_confirm(label="Run this complete release now?", default=True):
        warn(msg="release cancelled")
        return

    run_release_pipeline(
        args=args,
        owner=owner,
        repo=repo,
        login=login,
        token=token,
    )


def tui_init_git(args: Args) -> None:
    """Initialize/repair local git and origin from the current settings."""
    section(title="Local git")
    args.branch = tui_input(label="Release branch", default=args.branch)
    _ = ensure_local_git(branch=args.branch)
    repo_arg: str = args.repo or default_repo()
    token, login = discover_token(prompt=False)
    _ = token
    if repo_arg:
        owner, repo = split_repo(repo_arg=repo_arg, login=login)
        args.repo = f"{owner}/{repo}"
        ensure_git_remote(owner=owner, repo=repo)
    save_release_state(args=args)


def tui_build_only(args: Args) -> None:
    """Run a local package build without touching git or GitHub."""
    section(title="Build package")
    build_args = Args(
        repo=args.repo,
        bump=tui_choice(
            label="Version bump for this local build",
            choices=["none", "patch", "minor", "major"],
            default="none",
        ),
        private=args.private,
        branch=args.branch,
        build_only=True,
        no_sign=args.no_sign,
        prerelease=args.prerelease,
    )
    owner, repo = split_repo(
        repo_arg=build_args.repo or default_repo(),
        login=None,
    )
    run_release_pipeline(
        args=build_args,
        owner=owner,
        repo=repo,
        login=None,
        token="",
    )
    save_release_state(args=build_args)


def tui_run_checks() -> None:
    """Run the checks that do not require Illustrator."""
    commands: list[list[str]] = [
        ["python3", "-m", "py_compile", "scripts/release.py"],
        ["node", "--check", "client/js/update-install.js"],
        ["node", "--check", "client/js/update-check.js"],
        ["node", "--test"],
    ]

    def _render(results: list[tuple[str, bool | None]]) -> Panel:
        table = Table(
            title="Checks",
            title_style="bold cyan",
            box=box.ROUNDED,
            show_header=False,
        )
        table.add_column(style="dim cyan")
        table.add_column()
        for label, passed in results:
            if passed is None:
                status = Text("running", style="bold yellow")
            elif passed:
                status = Text("passed", style="bold green")
            else:
                status = Text("failed", style="bold red")
            table.add_row(label, status)
        return Panel(table, border_style="cyan")

    results: list[tuple[str, bool | None]] = [
        (" ".join(command), None) for command in commands
    ]
    with Live(
        _render(results), console=_CONSOLE, refresh_per_second=10,
    ) as live:
        for index, command in enumerate(commands):
            label = " ".join(command)
            results[index] = (label, None)
            live.update(_render(results))
            if run_ok(args=command):
                results[index] = (label, True)
            else:
                results[index] = (label, False)
            live.update(_render(results))
    _CONSOLE.print(_render(results))


def tui_show_artifacts() -> None:
    """Print generated artifact paths and sizes."""
    artifacts = find_existing_artifacts()
    if not artifacts:
        warn(msg="No artifacts found. Run Build package first.")
        return
    table = Table(
        title="Artifacts",
        title_style="bold cyan",
        box=box.ROUNDED,
        show_header=True,
        header_style="bold magenta",
    )
    table.add_column("Name", style="green")
    table.add_column("Size", style="cyan", justify="right")
    table.add_column("SHA-256", style="dim")
    for artifact in artifacts:
        digest = sha256_file(path=artifact) if artifact.is_file() else ""
        table.add_row(
            artifact.name,
            format_size(artifact.stat().st_size),
            digest[:12] if digest else "-",
        )
    _CONSOLE.print(Panel(table, border_style="cyan"))


def _run_tui_choice(args: Args, choice: str) -> bool:
    """Execute one TUI menu choice. Return True when the loop should exit."""
    if choice == "1":
        tui_autopilot(args=args)
        return True
    if choice == "2":
        tui_configure_repo(args=args)
    elif choice == "3":
        tui_configure_options(args=args)
    elif choice == "4":
        tui_init_git(args=args)
    elif choice == "5":
        tui_build_only(args=args)
    elif choice == "6":
        tui_run_checks()
    elif choice == "7":
        tui_show_artifacts()
    elif choice == "8":
        warn(msg="release manager closed")
        return True
    else:
        warn(msg="Choose a number from 1 to 8.")
    return False


def _tui_menu_table() -> Table:
    """Return the rich Table used for the interactive release menu."""
    table = Table(
        title="Menu",
        title_style="bold",
        box=box.ROUNDED,
        show_header=False,
        show_edge=True,
        padding=(0, 1),
    )
    table.add_column(style="dim cyan", width=3, justify="right")
    table.add_column(style="bold")
    menu_items = [
        ("1", "Release autopilot", True),
        ("2", "Configure repository", False),
        ("3", "Configure release options", False),
        ("4", "Initialize/repair local git", False),
        ("5", "Build package only", False),
        ("6", "Run checks", False),
        ("7", "Show artifacts", False),
        ("8", "Quit", False),
    ]
    for number, label, default in menu_items:
        marker = f"[bold green]{number}" if default else number
        text = f"[bold green]{label}" if default else label
        table.add_row(marker, text)
    return table


def run_tui(args: Args) -> None:
    """Open the interactive release manager."""
    if args.repo is None:
        args.repo = default_repo()
    while True:
        tui_status(args=args)
        _CONSOLE.print(Panel(_tui_menu_table(), border_style="blue"))
        choice: str = input("Choose [1]: ").strip() or "1"
        if _run_tui_choice(args=args, choice=choice):
            return
        _ = input("Press Enter to continue...")


def _install_interrupt_handlers() -> None:
    """Make Ctrl+C and Ctrl+Z print the rich INTERRUPTED panel and exit."""

    def _handle_interrupt(_signum: int, _frame: object) -> None:
        _CONSOLE.print("")
        _CONSOLE.print(
            Panel(
                Text("INTERRUPTED", style="bold yellow", justify="center"),
                border_style="yellow",
            ),
        )
        sys_exit(0)

    signal.signal(signal.SIGTSTP, _handle_interrupt)


def main() -> None:
    """Parse arguments and run the release pipeline."""
    _install_interrupt_handlers()
    args: Args = _parse_args()
    apply_release_state(args=args)
    if args.tui or len(sys_argv) == 1:
        run_tui(args=args)
        return

    section(title="DejaVu release pipeline")
    owner: str
    repo: str
    login: str | None
    token: str
    owner, repo, login, token = _resolve_repo_and_token(args=args)
    run_release_pipeline(
        args=args,
        owner=owner,
        repo=repo,
        login=login,
        token=token,
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        _CONSOLE.print("")
        _CONSOLE.print(
            Panel(
                Text("INTERRUPTED", style="bold yellow", justify="center"),
                border_style="yellow",
            ),
        )
        sys_exit(0)
