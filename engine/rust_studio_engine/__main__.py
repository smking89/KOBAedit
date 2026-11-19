"""Module entry point.

    python -m rust_studio_engine inspect-map world.map
    python -m rust_studio_engine export-project draft.json --json
    python -m rust_studio_engine serve --port 8765

The CLI is the default so shell integrations and the Tauri exporter can call
``python -m rust_studio_engine <command>``. The FastAPI sidecar is opt-in via
``serve``.
"""

from __future__ import annotations

import argparse
import secrets
import sys
from pathlib import Path


def serve(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rust-studio-engine serve")
    parser.add_argument("--host", default="127.0.0.1", help="Loopback host (do not expose)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=None)
    parser.add_argument("--thumbnails", type=Path, default=None)
    parser.add_argument(
        "--token",
        default=None,
        help="Require this X-Studio-Token value (default: generate one and print it)",
    )
    args = parser.parse_args(argv)

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("error: the sidecar only binds to loopback", file=sys.stderr)
        return 2

    try:
        import uvicorn
    except ImportError:
        print(
            "error: uvicorn is not installed. Install the sidecar extras:\n"
            "  pip install -e 'engine[server]'",
            file=sys.stderr,
        )
        return 1

    from .app import create_app

    token = args.token or secrets.token_urlsafe(24)
    if args.token is None:
        # The shell reads this single line from stdout to authenticate.
        print(f"sidecar-token={token}", flush=True)

    import os

    os.environ["STUDIO_SIDECAR_TOKEN"] = token
    app = create_app(args.db, args.thumbnails)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "serve":
        return serve(arguments[1:])
    from .cli import main as cli_main

    return cli_main(arguments)


if __name__ == "__main__":
    raise SystemExit(main())
