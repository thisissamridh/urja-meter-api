"""HTTP client for the Urja Meter Ops portal.

Everything the portal-specific knowledge lives here: login, session cookie,
the HMAC-signed bulk export, rate-limit backoff. See PROTOCOL.md.
"""
import hashlib
import hmac
import os
import threading
import time

import httpx


class PortalError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class NotFound(PortalError):
    pass


class Portal:
    def __init__(self) -> None:
        self.base = os.environ.get("URJA_BASE_URL", "https://urja-ops.flockenergy.tech")
        self.email = os.environ.get("URJA_EMAIL", "operator@urja.local")
        self.password = os.environ.get("URJA_PASSWORD", "urja-ops-2026")
        self.http = httpx.Client(base_url=self.base, timeout=20, follow_redirects=False)
        self._lock = threading.Lock()
        self._signing_secret: str | None = None

    # -- auth ---------------------------------------------------------------
    def login(self) -> None:
        with self._lock:
            self.http.cookies.clear()
            r = self.http.post(
                "/login",
                data={"email": self.email, "password": self.password},
                headers={"Origin": self.base},
            )
            if r.status_code != 200 or "session_token" not in str(r.headers.get("set-cookie", "")):
                raise PortalError(502, f"portal login failed ({r.status_code})")
            self._signing_secret = None

    def _signing_secret_value(self) -> str:
        if not self._signing_secret:
            self._signing_secret = self.get("/portal/keys")["data"]["signingSecret"]
        return self._signing_secret

    # -- core request with re-login, retry and backoff ----------------------
    def get(self, path: str, params: dict | None = None, headers: dict | None = None) -> dict:
        last: httpx.Response | None = None
        for attempt in range(5):
            if not self.http.cookies:
                self.login()
            try:
                r = self.http.get(path, params=params, headers=headers)
            except httpx.HTTPError as e:
                last = None
                time.sleep(0.5 * (attempt + 1))
                if attempt == 4:
                    raise PortalError(502, f"portal unreachable: {e}")
                continue
            last = r
            # expired session: page routes redirect to /login, api routes may 401
            if r.status_code in (302, 401) and "signature" not in r.text:
                self.login()
                continue
            if r.status_code == 429:
                # portal allows roughly 120 requests per 20s window, then ~40s lockout
                time.sleep(min(45, 5 * 2**attempt))
                continue
            if r.status_code == 404:
                raise NotFound(404, _msg(r))
            if r.status_code >= 500:
                time.sleep(0.5 * (attempt + 1))
                continue
            if r.status_code != 200:
                raise PortalError(502, f"portal returned {r.status_code}: {_msg(r)}")
            try:
                return r.json()
            except ValueError:
                raise PortalError(502, "portal returned non-JSON body")
        raise PortalError(503, f"portal kept failing (last status {last.status_code if last else 'n/a'})")

    # -- endpoints ----------------------------------------------------------
    def search_meters(self, q: str = "", page: int = 1) -> dict:
        return self.get("/portal/meters/search", {"q": q, "page": page})

    def geo(self, meter_id: str) -> dict:
        return self.get(f"/portal/meters/{meter_id}/geo")["data"]

    def energy(self, meter_id: str, date_from: str | None, date_to: str | None) -> list[dict]:
        params = {k: v for k, v in {"from": date_from, "to": date_to}.items() if v}
        return self.get(f"/portal/meters/{meter_id}/energy", params)["data"]

    def transformers(self) -> list[dict]:
        out, page = [], 1
        while True:
            r = self.get("/portal/dts", {"page": page})
            out += r["data"]
            if len(out) >= r["total"] or not r["data"]:
                return out
            page += 1

    def export_all(self) -> list[dict]:
        """Bulk export of every meter with hierarchy and geo, HMAC-signed."""
        for attempt in range(2):
            qs = "page=1"
            ts = str(int(time.time()))
            msg = "\n".join(["GET", "/portal/export", qs, ts]).encode()
            sig = hmac.new(self._signing_secret_value().encode(), msg, hashlib.sha256).hexdigest()
            try:
                return self.get("/portal/export?" + qs, headers={"x-timestamp": ts, "x-signature": sig})["data"]
            except PortalError as e:
                # secret may have rotated; refetch once
                if "signature" in str(e) and attempt == 0:
                    self._signing_secret = None
                    continue
                raise
        raise PortalError(502, "export signature rejected")


def _msg(r: httpx.Response) -> str:
    try:
        return r.json().get("message") or r.text[:200]
    except ValueError:
        return r.text[:200]
