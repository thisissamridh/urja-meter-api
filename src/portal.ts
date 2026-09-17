// Client for the Urja Meter Ops portal. Everything portal-specific lives here:
// login, the session cookie, the HMAC-signed bulk export, rate-limit backoff.
// See PROTOCOL.md for how each of these was discovered.
import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const BASE = process.env.URJA_BASE_URL ?? "https://urja-ops.flockenergy.tech";
const EMAIL = process.env.URJA_EMAIL ?? "operator@urja.local";
const PASSWORD = process.env.URJA_PASSWORD ?? "urja-ops-2026";

export class PortalError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Shapes of the portal's responses, validated once at the boundary.
const Node = z.object({ name: z.string(), code: z.string() });
const ExportMeter = z.object({
  meterId: z.string(),
  serialNo: z.string(),
  make: z.string(),
  phaseType: z.string(),
  installStatus: z.string(),
  installType: z.string(),
  build: z.string(),
  dtCode: z.string(),
  hierarchy: z.object({
    zone: Node, circle: Node, division: Node, subdivision: Node,
    substation: Node, feeder: Node, dt: Node,
  }),
  geo: z.object({ lat: z.number(), lng: z.number() }).nullable(),
});
const Transformer = z.object({
  code: z.string(), name: z.string(), feederCode: z.string(), capacityKva: z.number(),
});
const RawReading = z.object({
  timestamp: z.string(), kwh: z.string(), kvah: z.string(), voltR: z.string(),
});

export type ExportMeter = z.infer<typeof ExportMeter>;
export type Transformer = z.infer<typeof Transformer>;
export type RawReading = z.infer<typeof RawReading>;

let cookie = "";
let signingSecret = "";

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    redirect: "manual",
    // SvelteKit form actions reject cross-origin posts, so send Origin.
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }),
  });
  const session = res.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!session) throw new PortalError(502, `portal login failed (${res.status})`);
  cookie = session.split(";")[0] ?? "";
  signingSecret = "";
}

// GET with re-login on expired session, backoff on 429, retry on 5xx/network.
async function get<T>(path: string, schema: z.ZodType<T>, headers: Record<string, string> = {}): Promise<T> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!cookie) await login();
    let res: Response;
    try {
      res = await fetch(BASE + path, {
        headers: { cookie, ...headers },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      await sleep(500 * (attempt + 1));
      continue;
    }
    lastStatus = res.status;
    if (res.status === 200) {
      const parsed = schema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new PortalError(502, `unexpected portal response for ${path}`);
      return parsed.data;
    }
    if (res.status === 404) throw new PortalError(404, "Meter not found");
    if (res.status === 302 || (res.status === 401 && !path.startsWith("/portal/export"))) {
      cookie = ""; // session expired (cookie lives one hour)
    } else if (res.status === 401) {
      throw new PortalError(401, "export signature rejected");
    } else if (res.status === 429) {
      // ~120 requests per 20s, then a ~40s lockout, and no Retry-After header
      await sleep(Math.min(45_000, 5_000 * 2 ** attempt));
    } else if (res.status >= 500) {
      await sleep(500 * (attempt + 1));
    } else {
      throw new PortalError(502, `portal returned ${res.status}`);
    }
  }
  throw new PortalError(503, `portal kept failing (last status ${lastStatus})`);
}

export async function fetchReadings(args: { meterId: string; from?: string; to?: string }): Promise<RawReading[]> {
  const qs = new URLSearchParams();
  if (args.from) qs.set("from", args.from);
  if (args.to) qs.set("to", args.to);
  const path = `/portal/meters/${encodeURIComponent(args.meterId)}/energy?${qs}`;
  return (await get(path, z.object({ data: z.array(RawReading) }))).data;
}

export async function fetchTransformers(): Promise<Transformer[]> {
  const Page = z.object({ data: z.array(Transformer), total: z.number() });
  const all: Transformer[] = [];
  for (let page = 1; ; page++) {
    const res = await get(`/portal/dts?page=${page}`, Page);
    all.push(...res.data);
    if (all.length >= res.total || res.data.length === 0) return all;
  }
}

// Bulk export: every meter with hierarchy and location in one signed request.
export async function fetchExport(): Promise<ExportMeter[]> {
  const Keys = z.object({ data: z.object({ signingSecret: z.string() }) });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!signingSecret) signingSecret = (await get("/portal/keys", Keys)).data.signingSecret;
    const query = "page=1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const message = ["GET", "/portal/export", query, timestamp].join("\n");
    const signature = createHmac("sha256", signingSecret).update(message).digest("hex");
    try {
      const res = await get(`/portal/export?${query}`, z.object({ data: z.array(ExportMeter) }), {
        "x-timestamp": timestamp,
        "x-signature": signature,
      });
      return res.data;
    } catch (err) {
      if (err instanceof PortalError && err.status === 401 && attempt === 0) {
        signingSecret = ""; // secret may have rotated, refetch once
        continue;
      }
      throw err;
    }
  }
  throw new PortalError(502, "export signature rejected");
}
