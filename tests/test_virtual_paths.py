"""Tests for sandbox virtual path translation."""

from __future__ import annotations

import tempfile
from pathlib import Path

from agentos.sandbox.virtual_paths import (
    VIRTUAL_OUTPUTS,
    VIRTUAL_PREFIX,
    VIRTUAL_SKILLS,
    VIRTUAL_UPLOADS,
    VIRTUAL_WORKSPACE,
    PathMapping,
)


def test_path_mapping_for_session():
    mapping = PathMapping.for_session("sess-123", base_dir=Path("/tmp/test"))
    assert mapping.session_id == "sess-123"
    assert "sess-123" in str(mapping.workspace)
    assert str(mapping.workspace).endswith("workspace")
    assert str(mapping.uploads).endswith("uploads")
    assert str(mapping.outputs).endswith("outputs")


def test_virtual_to_physical_workspace():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"))
    result = mapping.virtual_to_physical(f"{VIRTUAL_WORKSPACE}/src/main.py")
    assert result == str(mapping.workspace) + "/src/main.py"


def test_virtual_to_physical_uploads():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"))
    result = mapping.virtual_to_physical(f"{VIRTUAL_UPLOADS}/file.txt")
    assert result == str(mapping.uploads) + "/file.txt"


def test_virtual_to_physical_outputs():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"))
    result = mapping.virtual_to_physical(f"{VIRTUAL_OUTPUTS}/report.pdf")
    assert result == str(mapping.outputs) + "/report.pdf"


def test_virtual_to_physical_skills():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"), skills_dir=Path("/skills"))
    result = mapping.virtual_to_physical(f"{VIRTUAL_SKILLS}/public/test")
    assert result == "/skills/public/test"


def test_virtual_to_physical_passthrough():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"))
    result = mapping.virtual_to_physical("/etc/hosts")
    assert result == "/etc/hosts"


def test_physical_to_virtual():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"))
    ws = str(mapping.workspace)
    result = mapping.physical_to_virtual(f"{ws}/src/file.py")
    assert result == f"{VIRTUAL_WORKSPACE}/src/file.py"


def test_physical_to_virtual_passthrough():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"))
    result = mapping.physical_to_virtual("/some/other/path")
    assert result == "/some/other/path"


def test_translate_command():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"))
    cmd = f"cat {VIRTUAL_WORKSPACE}/file.txt && ls {VIRTUAL_UPLOADS}/"
    translated = mapping.translate_command(cmd)
    assert VIRTUAL_WORKSPACE not in translated
    assert VIRTUAL_UPLOADS not in translated
    assert str(mapping.workspace) in translated
    assert str(mapping.uploads) in translated


def test_translate_command_no_virtual_paths():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"))
    cmd = "echo hello && ls /tmp"
    translated = mapping.translate_command(cmd)
    assert translated == cmd


def test_ensure_dirs():
    with tempfile.TemporaryDirectory() as tmpdir:
        mapping = PathMapping.for_session("test-dirs", base_dir=Path(tmpdir))
        mapping.ensure_dirs()
        assert mapping.workspace.exists()
        assert mapping.uploads.exists()
        assert mapping.outputs.exists()


def test_to_dict():
    mapping = PathMapping.for_session("test", base_dir=Path("/base"))
    d = mapping.to_dict()
    assert d["session_id"] == "test"
    assert "workspace" in d
    assert "uploads" in d
    assert "outputs" in d
    assert d["virtual_prefix"] == VIRTUAL_PREFIX
