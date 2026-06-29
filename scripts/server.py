#!/usr/bin/env python3
from __future__ import annotations

from argparse import ArgumentParser, Namespace
from functools import partial
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import TCPServer


class Server:
    """Small static-file HTTP server."""

    def __init__(self, folder: Path, host: str, port: int) -> None:
        self.folder: Path = folder.resolve()
        self.host: str = host
        self.port: int = port

    def run(self) -> None:
        """Start serving the folder."""
        handler: partial[SimpleHTTPRequestHandler] = partial(
            SimpleHTTPRequestHandler,
            directory=str(self.folder),
        )
        with TCPServer(
            server_address=(self.host, self.port),
            RequestHandlerClass=handler,
        ) as server:
            url: str = f"http://{self.host}:{self.port}"
            print(f"Serving: {self.folder}")
            print(f"Open:    {url}")
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
            raise SystemExit(f"Folder does not exist: {folder}")
        if not folder.is_dir():
            raise SystemExit(f"Path is not a folder: {folder}")
        server: Server = Server(
            folder=folder,
            host=args.host,
            port=args.port,
        )
        server.run()


if __name__ == "__main__":
    App().run()
