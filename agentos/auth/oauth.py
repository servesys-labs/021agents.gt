"""OAuth device flow — authenticate via GitHub or Google from the CLI.

The device flow works like `gh auth login`:
  1. CLI requests a device code from the OAuth provider
  2. Shows user a URL + code to enter in their browser
  3. Polls until the user completes auth
  4. Exchanges the device code for an access token
  5. Fetches user profile (email, name, id)
  6. Issues an AgentOS JWT and stores it locally

Supported providers:
  - GitHub: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
  - Google: https://developers.google.com/identity/protocols/oauth2/limited-input-device

Requires GITHUB_CLIENT_ID or GOOGLE_CLIENT_ID env vars (or passed explicitly).
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass
class DeviceCode:
    """Pending device authorization."""
    device_code: str
    user_code: str
    verification_uri: str
    expires_in: int
    interval: int  # polling interval in seconds


@dataclass
class OAuthUser:
    """User profile from OAuth provider."""
    id: str
    email: str
    name: str
    provider: str
    access_token: str


def _post_form(url: str, data: dict[str, str], headers: dict[str, str] | None = None) -> dict[str, Any]:
    """POST form-encoded data and return JSON response."""
    encoded = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=encoded, method="POST")
    req.add_header("Accept", "application/json")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _get_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """GET JSON from a URL."""
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/json")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


# ── GitHub Device Flow ────────────────────────────────────────────────────


def github_request_device_code(client_id: str = "") -> DeviceCode:
    """Request a device code from GitHub."""
    client_id = client_id or os.environ.get("GITHUB_CLIENT_ID", "")
    if not client_id:
        raise ValueError(
            "GitHub OAuth client ID required. "
            "Set GITHUB_CLIENT_ID env var or pass client_id parameter."
        )

    resp = _post_form(
        "https://github.com/login/device/code",
        {"client_id": client_id, "scope": "read:user user:email"},
    )

    return DeviceCode(
        device_code=resp["device_code"],
        user_code=resp["user_code"],
        verification_uri=resp.get("verification_uri", "https://github.com/login/device"),
        expires_in=resp.get("expires_in", 900),
        interval=resp.get("interval", 5),
    )


def github_poll_for_token(device_code: str, client_id: str = "", interval: int = 5, timeout: int = 900) -> str | None:
    """Poll GitHub until user completes device flow. Returns access_token or None."""
    client_id = client_id or os.environ.get("GITHUB_CLIENT_ID", "")
    deadline = time.time() + timeout

    while time.time() < deadline:
        time.sleep(interval)
        try:
            resp = _post_form(
                "https://github.com/login/oauth/access_token",
                {
                    "client_id": client_id,
                    "device_code": device_code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
            )
        except urllib.error.HTTPError:
            continue

        if "access_token" in resp:
            return resp["access_token"]

        error = resp.get("error", "")
        if error == "authorization_pending":
            continue
        elif error == "slow_down":
            interval += 5
        elif error in ("expired_token", "access_denied"):
            return None
        else:
            continue

    return None


def github_get_user(access_token: str) -> OAuthUser:
    """Fetch GitHub user profile."""
    headers = {"Authorization": f"Bearer {access_token}"}
    user = _get_json("https://api.github.com/user", headers)

    # Get primary email
    email = user.get("email", "")
    if not email:
        try:
            emails = _get_json("https://api.github.com/user/emails", headers)
            for e in emails:
                if isinstance(e, dict) and e.get("primary"):
                    email = e["email"]
                    break
        except Exception:
            pass

    return OAuthUser(
        id=f"github:{user['id']}",
        email=email,
        name=user.get("name", user.get("login", "")),
        provider="github",
        access_token=access_token,
    )


# ── Google Device Flow ────────────────────────────────────────────────────


def google_request_device_code(client_id: str = "") -> DeviceCode:
    """Request a device code from Google."""
    client_id = client_id or os.environ.get("GOOGLE_CLIENT_ID", "")
    if not client_id:
        raise ValueError(
            "Google OAuth client ID required. "
            "Set GOOGLE_CLIENT_ID env var or pass client_id parameter."
        )

    resp = _post_form(
        "https://oauth2.googleapis.com/device/code",
        {"client_id": client_id, "scope": "email profile"},
    )

    return DeviceCode(
        device_code=resp["device_code"],
        user_code=resp["user_code"],
        verification_uri=resp.get("verification_url", "https://www.google.com/device"),
        expires_in=resp.get("expires_in", 1800),
        interval=resp.get("interval", 5),
    )


def google_poll_for_token(
    device_code: str,
    client_id: str = "",
    client_secret: str = "",
    interval: int = 5,
    timeout: int = 1800,
) -> str | None:
    """Poll Google until user completes device flow. Returns access_token or None."""
    client_id = client_id or os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = client_secret or os.environ.get("GOOGLE_CLIENT_SECRET", "")
    deadline = time.time() + timeout

    while time.time() < deadline:
        time.sleep(interval)
        try:
            resp = _post_form(
                "https://oauth2.googleapis.com/token",
                {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "device_code": device_code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
            )
        except urllib.error.HTTPError:
            continue

        if "access_token" in resp:
            return resp["access_token"]

        error = resp.get("error", "")
        if error == "authorization_pending":
            continue
        elif error == "slow_down":
            interval += 5
        elif error in ("expired_token", "access_denied"):
            return None

    return None


def google_get_user(access_token: str) -> OAuthUser:
    """Fetch Google user profile."""
    headers = {"Authorization": f"Bearer {access_token}"}
    user = _get_json("https://www.googleapis.com/oauth2/v2/userinfo", headers)

    return OAuthUser(
        id=f"google:{user['id']}",
        email=user.get("email", ""),
        name=user.get("name", ""),
        provider="google",
        access_token=access_token,
    )
