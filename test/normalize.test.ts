import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTree, cleanMeters, cleanReadings, dailyConsumption } from "../src/normalize.ts";
import type { ExportMeter } from "../src/portal.ts";

test("readings: typed, sorted, blank duplicate dropped", () => {
  const { granularity, data } = cleanReadings([
    { timestamp: "30/06/2026 00:00", kwh: "10.5", kvah: "11", voltR: "230" },
    { timestamp: "30/06/2026 00:00", kwh: "", kvah: "11", voltR: "" },
    { timestamp: "29/06/2026 00:00", kwh: "9", kvah: "10", voltR: "231" },
  ]);
  assert.deepEqual(data.map((r) => r.kwh), [9, 10.5]);
  assert.equal(data[0]?.timestamp, "2026-06-29T00:00:00");
  assert.equal(granularity, "daily");
});

test("daily consumption uses the previous day's close", () => {
  const row = (timestamp: string, kwh: number) => ({ timestamp, kwh, kvah: null, voltR: null });
  const days = dailyConsumption([row("2026-06-01T00:00:00", 100), row("2026-06-01T12:00:00", 105), row("2026-06-02T00:00:00", 110)]);
  assert.deepEqual(days.map((d) => d.kwh), [5, 5]);
});

const meter = (meterId: string, patch: Partial<ExportMeter["hierarchy"]> = {}): ExportMeter => ({
  meterId, serialNo: "S", make: "M", phaseType: "single", installStatus: "Installed", installType: "WC", build: "v2", dtCode: "DT-1",
  geo: { lat: 1, lng: 2 },
  hierarchy: {
    zone: { code: "Z-1", name: "Zone 1" }, circle: { code: "C-1", name: "Circle 1" }, division: { code: "D-1", name: "Division 1" },
    subdivision: { code: "SD-1", name: "Subdivision 1" }, substation: { code: "SS-1", name: "Substation 1" },
    feeder: { code: "F-1", name: "Feeder 1" }, dt: { code: "DT-1", name: "DT 1" }, ...patch,
  },
});

test("hierarchy gaps are repaired and logged", () => {
  const { meters, issues } = cleanMeters(
    [meter("A"), meter("B", { circle: { code: "", name: "Circle 1" } }), meter("C", { feeder: { code: "", name: "" } })],
    [{ code: "DT-1", name: "DT 1", feederCode: "F-1", capacityKva: 100 }],
  );
  assert.equal(meters[1]?.hierarchy.circle.code, "C-1");
  assert.deepEqual(meters[2]?.hierarchy.feeder, { code: "F-1", name: "Feeder 1" });
  assert.deepEqual(issues.map((i) => i.fix).sort(), ["code_from_name", "feeder_from_dt", "name_from_code"]);
  assert.equal(buildTree(meters).children[0]?.meterCount, 3);
});
