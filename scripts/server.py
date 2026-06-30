#!/usr/bin/env python3
"""Small static-file HTTP server for local development."""

from __future__ import annotations

from argparse import ArgumentParser, Namespace
from datetime import UTC, datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import TCPServer
from subprocess import CompletedProcess
from subprocess import run as subprocess_run
from sys import stdout
from time import sleep
from typing import Final

# HTTP status code ranges
HTTP_OK_MIN: Final[int] = 200
HTTP_OK_MAX: Final[int] = 300
HTTP_REDIRECT_MIN: Final[int] = 300
HTTP_REDIRECT_MAX: Final[int] = 400
HTTP_CLIENT_ERROR_MIN: Final[int] = 400
HTTP_CLIENT_ERROR_MAX: Final[int] = 500


class LoggingRequestHandler(SimpleHTTPRequestHandler):
    """HTTP request handler with colored, aligned logging."""

    def log_request(
        self,
        code: int | str = "-",
        size: str | int = "-",
    ) -> None:
        """Log the request with ANSI colors and alignment."""
        _ = size
        timestamp: str = datetime.now(tz=UTC).strftime(
            format="%H:%M:%S",
        )
        method: str = self.command
        path: str = self.path
        status_code: str = str(code)

        # ANSI color codes
        reset: str = "\033[0m"
        gray: str = "\033[90m"
        green: str = "\033[92m"
        yellow: str = "\033[93m"
        red: str = "\033[91m"
        blue: str = "\033[94m"
        cyan: str = "\033[96m"

        # Color status code based on range
        if isinstance(code, int):
            if HTTP_OK_MIN <= code < HTTP_OK_MAX:
                status_color: str = green
            elif HTTP_REDIRECT_MIN <= code < HTTP_REDIRECT_MAX:
                status_color = yellow
            elif HTTP_CLIENT_ERROR_MIN <= code < HTTP_CLIENT_ERROR_MAX:
                status_color = red
            else:
                status_color = cyan
        else:
            status_color = gray

        # Column widths
        path_width: int = 60  # Fixed width for path column

        # Truncate path with ellipsis if too long
        if len(path) > path_width:
            path = path[: path_width - 3] + "..."

        timestamp_str: str = f"{gray}{timestamp}{reset}"
        method_str: str = f"{blue}{method}{reset}"
        path_str: str = f"{gray}{path}{reset}"
        status_str: str = f"{status_color}{status_code}{reset}"

        line: str = (
            f"{timestamp_str} | {method_str:6} | {path_str:{path_width}} | "
            f"{status_str}\n"
        )
        stdout.write(line)
        stdout.flush()

    def log_error(
        self,
        format: str,  # noqa: A002
        *args: object,
    ) -> None:
        """Suppress default error logging."""
        _ = format
        _ = args


class Server:
    """Small static-file HTTP server."""

    def __init__(self, folder: Path, host: str, port: int) -> None:
        """Initialize the server with folder, host, and port."""
        self.folder: Path = folder.resolve()
        self.host: str = host
        self.port: int = port

    def _kill_process_on_port(self) -> None:
        """Kill any process using the server's port."""
        try:
            result: CompletedProcess[str] = subprocess_run(
                args=["lsof", "-ti", f":{self.port}"],
                capture_output=True,
                text=True,
                check=False,
            )
            pids: list[str] = (
                result.stdout.strip().split(sep="\n")
                if result.stdout.strip()
                else []
            )
            for pid in pids:
                if pid:
                    subprocess_run(
                        args=["kill", "-9", pid],
                        capture_output=True,
                        check=False,
                    )
                    stdout.write(f"Killed process {pid} on port {self.port}\n")
                    stdout.flush()
                    sleep(0.1)  # Allow socket to be released
        except (OSError, FileNotFoundError):
            pass

    def run(self) -> None:
        """Start serving the folder."""
        self._kill_process_on_port()
        handler: partial[LoggingRequestHandler] = partial(
            LoggingRequestHandler,
            directory=str(self.folder),
        )
        TCPServer.allow_reuse_address = True
        with TCPServer(
            server_address=(self.host, self.port),
            RequestHandlerClass=handler,
        ) as server:
            url: str = f"http://{self.host}:{self.port}"
            stdout.write(f"Serving: {self.folder}\n")
            stdout.write(f"Open:    {url}\n")
            stdout.flush()
            server.serve_forever()


class App:
    """CLI entry point."""

    def parse_args(self) -> Namespace:
        """Parse command-line arguments."""
        parser: ArgumentParser = ArgumentParser(
            description="Serve a folder over HTTP.",
        )
        parser.add_argument(
            "folder",
            nargs="?",
            default="./client",
            help="Folder to serve. Defaults to current folder.",
        )
        parser.add_argument(
            "--host",
            default="127.0.0.1",
            help="Host to bind. Use 0.0.0.0 for LAN access.",
        )
        parser.add_argument(
            "--port",
            type=int,
            default=8000,
            help="Port to serve on.",
        )
        return parser.parse_args()

    def run(self) -> None:
        """Run the app."""
        args: Namespace = self.parse_args()
        folder: Path = Path(args.folder)
        if not folder.exists():
            not_exists_msg: str = f"Folder does not exist: {folder}"
            raise SystemExit(not_exists_msg)
        if not folder.is_dir():
            not_dir_msg: str = f"Path is not a folder: {folder}"
            raise SystemExit(not_dir_msg)
        server: Server = Server(
            folder=folder,
            host=args.host,
            port=args.port,
        )
        server.run()


if __name__ == "__main__":
    App().run()
