from __future__ import annotations

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"


@dataclass(frozen=True)
class PkceSession:
    verifier: str
    challenge: str
    state: str


def create_pkce_session() -> PkceSession:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("utf-8")).digest()).decode("utf-8").rstrip("=")
    return PkceSession(verifier=verifier, challenge=challenge, state=secrets.token_urlsafe(24))


def build_authorize_url(client_id: str, redirect_uri: str, scopes: list[str], pkce: PkceSession) -> str:
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": " ".join(scopes),
        "code_challenge_method": "S256",
        "code_challenge": pkce.challenge,
        "state": pkce.state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def exchange_code_for_token(client_id: str, code: str, redirect_uri: str, verifier: str) -> dict[str, Any]:
    body = urlencode(
        {
            "client_id": client_id,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        }
    ).encode("utf-8")

    request = Request(
        TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )

    with urlopen(request, timeout=20) as response:  # nosec B310 - trusted Spotify token endpoint
        return json.loads(response.read().decode("utf-8"))


def refresh_access_token(client_id: str, refresh_token: str) -> dict[str, Any]:
    body = urlencode(
        {
            "client_id": client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
    ).encode("utf-8")

    request = Request(
        TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )

    with urlopen(request, timeout=20) as response:  # nosec B310 - trusted Spotify token endpoint
        return json.loads(response.read().decode("utf-8"))
