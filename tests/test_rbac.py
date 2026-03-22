"""Tests for RBAC, scoped API keys, and permission enforcement."""

import pytest
from agentos.api.deps import CurrentUser, ROLE_HIERARCHY, ALL_SCOPES


class TestCurrentUser:
    def test_has_scope_wildcard(self):
        user = CurrentUser(user_id="u1", email="a@b.com", scopes=["*"])
        assert user.has_scope("agents:read")
        assert user.has_scope("admin")
        assert user.has_scope("anything")

    def test_has_scope_exact(self):
        user = CurrentUser(user_id="u1", email="a@b.com", scopes=["agents:read", "sessions:read"])
        assert user.has_scope("agents:read")
        assert user.has_scope("sessions:read")
        assert not user.has_scope("agents:write")
        assert not user.has_scope("admin")

    def test_has_scope_category_wildcard(self):
        user = CurrentUser(user_id="u1", email="a@b.com", scopes=["agents:*"])
        assert user.has_scope("agents:read")
        assert user.has_scope("agents:write")
        assert user.has_scope("agents:run")
        assert not user.has_scope("sessions:read")

    def test_has_role_hierarchy(self):
        viewer = CurrentUser(user_id="u1", email="a@b.com", role="viewer")
        member = CurrentUser(user_id="u1", email="a@b.com", role="member")
        admin = CurrentUser(user_id="u1", email="a@b.com", role="admin")
        owner = CurrentUser(user_id="u1", email="a@b.com", role="owner")

        assert not viewer.has_role("member")
        assert member.has_role("member")
        assert not member.has_role("admin")
        assert admin.has_role("member")
        assert admin.has_role("admin")
        assert not admin.has_role("owner")
        assert owner.has_role("owner")
        assert owner.has_role("admin")
        assert owner.has_role("member")

    def test_role_level(self):
        assert CurrentUser(user_id="u", email="e", role="owner").role_level == 4
        assert CurrentUser(user_id="u", email="e", role="admin").role_level == 3
        assert CurrentUser(user_id="u", email="e", role="member").role_level == 2
        assert CurrentUser(user_id="u", email="e", role="viewer").role_level == 1

    def test_project_env_scoping(self):
        user = CurrentUser(
            user_id="u1", email="a@b.com",
            org_id="org-1", project_id="proj-1", env="production",
            scopes=["agents:run"],
        )
        assert user.project_id == "proj-1"
        assert user.env == "production"
        assert user.has_scope("agents:run")
        assert not user.has_scope("agents:write")


class TestScopeDefinitions:
    def test_all_scopes_has_wildcard(self):
        assert "*" in ALL_SCOPES

    def test_all_scopes_has_categories(self):
        categories = {"agents", "sessions", "eval", "billing", "memory", "admin"}
        for cat in categories:
            matching = [s for s in ALL_SCOPES if s.startswith(f"{cat}:")]
            assert len(matching) > 0 or cat == "admin", f"No scopes for category: {cat}"

    def test_scope_count(self):
        assert len(ALL_SCOPES) > 20  # Should have comprehensive coverage


class TestRoleHierarchy:
    def test_hierarchy_values(self):
        assert ROLE_HIERARCHY["owner"] > ROLE_HIERARCHY["admin"]
        assert ROLE_HIERARCHY["admin"] > ROLE_HIERARCHY["member"]
        assert ROLE_HIERARCHY["member"] > ROLE_HIERARCHY["viewer"]


class TestApiKeyScoping:
    def test_generate_key_format(self):
        from agentos.api.deps import generate_api_key
        key, prefix, key_hash = generate_api_key()
        assert key.startswith("ak_")
        assert prefix.startswith("ak_")
        assert len(key_hash) == 64  # SHA-256 hex

    def test_key_prefix_is_subset(self):
        from agentos.api.deps import generate_api_key
        key, prefix, _ = generate_api_key()
        assert key.startswith(prefix)
