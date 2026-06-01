import express from "express";
import path from "path";
import http from "http";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import fs from "fs";
import { parse } from "csv-parse/sync";

dotenv.config();

// ── Global crash guards (must be first) ─────────────────
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT]:", err.message);
});
process.on("unhandledRejection", (reason: any) => {
  console.error("[UNHANDLED REJECTION]:", reason?.message ?? reason);
});

// ── In-Memory Store (primary source of truth) ────────────
// This lets the server work even when the DB is unreachable.
interface EventRow {
  event_id: string;
  store_id: string;
  camera_id: string;
  visitor_id: string;
  event_type: string;
  timestamp: string;
  zone_id: string | null;
  dwell_ms: number;
  is_staff: boolean;
  confidence: number;
  metadata: Record<string, any>;
}

const memStore: {
  events: EventRow[];
  anomalies: any[];
  transactions: any[];
} = { events: [], anomalies: [], transactions: [] };

const MAX_MEM_EVENTS = 50000;

function memMetrics(storeId: string) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const todayEvents = memStore.events.filter(
    (e) => e.store_id === storeId && new Date(e.timestamp).getTime() >= todayMs && !e.is_staff
  );

  const unique_visitors = new Set(todayEvents.map((e) => e.visitor_id)).size;

  const todayTx = memStore.transactions.filter(
    (t) => t.store_id === storeId && new Date(t.timestamp).getTime() >= todayMs
  );
  const conversion_rate =
    unique_visitors > 0
      ? parseFloat(((todayTx.length / unique_visitors) * 100).toFixed(2))
      : 0;

  const lastQueue = todayEvents
    .filter((e) => e.event_type === "BILLING_QUEUE_JOIN")
    .slice(-1)[0];
  const queue_depth = parseInt(lastQueue?.metadata?.queue_depth ?? "0", 10);

  // dwell per zone
  const zoneMap: Record<string, number[]> = {};
  for (const e of todayEvents) {
    if (e.zone_id && e.dwell_ms > 0) {
      if (!zoneMap[e.zone_id]) zoneMap[e.zone_id] = [];
      zoneMap[e.zone_id].push(e.dwell_ms);
    }
  }
  const avg_dwell_zone: Record<string, string> = {};
  for (const [z, arr] of Object.entries(zoneMap)) {
    avg_dwell_zone[z] = (arr.reduce((a, b) => a + b, 0) / arr.length / 60000).toFixed(2);
  }

  const joins = todayEvents.filter((e) => e.event_type === "BILLING_QUEUE_JOIN").length;
  const abandons = todayEvents.filter((e) => e.event_type === "BILLING_QUEUE_ABANDON").length;
  const abandonment_rate = joins > 0 ? parseFloat(((abandons / joins) * 100).toFixed(2)) : 0;

  return { unique_visitors, conversion_rate, queue_depth, avg_dwell_zone, abandonment_rate };
}

function memFunnel(storeId: string) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const ev = memStore.events.filter(
    (e) => e.store_id === storeId && new Date(e.timestamp).getTime() >= todayMs && !e.is_staff
  );
  const entry_count = new Set(ev.map((e) => e.visitor_id)).size;
  const zone_visit_count = new Set(ev.filter((e) => e.zone_id && e.zone_id !== "BILLING").map((e) => e.visitor_id)).size;
  const billing_queue_count = new Set(ev.filter((e) => e.event_type === "BILLING_QUEUE_JOIN").map((e) => e.visitor_id)).size;
  const purchase_count = memStore.transactions.filter(
    (t) => t.store_id === storeId && new Date(t.timestamp).getTime() >= todayMs
  ).length;
  return { entry_count, zone_visit_count, billing_queue_count, purchase_count };
}

function memHeatmap(storeId: string) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const ev = memStore.events.filter(
    (e) => e.store_id === storeId && new Date(e.timestamp).getTime() >= todayMs && !e.is_staff && e.zone_id && e.dwell_ms > 0
  );
  const zoneMap: Record<string, { visitors: Set<string>; dwells: number[] }> = {};
  for (const e of ev) {
    if (!zoneMap[e.zone_id!]) zoneMap[e.zone_id!] = { visitors: new Set(), dwells: [] };
    zoneMap[e.zone_id!].visitors.add(e.visitor_id);
    zoneMap[e.zone_id!].dwells.push(e.dwell_ms);
  }
  const zones = Object.entries(zoneMap).map(([zone_id, d]) => ({
    zone_id,
    visit_count: d.visitors.size,
    avg_dwell: d.dwells.reduce((a, b) => a + b, 0) / d.dwells.length,
    heat_score: 0,
  }));
  const maxV = Math.max(1, ...zones.map((z) => z.visit_count));
  for (const z of zones) z.heat_score = Math.floor((z.visit_count / maxV) * 100);
  return { zones };
}

