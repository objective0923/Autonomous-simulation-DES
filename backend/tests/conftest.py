"""Tests must never read or modify a user's local scenario library."""
import pytest


@pytest.fixture(autouse=True)
def isolated_scenario_storage(tmp_path, monkeypatch):
    monkeypatch.setenv("CROIS_DATA_DIR", str(tmp_path / "scenario-data"))
