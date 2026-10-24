"""Customer/scenario storage for the local web application.

SQLite is part of Python: users do not need to install or configure a database.
Only the latest result for the exact saved input is retained. Connections are
short-lived and every write is transactional, including duplicate-name checks.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
from typing import Iterator

from .models import parse_project

ROOT = Path(__file__).resolve().parent.parent


class ScenarioNotFound(LookupError):
    pass


class ScenarioConflict(ValueError):
    pass


def database_path() -> Path:
    directory = os.environ.get("CROIS_DATA_DIR")
    return (Path(directory).expanduser() if directory else ROOT / "data") / "scenarios.sqlite3"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _json(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _name(value: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}을 입력하세요.")
    name = value.strip()
    if len(name) > 120:
        raise ValueError(f"{label}은 120자 이내로 입력하세요.")
    if any(ord(character) < 32 for character in name):
        raise ValueError(f"{label}에 줄바꿈이나 제어 문자를 사용할 수 없습니다.")
    return name


def _project(customer_name: str, name: str, project: dict) -> tuple[str, str, dict]:
    customer_name = _name(customer_name, "고객 이름")
    name = _name(name, "시나리오 이름")
    if not isinstance(project, dict):
        raise ValueError("시나리오 입력이 올바르지 않습니다.")
    candidate = deepcopy(project)
    identifier = candidate.get("id")
    if not isinstance(identifier, str) or re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", identifier) is None:
        raise ValueError("시나리오 ID는 128자 이내의 영문·숫자·밑줄·마침표·콜론·하이픈으로 지정하세요.")
    candidate["customerName"] = customer_name
    candidate["name"] = name
    return customer_name, name, parse_project(candidate)


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("""
            CREATE TABLE IF NOT EXISTS scenarios (
                id TEXT PRIMARY KEY,
                customer_name TEXT NOT NULL,
                customer_key TEXT NOT NULL,
                name TEXT NOT NULL,
                name_key TEXT NOT NULL,
                project_json TEXT NOT NULL,
                result_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_run_at TEXT,
                UNIQUE(customer_key, name_key)
            )
        """)
        connection.execute("PRAGMA user_version=1")
        connection.commit()
        yield connection
    finally:
        connection.close()


def _summary(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "customerName": row["customer_name"],
        "name": row["name"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastRunAt": row["last_run_at"],
        "hasResult": bool(row["has_result"]),
    }


def _detail(row: sqlite3.Row) -> dict:
    return {
        **_summary(row),
        "project": json.loads(row["project_json"]),
        "result": json.loads(row["result_json"]) if row["result_json"] is not None else None,
    }


def _get(connection: sqlite3.Connection, identifier: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT *, result_json IS NOT NULL AS has_result FROM scenarios WHERE id = ?", (identifier,),
    ).fetchone()
    if row is None:
        raise ScenarioNotFound("저장한 시나리오를 찾을 수 없습니다.")
    return row


def list_scenarios() -> list[dict]:
    with _connection() as connection:
        rows = connection.execute("""
            SELECT id, customer_name, name, created_at, updated_at, last_run_at,
                   result_json IS NOT NULL AS has_result
            FROM scenarios ORDER BY updated_at DESC, customer_key, name_key, id
        """).fetchall()
    return [_summary(row) for row in rows]


def get_scenario(identifier: str) -> dict:
    with _connection() as connection:
        return _detail(_get(connection, identifier))


def create_scenario(customer_name: str, name: str, project: dict) -> dict:
    customer_name, name, project = _project(customer_name, name, project)
    now = _now()
    with _connection() as connection:
        try:
            with connection:
                connection.execute("""
                    INSERT INTO scenarios
                      (id, customer_name, customer_key, name, name_key, project_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (project["id"], customer_name, customer_name.casefold(), name, name.casefold(), _json(project), now, now))
        except sqlite3.IntegrityError as error:
            raise ScenarioConflict("같은 고객의 같은 이름 시나리오가 이미 있습니다. 다른 시나리오 이름을 입력하세요.") from error
        return _detail(_get(connection, project["id"]))


def update_scenario(identifier: str, customer_name: str, name: str, project: dict) -> dict:
    customer_name, name, project = _project(customer_name, name, project)
    if project["id"] != identifier:
        raise ValueError("시나리오 ID는 변경할 수 없습니다. 복제 기능으로 새 시나리오를 만드세요.")
    canonical = _json(project)
    with _connection() as connection:
        try:
            with connection:
                # Serialize reads with writes: a concurrent save cannot restore a stale result.
                connection.execute("BEGIN IMMEDIATE")
                row = _get(connection, identifier)
                if row["project_json"] == canonical:
                    return _detail(row)
                connection.execute("""
                    UPDATE scenarios
                    SET customer_name = ?, customer_key = ?, name = ?, name_key = ?,
                        project_json = ?, result_json = NULL, last_run_at = NULL, updated_at = ?
                    WHERE id = ?
                """, (customer_name, customer_name.casefold(), name, name.casefold(), canonical, _now(), identifier))
        except sqlite3.IntegrityError as error:
            raise ScenarioConflict("같은 고객의 같은 이름 시나리오가 이미 있습니다. 다른 시나리오 이름을 입력하세요.") from error
        return _detail(_get(connection, identifier))


def delete_scenario(identifier: str) -> None:
    with _connection() as connection:
        with connection:
            cursor = connection.execute("DELETE FROM scenarios WHERE id = ?", (identifier,))
            if cursor.rowcount == 0:
                raise ScenarioNotFound("저장한 시나리오를 찾을 수 없습니다.")


def save_result_if_current(project: dict, result: dict) -> bool:
    """Record a completed run only if no intervening save changed its inputs.

    Unsaved headless/API projects continue to work and do not create a database.
    All comparisons and the update run under the same write transaction.
    """
    if not database_path().is_file():
        return False
    if not isinstance(project, dict) or not isinstance(result, dict):
        return False
    identifier = project.get("id")
    if result.get("projectId") != identifier or result.get("seed") != project.get("settings", {}).get("seed"):
        return False
    canonical = _json(project)
    with _connection() as connection:
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT project_json FROM scenarios WHERE id = ?", (identifier,)).fetchone()
            if row is None or row["project_json"] != canonical:
                return False
            now = _now()
            connection.execute("UPDATE scenarios SET result_json = ?, last_run_at = ?, updated_at = ? WHERE id = ?", (_json(result), now, now, identifier))
    return True
