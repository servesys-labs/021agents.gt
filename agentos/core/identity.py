"""Agent identity — cryptographic UUID + optional signing keypair.

Every agent gets an immutable agent_id at birth (init time). This ID
persists across renames, version bumps, and config changes. It enables:
  - Audit trails that survive renames
  - Multi-agent trust (trust by ID, not name)
  - Session correlation across deployments
  - Federation (agent moves between orgs, keeps identity)

Optional signing keypair allows agents to produce verifiable outputs
for enterprise non-repudiation requirements.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def generate_agent_id() -> str:
    """Generate a stable, unique agent identifier.

    Format: 'agent-<uuid4>' — human-readable prefix + cryptographic uniqueness.
    """
    return f"agent-{uuid.uuid4().hex}"


def generate_signing_keypair() -> tuple[str, str]:
    """Generate an HMAC signing keypair (secret + public fingerprint).

    Uses a 256-bit random secret. The public key is a SHA-256 fingerprint
    of the secret, safe to commit and share.

    For production use, replace with Ed25519 (requires cryptography package).
    """
    secret = os.urandom(32).hex()
    fingerprint = hashlib.sha256(secret.encode()).hexdigest()
    return secret, fingerprint


def sign_payload(payload: dict[str, Any], secret_key: str) -> str:
    """Sign a JSON payload with HMAC-SHA256. Returns hex digest."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hmac.new(
        secret_key.encode(), canonical.encode(), hashlib.sha256
    ).hexdigest()


def verify_signature(payload: dict[str, Any], signature: str, secret_key: str) -> bool:
    """Verify a payload signature."""
    expected = sign_payload(payload, secret_key)
    return hmac.compare_digest(expected, signature)


@dataclass
class AgentIdentity:
    """The immutable identity of an agent."""

    agent_id: str
    fingerprint: str = ""  # Public key fingerprint (safe to share)

    def to_dict(self) -> dict[str, str]:
        d: dict[str, str] = {"agent_id": self.agent_id}
        if self.fingerprint:
            d["fingerprint"] = self.fingerprint
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentIdentity:
        return cls(
            agent_id=data.get("agent_id", ""),
            fingerprint=data.get("fingerprint", ""),
        )

    @classmethod
    def generate(cls, with_signing: bool = True) -> tuple[AgentIdentity, str]:
        """Generate a new identity. Returns (identity, secret_key).

        secret_key is empty string if with_signing is False.
        """
        agent_id = generate_agent_id()
        if with_signing:
            secret, fingerprint = generate_signing_keypair()
            return cls(agent_id=agent_id, fingerprint=fingerprint), secret
        return cls(agent_id=agent_id), ""


def write_keypair(keys_dir: Path, secret: str, fingerprint: str) -> tuple[Path, Path]:
    """Write signing keypair to .keys/ directory.

    Returns (public_key_path, private_key_path).
    The private key file is chmod 600.
    """
    keys_dir.mkdir(parents=True, exist_ok=True)

    pub_path = keys_dir / "agent.pub"
    pub_path.write_text(f"# AgentOS signing key (public fingerprint)\n{fingerprint}\n")

    key_path = keys_dir / "agent.key"
    key_path.write_text(f"# AgentOS signing key (SECRET — do not commit)\n{secret}\n")
    key_path.chmod(0o600)

    return pub_path, key_path
