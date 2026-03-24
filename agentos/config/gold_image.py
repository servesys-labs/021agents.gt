"""Gold Image management — CRUD for blessed agent configurations.

A gold image is a locked, approved base configuration that agents must
derive from. Changes to gold images are tracked and require approval.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


def _config_hash(config: dict[str, Any]) -> str:
    """Compute a deterministic hash of a config dict."""
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


class GoldImageManager:
    """CRUD operations for gold images."""

    def __init__(self, db: Any):
        self.db = db

    def create(
        self,
        name: str,
        config: dict[str, Any],
        org_id: str = "",
        description: str = "",
        version: str = "1.0.0",
        category: str = "general",
        created_by: str = "",
    ) -> dict[str, Any]:
        """Create a new gold image from a config dict."""
        image_id = uuid.uuid4().hex[:16]
        config_json = json.dumps(config, sort_keys=True)
        config_h = _config_hash(config)

        self.db.insert_gold_image(
            image_id=image_id,
            name=name,
            config_json=config_json,
            config_hash=config_h,
            org_id=org_id,
            description=description,
            version=version,
            category=category,
            created_by=created_by,
        )

        self.db.insert_config_audit(
            org_id=org_id,
            action="gold_image.created",
            field_changed="*",
            new_value=name,
            changed_by=created_by,
            image_id=image_id,
        )

        return {
            "image_id": image_id,
            "name": name,
            "version": version,
            "config_hash": config_h,
            "category": category,
        }

    def get(self, image_id: str) -> dict[str, Any] | None:
        return self.db.get_gold_image(image_id)

    def list(self, org_id: str = "", active_only: bool = True) -> list[dict[str, Any]]:
        return self.db.list_gold_images(org_id=org_id, active_only=active_only)

    def update(
        self,
        image_id: str,
        config: dict[str, Any] | None = None,
        name: str | None = None,
        description: str | None = None,
        version: str | None = None,
        updated_by: str = "",
        org_id: str = "",
    ) -> dict[str, Any] | None:
        """Update a gold image. Recomputes hash if config changes."""
        existing = self.get(image_id)
        if not existing:
            return None

        updates: dict[str, Any] = {}
        if name is not None:
            updates["name"] = name
        if description is not None:
            updates["description"] = description
        if version is not None:
            updates["version"] = version
        if config is not None:
            updates["config_json"] = json.dumps(config, sort_keys=True)
            updates["config_hash"] = _config_hash(config)

        if updates:
            self.db.update_gold_image(image_id, **updates)
            self.db.insert_config_audit(
                org_id=org_id,
                action="gold_image.updated",
                field_changed=",".join(updates.keys()),
                old_value=existing.get("name", ""),
                new_value=name or existing.get("name", ""),
                changed_by=updated_by,
                image_id=image_id,
            )

        return self.get(image_id)

    def approve(self, image_id: str, approved_by: str, org_id: str = "") -> bool:
        """Mark a gold image as approved."""
        import time
        existing = self.get(image_id)
        if not existing:
            return False

        self.db.update_gold_image(
            image_id,
            approved_by=approved_by,
            approved_at=time.time(),
        )
        self.db.insert_config_audit(
            org_id=org_id,
            action="gold_image.approved",
            field_changed="approved_by",
            new_value=approved_by,
            changed_by=approved_by,
            image_id=image_id,
        )
        return True

    def delete(self, image_id: str, deleted_by: str = "", org_id: str = "") -> bool:
        existing = self.get(image_id)
        if not existing:
            return False
        self.db.delete_gold_image(image_id)
        self.db.insert_config_audit(
            org_id=org_id,
            action="gold_image.deleted",
            field_changed="*",
            old_value=existing.get("name", ""),
            changed_by=deleted_by,
            image_id=image_id,
        )
        return True

    def create_from_agent(
        self,
        agent_config: dict[str, Any],
        name: str = "",
        org_id: str = "",
        created_by: str = "",
    ) -> dict[str, Any]:
        """Create a gold image from an existing agent's current config."""
        agent_name = agent_config.get("name", "unknown")
        return self.create(
            name=name or f"{agent_name}-gold",
            config=agent_config,
            org_id=org_id,
            description=f"Gold image created from agent '{agent_name}'",
            version=agent_config.get("version", "1.0.0"),
            created_by=created_by,
        )
