"""Tests for the skill system — loading, parsing, enabling/disabling."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from agentos.skills.loader import Skill, SkillLoader, _parse_yaml_simple


# ── YAML parser ───────────────────────────────────────────────────────


def test_parse_yaml_simple_kv():
    text = "name: test-skill\nversion: 1.0.0\ndescription: A test skill"
    result = _parse_yaml_simple(text)
    assert result["name"] == "test-skill"
    assert result["version"] == "1.0.0"
    assert result["description"] == "A test skill"


def test_parse_yaml_simple_list():
    text = "name: test\nallowed-tools:\n  - web_search\n  - web_fetch"
    result = _parse_yaml_simple(text)
    assert result["name"] == "test"
    assert result["allowed_tools"] == ["web_search", "web_fetch"]


def test_parse_yaml_simple_quoted_strings():
    text = 'name: "quoted-name"\ndescription: \'single quoted\''
    result = _parse_yaml_simple(text)
    assert result["name"] == "quoted-name"
    assert result["description"] == "single quoted"


def test_parse_yaml_simple_comments():
    text = "# Comment\nname: test\n# Another comment"
    result = _parse_yaml_simple(text)
    assert result["name"] == "test"


def test_parse_yaml_simple_empty():
    assert _parse_yaml_simple("") == {}


# ── Skill dataclass ───────────────────────────────────────────────────


def test_skill_to_dict():
    skill = Skill(
        name="test",
        description="A test",
        version="2.0.0",
        allowed_tools=["web_search"],
        tags=["research"],
        category="public",
    )
    d = skill.to_dict()
    assert d["name"] == "test"
    assert d["version"] == "2.0.0"
    assert d["allowed_tools"] == ["web_search"]
    assert d["tags"] == ["research"]
    assert d["category"] == "public"


def test_skill_to_prompt_injection():
    skill = Skill(
        name="code-review",
        description="Review code for issues",
        content="# Code Review\nCheck for bugs.",
        allowed_tools=["sandbox_exec"],
    )
    prompt = skill.to_prompt_injection()
    assert "## Skill: code-review" in prompt
    assert "Review code for issues" in prompt
    assert "sandbox_exec" in prompt
    assert "# Code Review" in prompt


def test_skill_to_prompt_injection_minimal():
    skill = Skill(name="minimal")
    prompt = skill.to_prompt_injection()
    assert "## Skill: minimal" in prompt


# ── SkillLoader ───────────────────────────────────────────────────────


def _create_skill_tree(base: Path) -> Path:
    """Create a test skill directory tree."""
    public_dir = base / "public" / "test-skill"
    public_dir.mkdir(parents=True)
    (public_dir / "SKILL.md").write_text(
        "---\n"
        "name: test-skill\n"
        "description: A test skill for testing\n"
        "version: 1.2.3\n"
        "allowed-tools:\n"
        "  - web_search\n"
        "tags:\n"
        "  - test\n"
        "---\n\n"
        "# Test Skill\n\nDo test things.\n"
    )

    custom_dir = base / "custom" / "my-custom"
    custom_dir.mkdir(parents=True)
    (custom_dir / "SKILL.md").write_text(
        "---\n"
        "name: my-custom\n"
        "description: Custom user skill\n"
        "---\n\n"
        "Custom instructions here.\n"
    )

    return base


def test_skill_loader_load():
    with tempfile.TemporaryDirectory() as tmpdir:
        skills_dir = _create_skill_tree(Path(tmpdir))
        loader = SkillLoader(skills_dir=skills_dir)
        skills = loader.load()

        assert len(skills) == 2
        names = [s.name for s in skills]
        assert "test-skill" in names
        assert "my-custom" in names


def test_skill_loader_get():
    with tempfile.TemporaryDirectory() as tmpdir:
        skills_dir = _create_skill_tree(Path(tmpdir))
        loader = SkillLoader(skills_dir=skills_dir)
        loader.load()

        skill = loader.get("test-skill")
        assert skill is not None
        assert skill.name == "test-skill"
        assert skill.description == "A test skill for testing"
        assert skill.version == "1.2.3"
        assert skill.category == "public"
        assert "web_search" in skill.allowed_tools
        assert "test" in skill.tags
        assert "# Test Skill" in skill.content

        assert loader.get("nonexistent") is None


def test_skill_loader_enabled_skills():
    with tempfile.TemporaryDirectory() as tmpdir:
        skills_dir = _create_skill_tree(Path(tmpdir))
        loader = SkillLoader(
            skills_dir=skills_dir,
            enabled_skills={"my-custom": False},
        )
        loader.load()

        enabled = loader.enabled_skills()
        assert len(enabled) == 1
        assert enabled[0].name == "test-skill"


def test_skill_loader_set_enabled():
    with tempfile.TemporaryDirectory() as tmpdir:
        skills_dir = _create_skill_tree(Path(tmpdir))
        loader = SkillLoader(skills_dir=skills_dir)
        loader.load()

        assert loader.set_enabled("test-skill", False) is True
        assert loader.get("test-skill").enabled is False

        assert loader.set_enabled("nonexistent", True) is False


def test_skill_loader_build_prompt_section():
    with tempfile.TemporaryDirectory() as tmpdir:
        skills_dir = _create_skill_tree(Path(tmpdir))
        loader = SkillLoader(skills_dir=skills_dir)
        loader.load()

        section = loader.build_prompt_section()
        assert "# Available Skills" in section
        assert "test-skill" in section
        assert "my-custom" in section


def test_skill_loader_build_prompt_empty():
    with tempfile.TemporaryDirectory() as tmpdir:
        loader = SkillLoader(skills_dir=Path(tmpdir))
        loader.load()
        assert loader.build_prompt_section() == ""


def test_skill_loader_no_frontmatter():
    """Skills without frontmatter should use the directory name."""
    with tempfile.TemporaryDirectory() as tmpdir:
        skill_dir = Path(tmpdir) / "public" / "bare-skill"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# Bare Skill\n\nJust content, no frontmatter.\n")

        loader = SkillLoader(skills_dir=Path(tmpdir))
        skills = loader.load()
        assert len(skills) == 1
        assert skills[0].name == "bare-skill"
        assert "# Bare Skill" in skills[0].content


def test_skill_loader_nested_skills():
    """Skills nested deeper than one level should be discovered."""
    with tempfile.TemporaryDirectory() as tmpdir:
        nested = Path(tmpdir) / "public" / "category" / "nested-skill"
        nested.mkdir(parents=True)
        (nested / "SKILL.md").write_text("---\nname: nested\n---\nNested content.\n")

        loader = SkillLoader(skills_dir=Path(tmpdir))
        skills = loader.load()
        assert len(skills) == 1
        assert skills[0].name == "nested"


def test_skill_loader_lazy_load():
    """Calling get() before load() should trigger auto-load."""
    with tempfile.TemporaryDirectory() as tmpdir:
        skills_dir = _create_skill_tree(Path(tmpdir))
        loader = SkillLoader(skills_dir=skills_dir)

        # get() without load() should auto-load
        skill = loader.get("test-skill")
        assert skill is not None
        assert skill.name == "test-skill"
