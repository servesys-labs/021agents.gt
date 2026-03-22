"""Tests for all practical builtin tools — bash, file ops, search, code, http, todo, browse."""

import asyncio
import json
import pytest
from pathlib import Path


class TestBashExec:
    @pytest.mark.asyncio
    async def test_echo(self):
        from agentos.tools.builtins import bash_exec
        result = await bash_exec("echo hello")
        assert "hello" in result
        assert "exit code: 0" in result

    @pytest.mark.asyncio
    async def test_exit_code(self):
        from agentos.tools.builtins import bash_exec
        result = await bash_exec("exit 1")
        assert "exit code: 1" in result

    @pytest.mark.asyncio
    async def test_blocks_dangerous(self):
        from agentos.tools.builtins import bash_exec
        result = await bash_exec("rm -rf /")
        assert "Blocked" in result

    @pytest.mark.asyncio
    async def test_timeout(self):
        from agentos.tools.builtins import bash_exec
        result = await bash_exec("sleep 10", timeout_seconds=1)
        assert "timed out" in result


class TestReadFile:
    @pytest.mark.asyncio
    async def test_read(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import read_file
        monkeypatch.chdir(tmp_path)
        (tmp_path / "test.txt").write_text("line1\nline2\nline3")
        result = await read_file("test.txt")
        assert "line1" in result
        assert "3 lines total" in result

    @pytest.mark.asyncio
    async def test_offset_limit(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import read_file
        monkeypatch.chdir(tmp_path)
        (tmp_path / "big.txt").write_text("\n".join(f"line{i}" for i in range(100)))
        result = await read_file("big.txt", offset=10, limit=5)
        assert "line10" in result
        assert "showing 11-15" in result

    @pytest.mark.asyncio
    async def test_not_found(self):
        from agentos.tools.builtins import read_file
        result = await read_file("/nonexistent/file.txt")
        assert "not found" in result.lower()


class TestWriteFile:
    @pytest.mark.asyncio
    async def test_write(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import write_file
        monkeypatch.chdir(tmp_path)
        result = await write_file("output.txt", "hello world")
        assert "Written" in result
        assert (tmp_path / "output.txt").read_text() == "hello world"

    @pytest.mark.asyncio
    async def test_creates_dirs(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import write_file
        monkeypatch.chdir(tmp_path)
        await write_file("sub/dir/file.txt", "nested")
        assert (tmp_path / "sub" / "dir" / "file.txt").read_text() == "nested"


class TestEditFile:
    @pytest.mark.asyncio
    async def test_edit(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import edit_file
        monkeypatch.chdir(tmp_path)
        (tmp_path / "code.py").write_text("def hello():\n    return 'world'")
        result = await edit_file("code.py", "world", "universe")
        assert "replaced 1" in result.lower()
        assert "universe" in (tmp_path / "code.py").read_text()

    @pytest.mark.asyncio
    async def test_not_found(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import edit_file
        monkeypatch.chdir(tmp_path)
        (tmp_path / "f.txt").write_text("abc")
        result = await edit_file("f.txt", "xyz", "123")
        assert "not found" in result.lower()

    @pytest.mark.asyncio
    async def test_ambiguous(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import edit_file
        monkeypatch.chdir(tmp_path)
        (tmp_path / "f.txt").write_text("aaa\naaa")
        result = await edit_file("f.txt", "aaa", "bbb")
        assert "2 times" in result


class TestGrepSearch:
    @pytest.mark.asyncio
    async def test_grep(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import grep_search
        monkeypatch.chdir(tmp_path)
        (tmp_path / "code.py").write_text("def hello():\n    return 42\ndef world():\n    pass")
        result = await grep_search("def \\w+", str(tmp_path))
        assert "hello" in result
        assert "world" in result

    @pytest.mark.asyncio
    async def test_no_match(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import grep_search
        monkeypatch.chdir(tmp_path)
        (tmp_path / "f.txt").write_text("abc")
        result = await grep_search("xyz", str(tmp_path))
        assert "No matches" in result


class TestGlobFind:
    @pytest.mark.asyncio
    async def test_glob(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import glob_find
        monkeypatch.chdir(tmp_path)
        (tmp_path / "a.py").write_text("x")
        (tmp_path / "b.py").write_text("y")
        (tmp_path / "c.txt").write_text("z")
        result = await glob_find("*.py", str(tmp_path))
        assert "a.py" in result
        assert "b.py" in result
        assert "c.txt" not in result


class TestPythonExec:
    @pytest.mark.asyncio
    async def test_exec(self):
        from agentos.tools.builtins import python_exec
        result = await python_exec("print(2 + 2)")
        assert "4" in result
        assert "exit code: 0" in result

    @pytest.mark.asyncio
    async def test_error(self):
        from agentos.tools.builtins import python_exec
        result = await python_exec("raise ValueError('oops')")
        assert "exit code: 1" in result or "oops" in result

    @pytest.mark.asyncio
    async def test_timeout(self):
        from agentos.tools.builtins import python_exec
        result = await python_exec("import time; time.sleep(10)", timeout_seconds=1)
        assert "timed out" in result


class TestHttpRequest:
    @pytest.mark.asyncio
    async def test_get(self):
        from agentos.tools.builtins import http_request
        result = await http_request("https://httpbin.org/get", method="GET")
        assert "200" in result

    @pytest.mark.asyncio
    async def test_invalid_method(self):
        from agentos.tools.builtins import http_request
        result = await http_request("https://example.com", method="INVALID")
        assert "Invalid" in result


class TestTodo:
    @pytest.mark.asyncio
    async def test_add_and_list(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import todo, _todo_items
        monkeypatch.chdir(tmp_path)
        _todo_items.clear()
        r = await todo("add", text="Task 1")
        assert "Added" in r
        r = await todo("add", text="Task 2")
        r = await todo("list")
        assert "Task 1" in r
        assert "Task 2" in r
        assert "0/2 completed" in r

    @pytest.mark.asyncio
    async def test_complete(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import todo, _todo_items
        monkeypatch.chdir(tmp_path)
        _todo_items.clear()
        await todo("add", text="Do it")
        r = await todo("complete", item_id=1)
        assert "Completed" in r
        r = await todo("list")
        assert "[x]" in r

    @pytest.mark.asyncio
    async def test_clear(self, tmp_path, monkeypatch):
        from agentos.tools.builtins import todo, _todo_items
        monkeypatch.chdir(tmp_path)
        _todo_items.clear()
        await todo("add", text="A")
        await todo("add", text="B")
        r = await todo("clear")
        assert "Cleared 2" in r


class TestBrowse:
    @pytest.mark.asyncio
    async def test_browse_text(self):
        from agentos.tools.builtins import browse_page
        result = await browse_page("https://httpbin.org/html", extract="text")
        assert "Herman Melville" in result

    @pytest.mark.asyncio
    async def test_browse_html_selector(self):
        from agentos.tools.builtins import browse_page
        result = await browse_page("https://httpbin.org/html", extract="html", selector="h1")
        assert "Melville" in result
