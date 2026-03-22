from __future__ import annotations

from agentos.api.routers import secrets


def test_secret_codec_round_trip_current_format(monkeypatch):
    monkeypatch.setenv("AGENTOS_SECRET_ENCRYPTION_KEY", "roundtrip-key")
    encrypted = secrets._encrypt_secret("super-secret-value")
    decrypted = secrets._decrypt_secret(encrypted)
    assert decrypted == "super-secret-value"


def test_secret_codec_round_trip_legacy_format(monkeypatch):
    monkeypatch.setenv("AGENTOS_SECRET_ENCRYPTION_KEY", "legacy-key")
    legacy = secrets._encrypt_secret_legacy("legacy-secret")
    decrypted = secrets._decrypt_secret(legacy)
    assert decrypted == "legacy-secret"
