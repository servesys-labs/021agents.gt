#!/usr/bin/env python3
"""Initialize a new skill directory with template structure."""

import sys
import os

def init_skill(name: str, base_dir: str = "/workspace/skills"):
    skill_dir = os.path.join(base_dir, name)

    if os.path.exists(skill_dir):
        print(f"Error: Skill directory already exists: {skill_dir}")
        sys.exit(1)

    # Create directories
    for d in ["scripts", "references", "templates"]:
        os.makedirs(os.path.join(skill_dir, d), exist_ok=True)

    # Generate SKILL.md template
    skill_md = f"""---
name: {name}
description: "TODO: What this skill does AND when to use it."
when_to_use: "TODO: Explicit trigger conditions."
category: development
version: 1.0.0
enabled: true
allowed-tools:
  - bash
  - read-file
  - write-file
  - edit-file
---

# {name.replace('-', ' ').title()}

TODO: Brief overview of what this skill does.

## When to Use

TODO: Describe when the agent should activate this skill.

## Workflow

### Phase 1: TODO
TODO: First major step.

### Phase 2: TODO
TODO: Second major step.

## Quality Gates

TODO: What must be true before declaring done.

## Resources

- `scripts/` — TODO: Executable automation scripts
- `references/` — TODO: Documentation loaded on demand
- `templates/` — TODO: Output templates and assets
"""

    with open(os.path.join(skill_dir, "SKILL.md"), "w") as f:
        f.write(skill_md)

    # Create example files
    with open(os.path.join(skill_dir, "scripts", "example.py"), "w") as f:
        f.write('#!/usr/bin/env python3\n"""Example script — replace or delete."""\nprint("Hello from skill script")\n')

    with open(os.path.join(skill_dir, "references", "README.md"), "w") as f:
        f.write("# References\n\nAdd documentation files here that the agent loads on demand.\n")

    with open(os.path.join(skill_dir, "templates", "README.md"), "w") as f:
        f.write("# Templates\n\nAdd output templates (code files, config templates, etc.) here.\n")

    print(f"Skill initialized: {skill_dir}")
    print(f"  SKILL.md — edit frontmatter and body")
    print(f"  scripts/ — add automation scripts")
    print(f"  references/ — add documentation")
    print(f"  templates/ — add output templates")
    print(f"\nNext: Edit SKILL.md, replace all TODO placeholders.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python init_skill.py <skill-name>")
        print("  Creates /workspace/skills/<skill-name>/ with template structure")
        sys.exit(1)

    init_skill(sys.argv[1])
