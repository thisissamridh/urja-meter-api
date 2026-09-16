"""Clean REST API over the Urja Meter Ops portal."""
import math
import os
import threading
import time
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

from . import normalize
from .portal import NotFound, Portal, PortalError

app = FastAPI(
    title="Urja Meter API",
    version="1.0.0",
    description="Read-only API over the Urja Meter Ops portal: meters, network hierarchy, "
                "transformers and consumption readings. Meter data is served from a cached "
                "bulk export; readings are fetched live per meter.",
)
portal = Portal()


class Store:
    """In-memory snapshot of the bulk export, refreshed after a TTL."""

    def __init__(self) -> None:
        self.ttl = int(os.environ.get("URJA_CACHE_TTL", "900"))
        self.lock = threading.Lock()
        self.loaded_at = 0.0
        self.meters: list[dict] = []
        self.by_id: dict[str, dict] = {}
        self.transformers: list[dict] = []
        self.tree: dict = {}
        self.issues: list[dict] = []

    def refresh(self) -> None:
        with self.lock:
            export = portal.export_all()
            transformers = portal.transformers()
            self.meters, self.issues = normalize.clean_meters(export, transformers)
            self.by_id = {m["meterId"]: m for m in self.meters}
            self.transformers = transformers
            self.tree = normalize.build_tree(self.meters)
            self.loaded_at = time.time()

    def ensure(self) -> None:
        if time.time() - self.loaded_at > self.ttl:
            try:
                self.refresh()
            except PortalError:
                if not self.meters:  # nothing stale to fall back on
                    raise


store = Store()


@app.exception_handler(PortalError)
def portal_error(_, exc: PortalError):
    code = 404 if isinstance(exc, NotFound) else exc.status
    return JSONResponse(status_code=code, content={"error": "not_found" if code == 404 else "upstream_error",
                                                   "message": str(exc)})


@app.get("/health", tags=["meta"])
def health():
    return {"ok": True, "metersCached": len(store.meters), "cacheAgeSeconds": int(time.time() - store.loaded_at)
            if store.loaded_at else None}


@app.post("/refresh", tags=["meta"], summary="Force a re-pull of the bulk export")
def refresh():
    store.refresh()
    return {"meters": len(store.meters), "issuesRepaired": len(store.issues)}


def _haversine_km(lat1, lng1, lat2, lng2) -> float:
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lng2 - lng1) * p)) / 2
    return 12742 * math.asin(math.sqrt(a))


@app.get("/meters", tags=["meters"], summary="List and filter meters")
def list_meters(
    q: str | None = Query(None, description="Substring match on meter ID or serial number"),
    make: str | None = None,
    phaseType: Literal["single", "three"] | None = None,
    installStatus: Literal["Installed", "Faulty", "Decommissioned"] | None = None,
    installType: str | None = None,
    build: str | None = None,
    dtCode: str | None = None,
    feederCode: str | None = None,
    zoneCode: str | None = None,
    nearLat: float | None = Query(None, description="Centre latitude for a radius search"),
    nearLng: float | None = None,
    radiusKm: float = Query(2.0, gt=0),
    page: int = Query(1, ge=1),
    pageSize: int = Query(50, ge=1, le=500),
):
    store.ensure()
    rows = store.meters
    filters = {"make": make, "phaseType": phaseType, "installStatus": installStatus,
               "installType": installType, "build": build, "dtCode": dtCode}
    for k, v in filters.items():
        if v is not None:
            rows = [m for m in rows if str(m[k]).lower() == v.lower()]
    if feederCode:
        rows = [m for m in rows if m["hierarchy"]["feeder"]["code"] == feederCode]
    if zoneCode:
        rows = [m for m in rows if m["hierarchy"]["zone"]["code"] == zoneCode]
    if q:
        ql = q.lower()
        rows = [m for m in rows if ql in m["meterId"].lower() or ql in m["serialNo"].lower()]
    if nearLat is not None and nearLng is not None:
        rows = [dict(m, distanceKm=round(_haversine_km(nearLat, nearLng, m["location"]["lat"], m["location"]["lng"]), 3))
                for m in rows if m["location"]["lat"] is not None]
        rows = sorted([m for m in rows if m["distanceKm"] <= radiusKm], key=lambda m: m["distanceKm"])
    total = len(rows)
    start = (page - 1) * pageSize
    return {"data": rows[start:start + pageSize], "total": total, "page": page, "pageSize": pageSize}


@app.get("/meters/{meter_id}", tags=["meters"])
def get_meter(meter_id: str):
    store.ensure()
    m = store.by_id.get(meter_id)
    if not m:
        raise HTTPException(404, "Meter not found")
    return m


@app.get("/meters/{meter_id}/readings", tags=["consumption"], summary="Raw register readings")
def get_readings(
    meter_id: str,
    date_from: str | None = Query(None, alias="from", pattern=r"^\d{4}-\d{2}-\d{2}$"),
    date_to: str | None = Query(None, alias="to", pattern=r"^\d{4}-\d{2}-\d{2}$"),
):
    """Cumulative kWh/kVAh register values plus R-phase voltage. Without a range
    the portal returns its default window (last 7 days of available data).
    Data exists for June 2026 only on this instance."""
    rows, granularity = normalize.readings(portal.energy(meter_id, date_from, date_to))
    return {"meterId": meter_id, "granularity": granularity, "count": len(rows), "data": rows}


@app.get("/meters/{meter_id}/consumption/daily", tags=["consumption"], summary="kWh consumed per day")
def get_daily(
    meter_id: str,
    date_from: str | None = Query(None, alias="from", pattern=r"^\d{4}-\d{2}-\d{2}$"),
    date_to: str | None = Query(None, alias="to", pattern=r"^\d{4}-\d{2}-\d{2}$"),
):
    rows, _ = normalize.readings(portal.energy(meter_id, date_from, date_to))
    days = normalize.daily_consumption(rows)
    return {"meterId": meter_id, "totalKwh": round(sum(d["kwh"] for d in days), 3), "data": days}


@app.get("/transformers", tags=["network"], summary="Distribution transformers with meter counts")
def list_transformers():
    store.ensure()
    counts: dict[str, int] = {}
    for m in store.meters:
        counts[m["dtCode"]] = counts.get(m["dtCode"], 0) + 1
    return {"data": [dict(t, meterCount=counts.get(t["code"], 0)) for t in store.transformers]}


@app.get("/hierarchy", tags=["network"], summary="Network tree zone > circle > ... > DT")
def hierarchy():
    store.ensure()
    return store.tree


@app.get("/hierarchy/issues", tags=["network"], summary="Data repairs applied to the upstream hierarchy")
def hierarchy_issues():
    store.ensure()
    return {"data": store.issues}
