from __future__ import annotations

from koba_engine.progress import ProgressWriter, read_progress


def test_progress_writer_appends_json_lines(tmp_path) -> None:
    path = tmp_path / "progress.jsonl"
    writer = ProgressWriter(path)
    writer("scanning", 0, 3, "start")
    writer("bundle", 2, 3, "content.bundle")
    writer.close()

    path.write_text(path.read_text() + '{"stage":"partial"', encoding="utf-8")
    records = read_progress(path)
    assert [record["stage"] for record in records] == ["scanning", "bundle"]
    assert records[-1]["current"] == 2
