"""Credentials storage — persists auth tokens to ~/.agentos/credentials.json.

Used by the CLI to store OAuth tokens after `agentos login`.
The file is chmod 600 for security.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


CREDENTIALS_DIR = Path.home() / ".agentos"
CREDENTIALS_FILE = CREDENTIALS_DIR / "credentials.json"


@dataclass
class StoredCredential:
    """A stored authentication credential."""
    token: str
    user_id: str = ""
    email: str = ""
    name: str = ""
    provider: str = ""  # "github", "google", "email"
    server: str = ""  # API base URL (e.g., "https://my-agent.workers.dev")
    expires_at: int = 0


@dataclass
class CredentialsStore:
    """Manages stored credentials for multiple servers."""
    credentials: dict[str, StoredCredential] = field(default_factory=dict)
    default_server: str = ""

    @classmethod
    def load(cls) -> CredentialsStore:
        """Load credentials from disk."""
        if not CREDENTIALS_FILE.exists():
            return cls()
        try:
            data = json.loads(CREDENTIALS_FILE.read_text())
            store = cls(default_server=data.get("default_server", ""))
            for key, cred_data in data.get("credentials", {}).items():
                store.credentials[key] = StoredCredential(**cred_data)
            return store
        except Exception:
            return cls()

    def save(self) -> None:
        """Save credentials to disk (chmod 600)."""
        CREDENTIALS_DIR.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any] = {
            "default_server": self.default_server,
            "credentials": {k: asdict(v) for k, v in self.credentials.items()},
        }
        CREDENTIALS_FILE.write_text(json.dumps(data, indent=2) + "\n")
        CREDENTIALS_FILE.chmod(0o600)

    def store(self, credential: StoredCredential) -> None:
        """Store a credential, keyed by server URL."""
        key = credential.server or "local"
        self.credentials[key] = credential
        if not self.default_server:
            self.default_server = key
        self.save()

    def get(self, server: str = "") -> StoredCredential | None:
        """Get credential for a server (or default)."""
        key = server or self.default_server or "local"
        return self.credentials.get(key)

    def remove(self, server: str = "") -> bool:
        """Remove credential for a server."""
        key = server or self.default_server or "local"
        if key in self.credentials:
            del self.credentials[key]
            if self.default_server == key:
                self.default_server = next(iter(self.credentials), "")
            self.save()
            return True
        return False

    def list_servers(self) -> list[str]:
        """List all servers with stored credentials."""
        return list(self.credentials.keys())
