from app import normalize


def test_readings_dedupes_and_types():
    raw = [
        {"timestamp": "30/06/2026 00:00", "kwh": "10.5", "kvah": "11", "voltR": "230"},
        {"timestamp": "30/06/2026 00:00", "kwh": "", "kvah": "11", "voltR": ""},
        {"timestamp": "29/06/2026 00:00", "kwh": "9", "kvah": "10", "voltR": "231"},
    ]
    rows, gran = normalize.readings(raw)
    assert [r["kwh"] for r in rows] == [9.0, 10.5]
    assert rows[0]["timestamp"] == "2026-06-29T00:00:00"
    assert gran == "daily"


def test_daily_consumption_uses_previous_day_close():
    rows = [{"timestamp": "2026-06-01T00:00:00", "kwh": 100.0},
            {"timestamp": "2026-06-01T12:00:00", "kwh": 105.0},
            {"timestamp": "2026-06-02T00:00:00", "kwh": 110.0}]
    days = normalize.daily_consumption(rows)
    assert days[0]["kwh"] == 5.0 and days[1]["kwh"] == 5.0


def test_clean_meters_fills_blank_code_and_feeder():
    h = lambda **kw: {l: {"code": kw.get(l, f"{l[0].upper()}-1"), "name": kw.get(l + "_n", f"{l} 1")} for l in normalize.LEVELS}
    base = dict(serialNo="S", make="M", phaseType="single", installStatus="Installed", installType="WC", build="v2", dtCode="DT-1", geo={"lat": 1, "lng": 2})
    export = [
        dict(base, meterId="A", hierarchy=h()),
        dict(base, meterId="B", hierarchy=h(circle="")),           # blank code, name known
        dict(base, meterId="C", hierarchy=h(feeder="", feeder_n="")),  # blank feeder entirely
    ]
    meters, issues = normalize.clean_meters(export, [{"code": "DT-1", "feederCode": "F-1"}])
    assert meters[1]["hierarchy"]["circle"]["code"] == "C-1"
    assert meters[2]["hierarchy"]["feeder"] == {"code": "F-1", "name": "feeder 1"}
    assert {i["fix"] for i in issues} == {"code_from_name", "feeder_from_dt"}
