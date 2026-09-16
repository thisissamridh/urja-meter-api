"""Turn the portal's loose data into clean, typed records."""
from collections import Counter, defaultdict
from datetime import datetime

LEVELS = ["zone", "circle", "division", "subdivision", "substation", "feeder", "dt"]


def _num(v) -> float | None:
    if v in ("", None):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def readings(raw: list[dict]) -> list[dict]:
    """Portal rows -> ISO timestamps, numeric fields, no duplicate timestamps.

    The portal occasionally emits a second row for the same timestamp with blank
    kwh/voltR. We keep the first, non-blank row per timestamp.
    """
    by_ts: dict[datetime, dict] = {}
    for r in raw:
        try:
            ts = datetime.strptime(r["timestamp"], "%d/%m/%Y %H:%M")
        except (KeyError, ValueError):
            continue
        row = {"timestamp": ts.isoformat(), "kwh": _num(r.get("kwh")),
               "kvah": _num(r.get("kvah")), "voltR": _num(r.get("voltR"))}
        if ts not in by_ts or (by_ts[ts]["kwh"] is None and row["kwh"] is not None):
            by_ts[ts] = row
    out = [by_ts[k] for k in sorted(by_ts)]
    if len(out) >= 2:
        step = (datetime.fromisoformat(out[1]["timestamp"]) - datetime.fromisoformat(out[0]["timestamp"])).total_seconds()
        gran = "30min" if step == 1800 else "daily" if step == 86400 else f"{int(step)}s"
    else:
        gran = "unknown"
    return out, gran  # type: ignore[return-value]


def daily_consumption(rows: list[dict]) -> list[dict]:
    """kWh consumed per calendar day from a cumulative register."""
    by_day: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r["kwh"] is not None:
            by_day[r["timestamp"][:10]].append(r)
    days = sorted(by_day)
    out = []
    prev_last = None
    for d in days:
        first, last = by_day[d][0]["kwh"], by_day[d][-1]["kwh"]
        base = prev_last if prev_last is not None else first
        out.append({"date": d, "kwh": round(last - base, 3), "readings": len(by_day[d])})
        prev_last = last
    return out


def clean_meters(export: list[dict], transformers: list[dict]) -> tuple[list[dict], list[dict]]:
    """Repair hierarchy gaps and return (meters, issues).

    Observed problems in the export: a node with a name but blank code (or the
    reverse), and a blank feeder even though the DT list knows its feeder.
    We fill gaps from other meters that share the same name/code, then from
    the transformer list, and record every repair as an issue.
    """
    name_to_code: dict[str, dict[str, str]] = {l: {} for l in LEVELS}
    code_to_name: dict[str, dict[str, str]] = {l: {} for l in LEVELS}
    name_votes: dict[str, dict[str, Counter]] = {l: defaultdict(Counter) for l in LEVELS}
    for m in export:
        for l in LEVELS:
            n = m["hierarchy"].get(l) or {}
            if n.get("code") and n.get("name"):
                name_to_code[l].setdefault(n["name"], n["code"])
                name_votes[l][n["code"]][n["name"]] += 1
    for l in LEVELS:
        code_to_name[l] = {c: v.most_common(1)[0][0] for c, v in name_votes[l].items()}
    dt_feeder = {t["code"]: t["feederCode"] for t in transformers}

    meters, issues = [], []
    for m in export:
        h = {}
        for l in LEVELS:
            n = dict(m["hierarchy"].get(l) or {})
            code, name = n.get("code") or "", n.get("name") or ""
            if not code and name and name in name_to_code[l]:
                code = name_to_code[l][name]
                issues.append({"meterId": m["meterId"], "level": l, "fix": "code_from_name", "value": code})
            if code and not name and code in code_to_name[l]:
                name = code_to_name[l][code]
                issues.append({"meterId": m["meterId"], "level": l, "fix": "name_from_code", "value": name})
            if l == "feeder" and not code and m.get("dtCode") in dt_feeder:
                code = dt_feeder[m["dtCode"]]
                name = code_to_name[l].get(code, "")
                issues.append({"meterId": m["meterId"], "level": l, "fix": "feeder_from_dt", "value": code})
            if l == "dt" and code and name != code_to_name[l].get(code, name):
                issues.append({"meterId": m["meterId"], "level": l, "fix": "dt_name_alias",
                               "value": f"{name} -> {code_to_name[l][code]}"})
                name = code_to_name[l][code]
            h[l] = {"code": code or None, "name": name or None}
        geo = m.get("geo") or {}
        meters.append({
            "meterId": m["meterId"], "serialNo": m["serialNo"], "make": m["make"],
            "phaseType": m["phaseType"], "installStatus": m["installStatus"],
            "installType": m["installType"], "build": m["build"], "dtCode": m["dtCode"],
            "hierarchy": h,
            "location": {"lat": _num(geo.get("lat")), "lng": _num(geo.get("lng"))},
        })
    return meters, issues


def build_tree(meters: list[dict]) -> dict:
    """Nested zone > ... > dt tree with meter counts.

    Codes are reused under different parents (e.g. D-01 sits under C-01, C-03
    and C-05), so a node's identity is its full path, not its code.
    """
    root: dict = {"children": {}, "meterCount": 0}
    for m in meters:
        node = root
        node["meterCount"] += 1
        for l in LEVELS:
            n = m["hierarchy"][l]
            key = n["code"] or f"?{n['name'] or 'unknown'}"
            child = node["children"].setdefault(key, {"level": l, "code": n["code"], "name": n["name"],
                                                       "children": {}, "meterCount": 0})
            child["meterCount"] += 1
            node = child

    def to_list(n: dict) -> dict:
        kids = [to_list(c) for c in n["children"].values()]
        out = {k: v for k, v in n.items() if k != "children"}
        out["children"] = sorted(kids, key=lambda c: c["code"] or "~")
        return out

    return to_list(root)