function detectAnomaliesFromMem(storeId: string): any[] {
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
  const recent = memStore.events.filter(
    (e) => e.store_id === storeId && new Date(e.timestamp) >= thirtyMinsAgo
  );
  const anomalies: any[] = [];
  const now = new Date().toISOString();

  // Queue spike
  const queueEvents = recent.filter((e) => e.event_type === "BILLING_QUEUE_JOIN");
  if (queueEvents.length > 2) {
    const depths = queueEvents.map((e) => parseInt(e.metadata?.queue_depth ?? "0", 10));
    const avg = depths.reduce((a, b) => a + b, 0) / depths.length;
    const current = depths[depths.length - 1];
    if (current > Math.max(3, avg * 2)) {
      anomalies.push({
        store_id: storeId, type: "QUEUE_SPIKE", severity: "CRITICAL", timestamp: now,
        suggested_action: `Queue depth ${current} exceeds 2x average (${avg.toFixed(1)}). Open additional registers.`,
      });
    }
  }

  // High abandonment
  const joins = recent.filter((e) => e.event_type === "BILLING_QUEUE_JOIN").length;
  const abandons = recent.filter((e) => e.event_type === "BILLING_QUEUE_ABANDON").length;
  if (joins > 3 && abandons / joins > 0.4) {
    anomalies.push({
      store_id: storeId, type: "HIGH_ABANDONMENT", severity: "WARN", timestamp: now,
      suggested_action: `${((abandons / joins) * 100).toFixed(0)}% abandonment rate. Investigate wait times.`,
    });
  }

  return anomalies;
}

let csvAnalytics: any = null;

function loadCsvData() {
  try {
    const csvPath = path.join(process.cwd(), "CCTV Footage", "Brigade_Bangalore_10_April_26 (1)bc6219c.csv");
    if (!fs.existsSync(csvPath)) return;
    const content = fs.readFileSync(csvPath, "utf-8");
    const records = parse(content, { columns: true, skip_empty_lines: true });
    
    const brandMap: Record<string, number> = {};
    const depMap: Record<string, number> = {};
    const salesMap: Record<string, number> = {};

    for (const row of records) {
      const amt = parseFloat(row.total_amount || "0");
      if (row.brand_name) brandMap[row.brand_name] = (brandMap[row.brand_name] || 0) + amt;
      if (row.dep_name) depMap[row.dep_name] = (depMap[row.dep_name] || 0) + amt;
      if (row.salesperson_name) salesMap[row.salesperson_name] = (salesMap[row.salesperson_name] || 0) + amt;
    }

    const sortMap = (m: Record<string, number>) => Object.entries(m).map(([name, value]) => ({ name, value: Math.round(value) })).sort((a, b) => b.value - a.value);

    csvAnalytics = {
      topBrands: sortMap(brandMap).slice(0, 10),
      categories: sortMap(depMap),
      topSalespersons: sortMap(salesMap).slice(0, 10)
    };
    console.log("[CSV] Loaded analytics data from Brigade_Bangalore CSV");
  } catch(e: any) {
    console.error("[CSV] Error loading CSV:", e.message);
  }
}

