#!/usr/bin/env python3
"""Validate a skill directory structure and content."""

import sys
import os
import re

def validate_skill(name: str, base_dir: str = "/workspace/skills"):
    skill_dir = os.path.join(base_dir, name)
    errors = []
    warnings = []

    # 1. Directory exists
    if not os.path.isdir(skill_dir):
        print(f"FAIL: Skill directory not found: {skill_dir}")
        sys.exit(1)

    # 2. SKILL.md exists
    skill_md_path = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(skill_md_path):
        errors.append("SKILL.md not found")
        print_results(name, errors, warnings)
        return

    with open(skill_md_path, "r") as f:
        content = f.read()

    lines = content.split("\n")

    # 3. Valid frontmatter
    if not content.startswith("---"):
        errors.append("SKILL.md must start with YAML frontmatter (---)")
    else:
        # Extract frontmatter
        parts = content.split("---", 2)
        if len(parts) < 3:
            errors.append("SKILL.md frontmatter not properly closed (missing second ---)")
        else:
            fm = parts[1]
            if "name:" not in fm:
                errors.append("Frontmatter missing 'name' field")
            if "description:" not in fm:
                errors.append("Frontmatter missing 'description' field")

            # Check for TODO in frontmatter
            if "TODO" in fm:
                errors.append("Frontmatter contains TODO placeholders — replace them")

    # 4. Body under 500 lines
    body_start = content.find("---", 3)
    if body_start > 0:
        body = content[body_start + 3:]
        body_lines = body.strip().split("\n")
        if len(body_lines) > 500:
            warnings.append(f"SKILL.md body is {len(body_lines)} lines (target: <500). Consider moving content to references/")

    # 5. No TODO in body
    todo_count = content.count("TODO")
    if todo_count > 0:
        errors.append(f"Found {todo_count} TODO placeholder(s) — replace all before delivery")

    # 6. Referenced files exist
    # Find references to files in references/, templates/, scripts/
    refs = re.findall(r'(?:references|templates|scripts)/[\w\-./]+\.\w+', content)
    for ref in refs:
        ref_path = os.path.join(skill_dir, ref)
        if not os.path.isfile(ref_path):
            errors.append(f"Referenced file not found: {ref}")

    # 7. Scripts are valid Python/Bash
    scripts_dir = os.path.join(skill_dir, "scripts")
    if os.path.isdir(scripts_dir):
        for f in os.listdir(scripts_dir):
            if f.endswith(".py"):
                script_path = os.path.join(scripts_dir, f)
                try:
                    with open(script_path, "r") as sf:
                        compile(sf.read(), script_path, "exec")
                except SyntaxError as e:
                    errors.append(f"Syntax error in scripts/{f}: {e}")

    # 8. Check for empty example files that should be removed
    for subdir in ["scripts", "references", "templates"]:
        subdir_path = os.path.join(skill_dir, subdir)
        if os.path.isdir(subdir_path):
            for f in os.listdir(subdir_path):
                fpath = os.path.join(subdir_path, f)
                if os.path.isfile(fpath) and os.path.getsize(fpath) < 20:
                    warnings.append(f"Tiny file {subdir}/{f} ({os.path.getsize(fpath)} bytes) — placeholder? Remove if unused.")

    # 9. Description quality
    fm_match = re.search(r'description:\s*["\'](.+?)["\']', content)
    if fm_match:
        desc = fm_match.group(1)
        if len(desc) < 20:
            warnings.append("Description is very short — include what it does AND when to use it")
        if "TODO" not in desc and " when " not in desc.lower() and " use " not in desc.lower():
            warnings.append("Description should mention when to use the skill (trigger conditions)")

    print_results(name, errors, warnings)


def print_results(name, errors, warnings):
    print(f"\n{'='*50}")
    print(f"  Skill Validation: {name}")
    print(f"{'='*50}\n")

    if errors:
        print(f"  ERRORS ({len(errors)}):")
        for e in errors:
            print(f"    x {e}")
        print()

    if warnings:
        print(f"  WARNINGS ({len(warnings)}):")
        for w in warnings:
            print(f"    ! {w}")
        print()

    if not errors and not warnings:
        print("  All checks passed.\n")

    if errors:
        print(f"  RESULT: FAIL ({len(errors)} error(s))")
        sys.exit(1)
    elif warnings:
        print(f"  RESULT: PASS with {len(warnings)} warning(s)")
    else:
        print("  RESULT: PASS")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python validate_skill.py <skill-name>")
        print("  Validates /workspace/skills/<skill-name>/")
        sys.exit(1)

    validate_skill(sys.argv[1])
