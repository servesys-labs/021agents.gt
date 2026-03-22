from __future__ import annotations

from agentos.auth.provisioning import map_clerk_role


def test_clerk_role_mapping_defaults():
    assert map_clerk_role("org:owner") == "owner"
    assert map_clerk_role("org:admin") == "admin"
    assert map_clerk_role("basic_member") == "member"
    assert map_clerk_role("read_only") == "viewer"


def test_clerk_role_mapping_unknown_defaults_to_member():
    assert map_clerk_role("unknown-role") == "member"