// ── DB Pool (optional, non-blocking) ─────────────────────
async function startServer() {
  loadCsvData();
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "5mb" }));

  // ── WebSocket Setup ──────────────────────────────────────

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const wsClients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    console.log(`[WS] Client connected (${wsClients.size} total)`);
    ws.on("close", () => {
      wsClients.delete(ws);
      console.log(`[WS] Client disconnected (${wsClients.size} total)`);
    });
    ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
  });

  function broadcast(data: object) {
    const msg = JSON.stringify(data);
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  // ── Video Frame Streaming ────────────────────────────────

  app.post("/api/video/frame", (req, res) => {
    const { frame, camera_id } = req.body;
    if (frame) broadcast({ type: "video_frame", camera_id, data: frame });
    res.status(200).json({ status: "ok" });
  });

  // ── Event Ingest ─────────────────────────────────────────

  app.post("/api/events/ingest", async (req, res) => {
    const { events } = req.body;
    if (!events || !Array.isArray(events)) {
      return res.status(400).json({ error: "Missing events array" });
    }

    // 1. Write to in-memory store immediately
    for (const ev of events) {
      memStore.events.push({
        event_id: ev.event_id,
        store_id: ev.store_id,
        camera_id: ev.camera_id,
        visitor_id: ev.visitor_id,
        event_type: ev.event_type,
        timestamp: ev.timestamp,
        zone_id: ev.zone_id ?? null,
        dwell_ms: ev.dwell_ms ?? 0,
        is_staff: ev.is_staff ?? false,
        confidence: ev.confidence ?? 0.9,
        metadata: ev.metadata ?? {},
      });

      if (ev.event_type === "ZONE_EXIT" && ev.zone_id === "BILLING" && ev.metadata?.purchased) {
        const tx = {
          transaction_id: `TXN_${ev.event_id.slice(0, 8)}`,
          store_id: ev.store_id,
          timestamp: ev.timestamp,
          basket_value: ev.metadata?.transaction?.total_amount ? parseFloat(ev.metadata.transaction.total_amount) : (50 + Math.random() * 250),
        };
        memStore.transactions.push(tx);
        // DB write disabled in in-memory-only mode
      }
    }

    // Trim memory if needed
    if (memStore.events.length > MAX_MEM_EVENTS) {
      memStore.events = memStore.events.slice(-MAX_MEM_EVENTS);
    }

    // 2. Async DB write (best-effort) - DISABLED (in-memory only mode)
    // DB writes removed to ensure server stability

    // 3. Broadcast to WebSocket clients
    broadcast({
      type: "events",
      data: events.map((ev: any) => ({
        event_type: ev.event_type,
        visitor_id: ev.visitor_id,
        zone_id: ev.zone_id,
        timestamp: ev.timestamp,
        dwell_ms: ev.dwell_ms,
        is_staff: ev.is_staff,
      })),
    });

    // 4. Run anomaly detection from memory (~20% of ingests)
    const storeIds = new Set<string>(events.map((e: any) => e.store_id));
    for (const sid of storeIds) {
      if (Math.random() < 0.2) {
        const anomalies = detectAnomaliesFromMem(sid);
        if (anomalies.length > 0) {
          memStore.anomalies.push(...anomalies);
          broadcast({ type: "anomalies", data: anomalies });
          // DB write disabled in-memory-only mode
        }
      }
    }

    res.json({ status: "success", processed: events.length });
  });

  // ── API Endpoints (served from memory) ───────────────────

  app.get("/api/stores/:id/metrics", (req, res) => {
    try {
      const data = memMetrics(req.params.id);
      broadcast({ type: "metrics", data });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/api/stores/:id/funnel", (req, res) => {
    try {
      res.json(memFunnel(req.params.id));
    } catch (e) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/api/stores/:id/heatmap", (req, res) => {
    try {
      res.json(memHeatmap(req.params.id));
    } catch (e) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/api/stores/:id/anomalies", (req, res) => {
    try {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const todayMs = today.getTime();
      const results = memStore.anomalies
        .filter((a) => a.store_id === req.params.id && new Date(a.timestamp).getTime() >= todayMs)
        .slice(-10)
        .reverse();
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/api/stores/:id/analytics", (req, res) => {
    try {
      if (!csvAnalytics) {
         return res.json({ topBrands: [], categories: [], topSalespersons: [] });
      }
      res.json(csvAnalytics);
    } catch (e) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      db: "in-memory",
      events_in_memory: memStore.events.length,
      ws_clients: wsClients.size,
      uptime: process.uptime(),
    });
  });

  // ── Vite Middleware ──────────────────────────────────────

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║   🏬 Retail Intelligence Server                     ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`║  HTTP:      http://localhost:${PORT}                    ║`);
    console.log(`║  WebSocket: ws://localhost:${PORT}/ws                   ║`);
    console.log(`║  Ingest:    POST /api/events/ingest                 ║`);
    console.log(`║  Mode:      In-Memory (no DB needed)        ║`);
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log("");
  });
}

startServer();
