"""Skill loader — discovers and parses SKILL.md files.

A skill is defined by a SKILL.md file with YAML frontmatter:

    ---
    name: deep-research
    description: Systematic multi-angle research methodology
    version: 1.0.0
    license: MIT
    allowed-tools:
      - web_search
      - web_fetch
    tags:
      - research
      - analysis
    ---

    # Deep Research

    When asked to research a topic, follow this methodology:
    1. Broad exploration — search with multiple keywords
    2. Deep dive — follow references and primary sources
    3. Synthesis — combine findings into structured output
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Regex to parse YAML frontmatter from SKILL.md
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


@dataclass
class Skill:
    """A loaded skill definition."""

    name: str
    description: str = ""
    version: str = "1.0.0"
    license: str = ""
    content: str = ""  # Markdown body (injected into system prompt)
    allowed_tools: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    enabled: bool = True
    source_path: str = ""  # Path to the SKILL.md file
    category: str = ""  # "public" or "custom"
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "license": self.license,
            "allowed_tools": self.allowed_tools,
            "tags": self.tags,
            "enabled": self.enabled,
            "source_path": self.source_path,
            "category": self.category,
            "content_length": len(self.content),
        }

    def to_prompt_injection(self) -> str:
        """Format this skill for injection into the system prompt."""
        parts = [f"## Skill: {self.name}"]
        if self.description:
            parts.append(f"*{self.description}*")
        if self.allowed_tools:
            parts.append(f"Allowed tools: {', '.join(self.allowed_tools)}")
        if self.content:
            parts.append(self.content)
        return "\n".join(parts)


def _parse_yaml_simple(text: str) -> dict[str, Any]:
    """Minimal YAML parser for frontmatter (avoids PyYAML dependency).

    Handles simple key-value pairs and lists. Not a full YAML parser.
    """
    result: dict[str, Any] = {}
    current_key = ""
    current_list: list[str] | None = None

    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        # List item
        if stripped.startswith("- ") and current_key:
            if current_list is None:
                current_list = []
                result[current_key] = current_list
            current_list.append(stripped[2:].strip())
            continue

        # Key-value pair
        if ":" in stripped:
            current_list = None
            key, _, value = stripped.partition(":")
            current_key = key.strip().replace("-", "_")
            value = value.strip()
            if value:
                # Handle quoted strings
                if (value.startswith('"') and value.endswith('"')) or \
                   (value.startswith("'") and value.endswith("'")):
                    value = value[1:-1]
                result[current_key] = value
            # If no value, it might be a list (next lines)

    return result


class SkillLoader:
    """Discovers and loads skills from the filesystem."""

    def __init__(
        self,
        skills_dir: Path | None = None,
        enabled_skills: dict[str, bool] | None = None,
    ) -> None:
        self.skills_dir = skills_dir or Path("skills")
        self._enabled_overrides = enabled_skills or {}
        self._skills: dict[str, Skill] = {}
        self._loaded = False

    def load(self) -> list[Skill]:
        """Discover and load all skills from public/ and custom/ dirs."""
        self._skills.clear()
        for category in ["public", "custom"]:
            cat_dir = self.skills_dir / category
            if not cat_dir.exists():
                continue
            for skill_md in cat_dir.rglob("SKILL.md"):
                try:
                    skill = self._parse_skill(skill_md, category)
                    if skill.name in self._enabled_overrides:
                        skill.enabled = self._enabled_overrides[skill.name]
                    self._skills[skill.name] = skill
                except Exception as exc:
                    logger.warning("Failed to load skill %s: %s", skill_md, exc)

        self._loaded = True
        skills = sorted(self._skills.values(), key=lambda s: s.name)
        logger.info("Loaded %d skills (%d enabled)", len(skills), sum(1 for s in skills if s.enabled))
        return skills

    def _parse_skill(self, path: Path, category: str) -> Skill:
        """Parse a SKILL.md file into a Skill object."""
        raw = path.read_text(encoding="utf-8")
        match = _FRONTMATTER_RE.match(raw)

        if match:
            frontmatter = _parse_yaml_simple(match.group(1))
            content = raw[match.end():].strip()
        else:
            frontmatter = {}
            content = raw.strip()

        name = frontmatter.get("name", path.parent.name)
        allowed_tools = frontmatter.get("allowed_tools", [])
        if isinstance(allowed_tools, str):
            allowed_tools = [t.strip() for t in allowed_tools.split(",")]
        tags = frontmatter.get("tags", [])
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",")]

        return Skill(
            name=name,
            description=frontmatter.get("description", ""),
            version=frontmatter.get("version", "1.0.0"),
            license=frontmatter.get("license", ""),
            content=content,
            allowed_tools=allowed_tools,
            tags=tags,
            source_path=str(path),
            category=category,
        )

    def get(self, name: str) -> Skill | None:
        """Get a skill by name."""
        if not self._loaded:
            self.load()
        return self._skills.get(name)

    def enabled_skills(self) -> list[Skill]:
        """Return only enabled skills."""
        if not self._loaded:
            self.load()
        return [s for s in self._skills.values() if s.enabled]

    def all_skills(self) -> list[Skill]:
        """Return all loaded skills."""
        if not self._loaded:
            self.load()
        return sorted(self._skills.values(), key=lambda s: s.name)

    def set_enabled(self, name: str, enabled: bool) -> bool:
        """Enable or disable a skill. Returns True if found."""
        if name in self._skills:
            self._skills[name].enabled = enabled
            return True
        return False

    def build_prompt_section(self) -> str:
        """Build the skills section for injection into system prompt."""
        enabled = self.enabled_skills()
        if not enabled:
            return ""
        parts = ["# Available Skills\n"]
        for skill in enabled:
            parts.append(skill.to_prompt_injection())
            parts.append("")  # blank line between skills
        return "\n".join(parts)
