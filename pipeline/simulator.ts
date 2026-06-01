/**
 * Retail Store Intelligence — Event Simulator
 *
 * Generates realistic visitor journey events that mirror what the
 * YOLOv8 + ByteTrack detection pipeline would produce from CCTV footage.
 *
 * Each visitor follows a probabilistic journey:
 *   ENTRY → ZONE_DWELL (1-3 zones) → BILLING_QUEUE_JOIN → Purchase/Abandon → EXIT
 *
 * Usage:
 *   npx tsx pipeline/simulator.ts
 *   npx tsx pipeline/simulator.ts --rate 5 --store STORE_002
 */

import crypto from "crypto";
import fs from "fs";
import { parse } from "csv-parse/sync";
import path from "path";

const API_URL = process.env.API_URL || "http://localhost:3000/api/events/ingest";
const STORE_ID = process.argv.includes("--store")
  ? process.argv[process.argv.indexOf("--store") + 1]
  : "STORE_001";
const RATE = process.argv.includes("--rate")
  ? parseFloat(process.argv[process.argv.indexOf("--rate") + 1])
  : 3; // avg visitors per cycle

const ZONES = ["SKINCARE", "FRAGRANCE", "MAKEUP", "ELECTRONICS", "GROCERY"];
const CAMERA_IDS = ["CAM_ENTRY", "CAM_FLOOR_1", "CAM_FLOOR_2", "CAM_BILLING"];

// ── Helpers ──────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function visitorId(): string {
  return `VIS_${crypto.randomBytes(4).toString("hex")}`;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function poissonDelay(ratePer10Sec: number): number {
  // Returns delay in ms until next arrival (exponential inter-arrival)
  return Math.max(500, (-Math.log(1 - Math.random()) / ratePer10Sec) * 10000);
}

function expRandom(mean: number): number {
  return -mean * Math.log(1 - Math.random());
}

function createEvent(
  storeId: string,
  cameraId: string,
  vid: string,
  eventType: string,
  opts: {
    zoneId?: string;
    dwellMs?: number;
    isStaff?: boolean;
    confidence?: number;
    metadata?: Record<string, unknown>;
  } = {}
) {
  return {
    event_id: uuid(),
    store_id: storeId,
    camera_id: cameraId,
    visitor_id: vid,
    event_type: eventType,
    timestamp: new Date().toISOString(),
    zone_id: opts.zoneId || null,
    dwell_ms: opts.dwellMs || 0,
    is_staff: opts.isStaff || false,
    confidence: opts.confidence ?? 0.85 + Math.random() * 0.14,
    metadata: opts.metadata || {},
  };
}

async function emitEvents(events: ReturnType<typeof createEvent>[]) {
  if (events.length === 0) return;
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      console.error(`  ⚠ Ingest failed: ${res.status} ${res.statusText}`);
    }
  } catch (e: any) {
    console.error(`  ⚠ Ingest error: ${e.message}`);
  }
}

// ── Visitor Journey Simulation ───────────────────────────

interface ActiveVisitor {
  vid: string;
  isStaff: boolean;
  phase: "entered" | "browsing" | "billing" | "exiting";
  zones: string[];
  currentZone: string | null;
  zoneEnterTime: number;
  nextActionAt: number;
  seq: number;
}

const activeVisitors: ActiveVisitor[] = [];
let queueDepth = 0;
let totalEmitted = 0;
let cycleCount = 0;

let csvTransactions: any[] = [];
let nextTxIndex = 0;

function loadCsvTransactions() {
  try {
    const csvPath = path.join(process.cwd(), "CCTV Footage", "Brigade_Bangalore_10_April_26 (1)bc6219c.csv");
    if (!fs.existsSync(csvPath)) return;
    const content = fs.readFileSync(csvPath, "utf-8");
    const records = parse(content, { columns: true, skip_empty_lines: true });
    
    // Group by invoice
    const invoices: Record<string, any> = {};
    for (const r of records) {
      const inv = r.invoice_number;
      if (!inv) continue;
      if (!invoices[inv]) {
        invoices[inv] = { invoice_number: inv, total_amount: 0, items: [] };
      }
      invoices[inv].total_amount += parseFloat(r.total_amount || "0");
      invoices[inv].items.push(r);
    }
    csvTransactions = Object.values(invoices);
    console.log(`[Simulator] Loaded ${csvTransactions.length} real transactions from CSV.`);
  } catch(e: any) {
    console.error("[Simulator] Error loading CSV:", e.message);
  }
}

