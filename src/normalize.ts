// Pure functions that turn the portal's loose data into clean records.
import type { ExportMeter, RawReading, Transformer } from "./portal.ts";

export const LEVELS = ["zone", "circle", "division", "subdivision", "substation", "feeder", "dt"] as const;
export type Level = (typeof LEVELS)[number];

export type HierarchyNode = { code: string | null; name: string | null };
export type Meter = Omit<ExportMeter, "hierarchy" | "geo"> & {
  hierarchy: Record<Level, HierarchyNode>;
  location: { lat: number; lng: number } | null;
};
export type Issue = { meterId: string; level: Level; fix: "code_from_name" | "name_from_code" | "feeder_from_dt" | "dt_name_alias"; value: string };
export type Reading = { timestamp: string; kwh: number | null; kvah: number | null; voltR: number | null };
export type TreeNode = { level: Level | "root"; code: string | null; name: string | null; meterCount: number; children: TreeNode[] };

const toNumber = (v: string): number | null => (v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// "30/06/2026 00:30" -> "2026-06-30T00:30:00"
function toIso(ts: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(ts);
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00` : null;
}

// Typed readings, sorted, one row per timestamp. The portal sometimes emits a
// second row for the same timestamp with blank kwh; the row with a value wins.
export function cleanReadings(raw: RawReading[]): { granularity: string; data: Reading[] } {
  const byTime = new Map<string, Reading>();
  for (const r of raw) {
    const timestamp = toIso(r.timestamp);
    if (!timestamp) continue;
    const row = { timestamp, kwh: toNumber(r.kwh), kvah: toNumber(r.kvah), voltR: toNumber(r.voltR) };
    const existing = byTime.get(timestamp);
    if (!existing || (existing.kwh === null && row.kwh !== null)) byTime.set(timestamp, row);
  }
  const data = [...byTime.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const [first, second] = data;
  const stepMin = first && second ? (Date.parse(second.timestamp) - Date.parse(first.timestamp)) / 60_000 : 0;
  const granularity = stepMin === 30 ? "30min" : stepMin === 1440 ? "daily" : "unknown";
  return { granularity, data };
}

// kWh used per calendar day from a cumulative register: the day's last reading
// minus the previous day's last reading (or the day's first, for day one).
export function dailyConsumption(readings: Reading[]): { date: string; kwh: number; readings: number }[] {
  const days = new Map<string, number[]>();
  for (const r of readings) {
    if (r.kwh === null) continue;
    const date = r.timestamp.slice(0, 10);
    days.set(date, [...(days.get(date) ?? []), r.kwh]);
  }
  const out: { date: string; kwh: number; readings: number }[] = [];
  let previousClose: number | null = null;
  for (const [date, values] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    const open: number = previousClose ?? values[0] ?? 0;
    const close: number = values[values.length - 1] ?? open;
    out.push({ date, kwh: Math.round((close - open) * 1000) / 1000, readings: values.length });
    previousClose = close;
  }
  return out;
}

// Repairs hierarchy gaps seen in the export: a node with a name but no code
// (or the reverse), a blank feeder the DT list can fill, and a DT with two
// names. Every repair is recorded so consumers can audit it.
export function cleanMeters(exported: ExportMeter[], transformers: Transformer[]): { meters: Meter[]; issues: Issue[] } {
  const codeByName = new Map<string, string>(); // key: "level|name"
  const nameVotes = new Map<string, Map<string, number>>(); // key: "level|code"
  for (const m of exported) {
    for (const level of LEVELS) {
      const { code, name } = m.hierarchy[level];
      if (!code || !name) continue;
      if (!codeByName.has(`${level}|${name}`)) codeByName.set(`${level}|${name}`, code);
      const votes = nameVotes.get(`${level}|${code}`) ?? new Map<string, number>();
      votes.set(name, (votes.get(name) ?? 0) + 1);
      nameVotes.set(`${level}|${code}`, votes);
    }
  }
  const majorityName = (level: Level, code: string): string | undefined =>
    [...(nameVotes.get(`${level}|${code}`) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
  const feederByDt = new Map(transformers.map((t) => [t.code, t.feederCode]));

  const issues: Issue[] = [];
  const meters = exported.map((m): Meter => {
    const fixNode = (level: Level): HierarchyNode => {
      let { code, name } = m.hierarchy[level];
      const note = (fix: Issue["fix"], value: string) => issues.push({ meterId: m.meterId, level, fix, value });
      if (!code && name) {
        code = codeByName.get(`${level}|${name}`) ?? "";
        if (code) note("code_from_name", code);
      }
      if (level === "feeder" && !code) {
        code = feederByDt.get(m.dtCode) ?? "";
        if (code) note("feeder_from_dt", code);
      }
      const canonical = code ? majorityName(level, code) : undefined;
      if (code && !name && canonical) {
        name = canonical;
        note("name_from_code", name);
      }
      if (level === "dt" && canonical && name !== canonical) {
        note("dt_name_alias", `${name} -> ${canonical}`);
        name = canonical;
      }
      return { code: code || null, name: name || null };
    };
    const { hierarchy: _h, geo, ...nameplate } = m;
    return {
      ...nameplate,
      hierarchy: {
        zone: fixNode("zone"), circle: fixNode("circle"), division: fixNode("division"),
        subdivision: fixNode("subdivision"), substation: fixNode("substation"),
        feeder: fixNode("feeder"), dt: fixNode("dt"),
      },
      location: geo,
    };
  });
  return { meters, issues };
}

// Nested zone > ... > DT tree with meter counts. Codes are reused under
// different parents (D-01 sits under C-01, C-03 and C-05), so a node is
// identified by its path, not its code.
export function buildTree(meters: Meter[]): TreeNode {
  const root: TreeNode = { level: "root", code: null, name: null, meterCount: 0, children: [] };
  for (const m of meters) {
    let node = root;
    node.meterCount++;
    for (const level of LEVELS) {
      const { code, name } = m.hierarchy[level];
      let child = node.children.find((c) => c.code === code && (code !== null || c.name === name));
      if (!child) {
        child = { level, code, name, meterCount: 0, children: [] };
        node.children.push(child);
        node.children.sort((a, b) => (a.code ?? "~").localeCompare(b.code ?? "~"));
      }
      child.meterCount++;
      node = child;
    }
  }
  return root;
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const h =
    0.5 - Math.cos((b.lat - a.lat) * rad) / 2 +
    (Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * (1 - Math.cos((b.lng - a.lng) * rad))) / 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
