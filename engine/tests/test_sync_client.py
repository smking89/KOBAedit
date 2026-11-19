from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from rust_studio_engine.sync.client import (
    RevisionConflict,
    SyncHttpClient,
    SyncHttpError,
    payload_hash,
    validate_endpoint,
)


class SyncHandler(BaseHTTPRequestHandler):
    projects: dict[str, dict] = {}

    def log_message(self, *_args):  # keep pytest output clean
        return

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - http.server API
        if self.path == "/v1/health":
            self._send(200, {"ok": True, "service": "koba-sync", "version": 1})
            return
        project = self.path.removeprefix("/v1/projects/")
        current = self.projects.get(project)
        if current is None:
            self._send(404, {"error": "not_found"})
            return
        self._send(200, current)

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        project = self.path.removeprefix("/v1/projects/").removesuffix("/push")
        current = self.projects.get(project, {"revision": 0, "payload": None})
        if not body.get("force") and int(body.get("baseRevision", 0)) != int(
            current.get("revision", 0)
        ):
            self._send(409, {"error": "revision_conflict", "remote": current})
            return
        revision = int(current.get("revision", 0)) + 1
        record = {
            "format": "koba-sync/1",
            "projectId": project,
            "revision": revision,
            "etag": f"etag-{revision}",
            "updatedAt": "2026-01-01T00:00:00Z",
            "payload": body.get("payload"),
            "payloadHash": payload_hash(body.get("payload")),
        }
        self.projects[project] = record
        self._send(200, record)


@pytest.fixture()
def server():
    SyncHandler.projects = {}
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), SyncHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=2)


def test_health_push_pull_and_conflict(server):
    client = SyncHttpClient(server, "secret-token")
    assert client.test()["service"] == "koba-sync"
    draft = {"name": "Hapis", "placements": [{"id": "one"}]}

    pushed = client.push("project-1", draft, base_revision=0)
    assert pushed["revision"] == 1
    assert pushed["payloadHash"] == payload_hash(draft)

    pulled = client.pull("project-1")
    assert pulled is not None
    assert pulled["payload"] == draft
    assert pulled["revision"] == 1

    with pytest.raises(RevisionConflict) as conflict:
        client.push("project-1", {"name": "stale"}, base_revision=0)
    assert conflict.value.remote["revision"] == 1

    forced = client.push("project-1", {"name": "forced"}, base_revision=0, force=True)
    assert forced["revision"] == 2
    assert client.pull("missing") is None


def test_cli_push_and_pull(server, tmp_path, capsys):
    from rust_studio_engine.cli import main

    token = tmp_path / "token"
    token.write_text("secret-token", encoding="utf-8")
    payload = tmp_path / "draft.json"
    payload.write_text(json.dumps({"name": "CLI project"}), encoding="utf-8")
    assert (
        main(
            [
                "sync-push",
                "--endpoint",
                server,
                "--project-id",
                "cli-project",
                "--payload",
                str(payload),
                "--token-file",
                str(token),
                "--json",
            ]
        )
        == 0
    )
    pushed = json.loads(capsys.readouterr().out)
    assert pushed["ok"] is True
    assert pushed["remote"]["revision"] == 1

    output = tmp_path / "remote.json"
    assert (
        main(
            [
                "sync-pull",
                "--endpoint",
                server,
                "--project-id",
                "cli-project",
                "--out",
                str(output),
                "--token-file",
                str(token),
                "--json",
            ]
        )
        == 0
    )
    pulled = json.loads(capsys.readouterr().out)
    assert pulled["remote"]["revision"] == 1
    assert json.loads(output.read_text(encoding="utf-8")) == {"name": "CLI project"}


def test_endpoint_requires_https_outside_loopback():
    assert validate_endpoint("http://localhost:8787/") == "http://localhost:8787"
    with pytest.raises(SyncHttpError):
        validate_endpoint("http://sync.example.net")
    with pytest.raises(SyncHttpError):
        validate_endpoint("ftp://sync.example.net")