async function tick() {
  cycleCount++;
  const now = Date.now();
  const events: ReturnType<typeof createEvent>[] = [];

  // ── Spawn new visitors (Poisson arrivals) ──
  const newCount = Math.max(0, Math.round(RATE * 0.3 + (Math.random() - 0.3) * 2));
  for (let i = 0; i < newCount; i++) {
    const vid = visitorId();
    const isStaff = Math.random() < 0.05;
    const isReentry = Math.random() < 0.1;

    events.push(
      createEvent(STORE_ID, "CAM_ENTRY", vid, isReentry ? "REENTRY" : "ENTRY", {
        isStaff,
        metadata: { session_seq: 1 },
      })
    );

    // Pick 1-3 zones to visit
    const zoneCount = 1 + Math.floor(Math.random() * 3);
    const shuffled = [...ZONES].sort(() => Math.random() - 0.5);
    const zones = shuffled.slice(0, zoneCount);

    activeVisitors.push({
      vid,
      isStaff,
      phase: "entered",
      zones,
      currentZone: null,
      zoneEnterTime: now,
      nextActionAt: now + expRandom(3000), // 3s avg before first zone visit
      seq: 1,
    });
  }

  // ── Progress existing visitors ──
  const toRemove: number[] = [];

  for (let i = 0; i < activeVisitors.length; i++) {
    const v = activeVisitors[i];
    if (now < v.nextActionAt) continue;

    v.seq++;

    if (v.phase === "entered" || v.phase === "browsing") {
      // If currently in a zone, emit ZONE_DWELL then ZONE_EXIT
      if (v.currentZone) {
        const dwell = now - v.zoneEnterTime;
        events.push(
          createEvent(STORE_ID, pick(CAMERA_IDS), v.vid, "ZONE_DWELL", {
            zoneId: v.currentZone,
            dwellMs: Math.floor(dwell),
            isStaff: v.isStaff,
            metadata: { session_seq: v.seq },
          })
        );
        v.seq++;
        events.push(
          createEvent(STORE_ID, pick(CAMERA_IDS), v.vid, "ZONE_EXIT", {
            zoneId: v.currentZone,
            dwellMs: Math.floor(dwell),
            isStaff: v.isStaff,
            metadata: { session_seq: v.seq },
          })
        );
        v.currentZone = null;
      }

      // Next zone or move to billing
      if (v.zones.length > 0) {
        const zone = v.zones.shift()!;
        v.currentZone = zone;
        v.zoneEnterTime = now;
        v.phase = "browsing";

        events.push(
          createEvent(STORE_ID, pick(CAMERA_IDS), v.vid, "ZONE_ENTER", {
            zoneId: zone,
            isStaff: v.isStaff,
            metadata: { session_seq: v.seq },
          })
        );

        // Schedule next action (dwell 5-30s in sim time, compressed from real 1-10min)
        v.nextActionAt = now + expRandom(8000);
      } else {
        // Done browsing → billing or exit
        if (Math.random() < 0.65 && !v.isStaff) {
          v.phase = "billing";
          queueDepth++;
          events.push(
            createEvent(STORE_ID, "CAM_BILLING", v.vid, "BILLING_QUEUE_JOIN", {
              zoneId: "BILLING",
              isStaff: v.isStaff,
              metadata: { session_seq: v.seq, queue_depth: queueDepth },
            })
          );
          v.nextActionAt = now + expRandom(10000); // 10s avg in billing
        } else {
          v.phase = "exiting";
          v.nextActionAt = now;
        }
      }
    } else if (v.phase === "billing") {
      queueDepth = Math.max(0, queueDepth - 1);

      // 75% purchase, 25% abandon
      if (Math.random() < 0.75) {
        // Purchase event is handled by the server on ingest (create transaction)
        let transaction = null;
        if (csvTransactions.length > 0) {
          transaction = csvTransactions[nextTxIndex];
          nextTxIndex = (nextTxIndex + 1) % csvTransactions.length;
        }

        events.push(
          createEvent(STORE_ID, "CAM_BILLING", v.vid, "ZONE_EXIT", {
            zoneId: "BILLING",
            dwellMs: Math.floor(now - v.zoneEnterTime),
            isStaff: v.isStaff,
            metadata: { session_seq: v.seq, purchased: true, transaction },
          })
        );
      } else {
        events.push(
          createEvent(STORE_ID, "CAM_BILLING", v.vid, "BILLING_QUEUE_ABANDON", {
            zoneId: "BILLING",
            dwellMs: Math.floor(now - v.zoneEnterTime),
            isStaff: v.isStaff,
            metadata: { session_seq: v.seq },
          })
        );
      }

      v.phase = "exiting";
      v.nextActionAt = now + 1000;
    } else if (v.phase === "exiting") {
      events.push(
        createEvent(STORE_ID, "CAM_ENTRY", v.vid, "EXIT", {
          isStaff: v.isStaff,
          metadata: { session_seq: v.seq },
        })
      );
      toRemove.push(i);
    }
  }

  // Remove exited visitors (reverse order to preserve indices)
  for (let i = toRemove.length - 1; i >= 0; i--) {
    activeVisitors.splice(toRemove[i], 1);
  }

  // ── Emit all events ──
  if (events.length > 0) {
    await emitEvents(events);
    totalEmitted += events.length;

    // Console log summary
    const entries = events.filter((e) => e.event_type === "ENTRY" || e.event_type === "REENTRY").length;
    const exits = events.filter((e) => e.event_type === "EXIT").length;
    const dwells = events.filter((e) => e.event_type === "ZONE_DWELL").length;
    const billing = events.filter((e) => e.event_type === "BILLING_QUEUE_JOIN").length;

    console.log(
      `[${new Date().toLocaleTimeString()}] ` +
      `📡 ${events.length} events | ` +
      `👤 +${entries} enter / -${exits} exit | ` +
      `🏪 ${dwells} dwell | ` +
      `💳 ${billing} billing | ` +
      `👥 ${activeVisitors.length} active | ` +
      `📊 ${totalEmitted} total`
    );
  }
}

// ── Main Loop ────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   🏬 Retail Intelligence — Event Simulator          ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Store:  ${STORE_ID.padEnd(43)}║`);
  console.log(`║  Rate:   ~${RATE} visitors/cycle${" ".repeat(30)}║`);
  console.log(`║  Target: ${API_URL.padEnd(43).slice(0, 43)}║`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");

  loadCsvTransactions();

  // Run tick every 2 seconds
  const interval = setInterval(async () => {
    try {
      await tick();
    } catch (e) {
      console.error("Tick error:", e);
    }
  }, 2000);

  process.on("SIGINT", () => {
    console.log(`\n\n🛑 Simulator stopped. Total events emitted: ${totalEmitted}`);
    clearInterval(interval);
    process.exit(0);
  });
}

main();
