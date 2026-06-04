"""Per-run ("invocation") model for the kanban dashboard timeline.

Each dispatcher claim opens a fresh run, and as of this change the worker's
stdout is written to a per-run log file (``<task>.run<run_id>.log``) and the
worker's comments carry the run id that produced them. This file pins both
halves of that model:

  * worker logs split per run, read back per run or concatenated as a full
    history, with a legacy single-file fallback for pre-split tasks;
  * ``task_comments.run_id`` storage, the ``commented`` event carrying the same
    id, and the additive migration that back-fills the column as NULL.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    """Isolated HERMES_HOME with an empty kanban DB."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _logs_dir(kanban_home: Path) -> Path:
    d = kanban_home / "kanban" / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# Per-run log paths
# ---------------------------------------------------------------------------

def test_worker_run_log_path_named_by_run(kanban_home):
    p = kb.worker_run_log_path("t_demo", 7)
    assert p.name == "t_demo.run7.log"
    # The whole-task accessor stays the legacy per-task name.
    assert kb.worker_log_path("t_demo").name == "t_demo.log"


def test_worker_run_log_path_none_falls_back_to_legacy(kanban_home):
    # Defensive: a None run id must not produce a ".runNone.log" file.
    assert kb.worker_run_log_path("t_demo", None) == kb.worker_log_path("t_demo")


def test_list_worker_run_logs_sorted_numerically_and_filtered(kanban_home):
    d = _logs_dir(kanban_home)
    (d / "t_x.run1.log").write_text("one")
    (d / "t_x.run2.log").write_text("two")
    (d / "t_x.run10.log").write_text("ten")
    # Noise that must NOT be picked up:
    (d / "t_x.run2.log.1").write_text("rotated backup")   # rotated generation
    (d / "t_x.log").write_text("legacy single file")        # legacy per-task
    (d / "t_other.run1.log").write_text("different task")   # different task
    (d / "t_x.runABC.log").write_text("non-numeric")        # malformed

    runs = kb.list_worker_run_logs("t_x")
    assert [rid for rid, _ in runs] == [1, 2, 10]  # numeric, not lexical
    assert all(p.name.startswith("t_x.run") for _, p in runs)


# ---------------------------------------------------------------------------
# read_worker_log
# ---------------------------------------------------------------------------

def test_read_worker_log_specific_run(kanban_home):
    d = _logs_dir(kanban_home)
    (d / "t_a.run3.log").write_text("run three output")
    assert kb.read_worker_log("t_a", run_id=3) == "run three output"
    # A run with no file on disk returns None, not the wrong run.
    assert kb.read_worker_log("t_a", run_id=99) is None


def test_read_worker_log_concatenates_runs_in_order(kanban_home):
    d = _logs_dir(kanban_home)
    (d / "t_b.run1.log").write_text("A")
    (d / "t_b.run2.log").write_text("B")
    (d / "t_b.run10.log").write_text("C")  # would sort before run2 lexically
    # No run id → full history, runs joined in numeric run order.
    assert kb.read_worker_log("t_b") == "A\nB\nC"


def test_read_worker_log_falls_back_to_legacy_single_file(kanban_home):
    d = _logs_dir(kanban_home)
    # A task that ran before logs were split per run has only the legacy file.
    (d / "t_legacy.log").write_text("pre-split output")
    assert kb.read_worker_log("t_legacy") == "pre-split output"


def test_read_worker_log_none_when_nothing_on_disk(kanban_home):
    assert kb.read_worker_log("t_never_spawned") is None


def test_read_worker_log_tail_caps_concatenation(kanban_home):
    d = _logs_dir(kanban_home)
    (d / "t_c.run1.log").write_text("x" * 100)
    (d / "t_c.run2.log").write_text("y" * 100)
    tail = kb.read_worker_log("t_c", tail_bytes=50)
    assert tail is not None
    assert len(tail.encode("utf-8")) <= 50
    # Tail comes from the end of the concatenation (the last run).
    assert set(tail) == {"y"}


# ---------------------------------------------------------------------------
# Write side: the dispatcher spawns into a per-run log file
# ---------------------------------------------------------------------------

def test_default_spawn_writes_to_per_run_log_file(kanban_home, monkeypatch):
    """_default_spawn must redirect the child's stdout to
    ``<task>.run<current_run_id>.log`` so each attempt is isolated."""
    monkeypatch.setattr(kb, "_kanban_worker_skill_available", lambda _h: False)

    captured = {}

    class FakeProc:
        pid = 4242

    def fake_popen(cmd, **kwargs):
        captured["stdout_name"] = getattr(kwargs.get("stdout"), "name", None)
        return FakeProc()

    monkeypatch.setattr("subprocess.Popen", fake_popen)

    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="spawn-me", assignee="worker")
        task = kb.get_task(conn, tid)
    finally:
        conn.close()

    # The dispatcher claims a run before spawning; emulate that here.
    task.current_run_id = 7
    workspace = kb.resolve_workspace(task)
    pid = kb._default_spawn(task, str(workspace))

    assert pid == 4242
    assert captured["stdout_name"] is not None
    assert captured["stdout_name"].endswith(f"{tid}.run7.log"), captured["stdout_name"]


# ---------------------------------------------------------------------------
# Comments carry their run id
# ---------------------------------------------------------------------------

def test_add_comment_stores_run_id(kanban_home):
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="task")
        kb.add_comment(conn, tid, author="worker", body="from a run", run_id=5)
        comments = kb.list_comments(conn, tid)
    finally:
        conn.close()
    assert len(comments) == 1
    assert comments[0].run_id == 5


def test_add_comment_defaults_run_id_to_none(kanban_home):
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="task")
        kb.add_comment(conn, tid, author="human", body="dashboard comment")
        comments = kb.list_comments(conn, tid)
    finally:
        conn.close()
    assert comments[0].run_id is None


def test_commented_event_carries_run_id(kanban_home):
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="task")
        kb.add_comment(conn, tid, author="worker", body="hi", run_id=11)
        events = kb.list_events(conn, tid)
    finally:
        conn.close()
    commented = [e for e in events if e.kind == "commented"]
    assert len(commented) == 1
    assert commented[0].run_id == 11


# ---------------------------------------------------------------------------
# Additive migration for legacy DBs (no run_id column on task_comments)
# ---------------------------------------------------------------------------

def test_comment_run_id_migration_backfills_null(kanban_home):
    """A DB created before this change has no run_id column on task_comments.
    The additive migration must add it and leave existing rows NULL."""
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="legacy task")
        # Drop to the legacy shape and insert a row the old code would have.
        conn.execute("DROP TABLE task_comments")
        conn.execute(
            "CREATE TABLE task_comments ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " task_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,"
            " created_at INTEGER NOT NULL)"
        )
        conn.execute(
            "INSERT INTO task_comments (task_id, author, body, created_at) "
            "VALUES (?, ?, ?, ?)",
            (tid, "legacy", "old comment", 1000),
        )
        conn.commit()
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(task_comments)")}
        assert "run_id" not in cols  # precondition: legacy shape

        kb._migrate_add_optional_columns(conn)

        cols = {r["name"] for r in conn.execute("PRAGMA table_info(task_comments)")}
        assert "run_id" in cols
        comments = kb.list_comments(conn, tid)
        assert len(comments) == 1
        assert comments[0].run_id is None  # historical rows back-fill NULL
    finally:
        conn.close()
