"""Skill system — extensible capabilities defined as SKILL.md files.

Skills are Markdown files with YAML frontmatter that define reusable
agent capabilities. They are loaded at startup and injected into the
system prompt when enabled.

Layout:
    skills/
    ├── public/          # Built-in skills
    │   ├── deep-research/
    │   │   └── SKILL.md
    │   └── data-analysis/
    │       └── SKILL.md
    └── custom/          # User-defined skills
        └── my-skill/
            └── SKILL.md
"""

from agentos.skills.loader import Skill, SkillLoader

__all__ = ["Skill", "SkillLoader"]
