// Clean REST API over the Urja Meter Ops portal.
import { readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { buildTree, cleanMeters, cleanReadings, dailyConsumption, distanceKm, type Issue, type Meter, type TreeNode } from "./normalize.ts";
import { fetchExport, fetchReadings, fetchTransformers, PortalError, type Transformer } from "./portal.ts";

const CACHE_TTL_MS = Number(process.env.URJA_CACHE_TTL ?? 900) * 1000;
const PORT = Number(process.env.PORT ?? 8000);

// In-memory snapshot of the bulk export. 403 meters is tiny, so no database.
type Snapshot = { loadedAt: number; meters: Meter[]; transformers: Transformer[]; tree: TreeNode; issues: Issue[] };
let snapshot: Snapshot | null = null;
let refreshing: Promise<Snapshot> | null = null;

async function refresh(): Promise<Snapshot> {
  // share one in-flight refresh between concurrent requests
  refreshing ??= (async () => {
    const [exported, transformers] = await Promise.all([fetchExport(), fetchTransformers()]);
    const { meters, issues } = cleanMeters(exported, transformers);
    snapshot = { loadedAt: Date.now(), meters, transformers, tree: buildTree(meters), issues };
    return snapshot;
  })().finally(() => (refreshing = null));
  return refreshing;
}

async function getSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.loadedAt < CACHE_TTL_MS) return snapshot;
  try {
    return await refresh();
  } catch (err) {
    if (snapshot) return snapshot; // portal is down: serve stale rather than fail
    throw err;
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const RangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const MetersQuery = z.object({
  q: z.string().optional(),
  make: z.string().optional(),
  phaseType: z.string().optional(),
  installStatus: z.string().optional(),
  installType: z.string().optional(),
  build: z.string().optional(),
  dtCode: z.string().optional(),
  feederCode: z.string().optional(),
  zoneCode: z.string().optional(),
  nearLat: z.coerce.number().optional(),
  nearLng: z.coerce.number().optional(),
  radiusKm: z.coerce.number().positive().default(2),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

const app = express();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    metersCached: snapshot?.meters.length ?? 0,
    cacheAgeSeconds: snapshot ? Math.round((Date.now() - snapshot.loadedAt) / 1000) : null,
  });
});

app.post("/refresh", async (_req, res) => {
  const s = await refresh();
  res.json({ meters: s.meters.length, issuesRepaired: s.issues.length });
});

app.get("/meters", async (req, res) => {
  const query = MetersQuery.parse(req.query);
  const { meters } = await getSnapshot();
  const same = (a: string, b: string | undefined) => b === undefined || a.toLowerCase() === b.toLowerCase();
  const text = query.q?.toLowerCase();

  let rows: (Meter & { distanceKm?: number })[] = meters.filter(
    (m) =>
      same(m.make, query.make) &&
      same(m.phaseType, query.phaseType) &&
      same(m.installStatus, query.installStatus) &&
      same(m.installType, query.installType) &&
      same(m.build, query.build) &&
      same(m.dtCode, query.dtCode) &&
      same(m.hierarchy.feeder.code ?? "", query.feederCode) &&
      same(m.hierarchy.zone.code ?? "", query.zoneCode) &&
      (!text || m.meterId.toLowerCase().includes(text) || m.serialNo.toLowerCase().includes(text)),
  );

  if (query.nearLat !== undefined && query.nearLng !== undefined) {
    const centre = { lat: query.nearLat, lng: query.nearLng };
    rows = rows
      .flatMap((m) => (m.location ? [{ ...m, distanceKm: Math.round(distanceKm(centre, m.location) * 1000) / 1000 }] : []))
      .filter((m) => m.distanceKm <= query.radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  const start = (query.page - 1) * query.pageSize;
  res.json({ data: rows.slice(start, start + query.pageSize), total: rows.length, page: query.page, pageSize: query.pageSize });
});

app.get("/meters/:id", async (req, res) => {
  const { meters } = await getSnapshot();
  const meter = meters.find((m) => m.meterId === req.params.id);
  if (!meter) throw new PortalError(404, "Meter not found");
  res.json(meter);
});

// Readings are fetched live on every call; they are the data that changes.
app.get("/meters/:id/readings", async (req, res) => {
  const range = RangeQuery.parse(req.query);
  const { granularity, data } = cleanReadings(await fetchReadings({ meterId: req.params.id, ...range }));
  res.json({ meterId: req.params.id, granularity, count: data.length, data });
});

app.get("/meters/:id/consumption/daily", async (req, res) => {
  const range = RangeQuery.parse(req.query);
  const days = dailyConsumption(cleanReadings(await fetchReadings({ meterId: req.params.id, ...range })).data);
  const totalKwh = Math.round(days.reduce((sum, d) => sum + d.kwh, 0) * 1000) / 1000;
  res.json({ meterId: req.params.id, totalKwh, data: days });
});

app.get("/transformers", async (_req, res) => {
  const { meters, transformers } = await getSnapshot();
  res.json({ data: transformers.map((t) => ({ ...t, meterCount: meters.filter((m) => m.dtCode === t.code).length })) });
});

app.get("/hierarchy", async (_req, res) => res.json((await getSnapshot()).tree));
app.get("/hierarchy/issues", async (_req, res) => res.json({ data: (await getSnapshot()).issues }));

const openapi: unknown = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
app.get("/openapi.json", (_req, res) => res.json(openapi));
app.get("/docs", (_req, res) => {
  res.type("html").send(`<!doctype html><title>Urja Meter API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<div id="ui"></div><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui" })</script>`);
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "bad_request", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  } else if (err instanceof PortalError) {
    res.status(err.status === 404 ? 404 : err.status === 503 ? 503 : 502)
      .json({ error: err.status === 404 ? "not_found" : "upstream_error", message: err.message });
  } else {
    res.status(500).json({ error: "internal_error", message: "unexpected error" });
  }
});

app.listen(PORT, () => process.stdout.write(`Urja Meter API on http://localhost:${PORT} (docs at /docs)\n`));
