import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Users,
  ShoppingBag,
  Clock,
  AlertTriangle,
  Activity,
  Zap,
  Eye,
  TrendingUp,
  Radio,
  ShieldAlert,
  BarChart3,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';

// ── Types ──────────────────────────────────────────────

interface Metrics {
  unique_visitors: number;
  conversion_rate: number;
  queue_depth: number;
  abandonment_rate: number;
  avg_dwell_zone: Record<string, string>;
}

interface FunnelData {
  entry_count: number;
  zone_visit_count: number;
  billing_queue_count: number;
  purchase_count: number;
}

interface HeatmapZone {
  name: string;
  visits: number;
  metric: number;
  avg_dwell: number;
}

interface LiveEvent {
  id: string;
  event_type: string;
  visitor_id: string;
  zone_id: string | null;
  timestamp: string;
  dwell_ms: number;
  is_staff: boolean;
}

interface Anomaly {
  id: number;
  type: string;
  severity: string;
  msg: string;
  time: string;
}

interface AnalyticsData {
  topBrands: { name: string; value: number }[];
  categories: { name: string; value: number }[];
  topSalespersons: { name: string; value: number }[];
}

// ── Constants ──────────────────────────────────────────

const API_URL = '/api';
const STORE_ID = 'STORE_001';
const WS_URL = `ws://${window.location.host}/ws`;

const EVENT_ICONS: Record<string, string> = {
  ENTRY: '🚶',
  REENTRY: '🔄',
  EXIT: '🚪',
  ZONE_ENTER: '📍',
  ZONE_EXIT: '📤',
  ZONE_DWELL: '⏱️',
  BILLING_QUEUE_JOIN: '💳',
  BILLING_QUEUE_ABANDON: '❌',
};

const EVENT_COLORS: Record<string, string> = {
  ENTRY: '#34d399',
  REENTRY: '#22d3ee',
  EXIT: '#94a3b8',
  ZONE_ENTER: '#a78bfa',
  ZONE_EXIT: '#818cf8',
  ZONE_DWELL: '#fbbf24',
  BILLING_QUEUE_JOIN: '#34d399',
  BILLING_QUEUE_ABANDON: '#fb7185',
};

const ZONE_COLORS: Record<string, string> = {
  SKINCARE: '#f472b6',
  FRAGRANCE: '#a78bfa',
  MAKEUP: '#fb923c',
  ELECTRONICS: '#22d3ee',
  GROCERY: '#34d399',
  BILLING: '#fbbf24',
};

// ── Main App ───────────────────────────────────────────

export default function App() {
  const [metrics, setMetrics] = useState<Metrics>({
    unique_visitors: 0,
    conversion_rate: 0,
    queue_depth: 0,
    abandonment_rate: 0,
    avg_dwell_zone: {},
  });

  const [heatmap, setHeatmap] = useState<HeatmapZone[]>([]);
  const [funnel, setFunnel] = useState<FunnelData>({
    entry_count: 0,
    zone_visit_count: 0,
    billing_queue_count: 0,
    purchase_count: 0,
  });
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData>({
    topBrands: [],
    categories: [],
    topSalespersons: [],
  });
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [hasLiveFrame, setHasLiveFrame] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenImg = useRef<HTMLImageElement>(new Image());
  const [wsConnected, setWsConnected] = useState(false);
  const [eventsPerSec, setEventsPerSec] = useState(0);
  const eventCountRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);

  // ── WebSocket Connection ─────────────────────────────

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        console.log('[WS] Connected');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'events' && Array.isArray(msg.data)) {
            eventCountRef.current += msg.data.length;
            const newEvents: LiveEvent[] = msg.data.map((e: any, i: number) => ({
              id: `${Date.now()}-${i}-${Math.random()}`,
              ...e,
            }));
            setLiveEvents((prev) => [...newEvents, ...prev].slice(0, 50));
          }

          if (msg.type === 'metrics') {
            setMetrics(msg.data);
          }
          
          if (msg.type === 'video_frame' && msg.data) {
            const img = offscreenImg.current;
            img.onload = () => {
              const canvas = canvasRef.current;
              if (!canvas) return;
              canvas.width = img.naturalWidth || canvas.clientWidth;
              canvas.height = img.naturalHeight || canvas.clientHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              setHasLiveFrame(true);
            };
            img.src = `data:image/jpeg;base64,${msg.data}`;
          }

          if (msg.type === 'anomalies' && Array.isArray(msg.data)) {
            const newAnoms = msg.data.map((a: any, idx: number) => ({
              id: Date.now() + idx,
              type: a.type,
              severity: a.severity,
              msg: a.suggested_action,
              time: new Date(a.timestamp).toLocaleTimeString(),
            }));
            setAnomalies((prev) => [...newAnoms, ...prev].slice(0, 20));
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        console.log('[WS] Disconnected, reconnecting...');
        reconnectTimeout = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      ws?.close();
    };
  }, []);

  // ── Events per second counter ────────────────────────

  useEffect(() => {
    const interval = setInterval(() => {
      setEventsPerSec(eventCountRef.current);
      eventCountRef.current = 0;
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // ── HTTP Polling (fallback + initial load) ───────────

  const fetchData = useCallback(async () => {
    try {
      const [metricsRes, funnelRes, heatRes, anomRes, analyticsRes] = await Promise.all([
        fetch(`${API_URL}/stores/${STORE_ID}/metrics`),
        fetch(`${API_URL}/stores/${STORE_ID}/funnel`),
        fetch(`${API_URL}/stores/${STORE_ID}/heatmap`),
        fetch(`${API_URL}/stores/${STORE_ID}/anomalies`),
        fetch(`${API_URL}/stores/${STORE_ID}/analytics`),
      ]);

      if (metricsRes.ok) {
        const m = await metricsRes.json();
        setMetrics(m);
      }

      if (funnelRes.ok) {
        const f = await funnelRes.json();
        setFunnel(f);
      }

      if (heatRes.ok) {
        const h = await heatRes.json();
        setHeatmap(
          h.zones.map((z: any) => ({
            name: z.zone_id,
            visits: z.visit_count,
            metric: z.heat_score,
            avg_dwell: z.avg_dwell,
          }))
        );
      }

      if (anomRes.ok) {
        const a = await anomRes.json();
        setAnomalies(
          a.map((item: any, idx: number) => ({
            id: idx,
            type: item.type,
            severity: item.severity,
            msg: item.suggested_action,
            time: new Date(item.timestamp).toLocaleTimeString(),
          }))
        );
      }

      if (analyticsRes.ok) {
        const data = await analyticsRes.json();
        setAnalytics(data);
      }
    } catch (e) {
      console.error('Fetch error:', e);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ── Computed values ──────────────────────────────────

  const maxDwell = (Object.values(metrics.avg_dwell_zone) as string[]).reduce(
    (max: number, v: string) => Math.max(max, parseFloat(v)),
    0
  );

  const funnelStages = [
    { label: 'Entry', count: funnel.entry_count, color: '#34d399' },
    { label: 'Zone Visit', count: funnel.zone_visit_count, color: '#22d3ee' },
    { label: 'Billing Queue', count: funnel.billing_queue_count, color: '#a78bfa' },
    { label: 'Purchase', count: funnel.purchase_count, color: '#fbbf24' },
  ];

  // ── Render ───────────────────────────────────────────

  return (
    <div className="min-h-screen p-4 md:p-6 flex flex-col gap-5" style={{ background: 'var(--bg-primary)' }}>
      {/* ── Header ─────────────────────────────────── */}
      <header className="flex flex-wrap justify-between items-end gap-4 pb-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full" style={{ background: wsConnected ? 'var(--emerald)' : '#ef4444', boxShadow: wsConnected ? '0 0 8px var(--emerald-glow)' : '0 0 8px rgba(239,68,68,0.4)', animation: wsConnected ? 'pulse-glow 2s ease-in-out infinite' : 'none' }} />
            <span className="font-mono text-xs tracking-widest uppercase" style={{ color: wsConnected ? 'var(--emerald)' : '#ef4444' }}>
              {wsConnected ? 'LIVE' : 'RECONNECTING'}
            </span>
            {eventsPerSec > 0 && (
              <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                · {eventsPerSec} evt/s
              </span>
            )}
          </div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
            <span className="text-gradient-emerald">Retail Intelligence</span>
            <span style={{ color: 'var(--text-muted)', fontWeight: 300 }}> / {STORE_ID}</span>
          </h1>
        </div>

        <div className="hidden md:flex gap-6 text-right font-mono">
          <StatusChip label="Pipeline" value="YOLOv8 + ByteTrack" icon={<Eye className="w-3 h-3" />} />
          <StatusChip label="Ingest" value={`${liveEvents.length} buffered`} icon={<Radio className="w-3 h-3" />} />
          <StatusChip label="Time" value={new Date().toLocaleTimeString()} icon={<Clock className="w-3 h-3" />} />
        </div>
      </header>

      {/* ── KPI Cards ──────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          icon={<Users className="w-5 h-5" />}
          label="Unique Visitors"
          value={metrics.unique_visitors}
          color="var(--emerald)"
          glowColor="var(--emerald-glow)"
        />
        <KPICard
          icon={<TrendingUp className="w-5 h-5" />}
          label="Conversion Rate"
          value={`${metrics.conversion_rate}%`}
          color="var(--cyan)"
          glowColor="var(--cyan-glow)"
        />
        <KPICard
          icon={<ShoppingBag className="w-5 h-5" />}
          label="Queue Depth"
          value={metrics.queue_depth}
          color={metrics.queue_depth > 5 ? 'var(--rose)' : 'var(--emerald)'}
          glowColor={metrics.queue_depth > 5 ? 'var(--rose-glow)' : 'var(--emerald-glow)'}
          alert={metrics.queue_depth > 5}
        />
        <KPICard
          icon={<AlertTriangle className="w-5 h-5" />}
          label="Abandonment Rate"
          value={`${metrics.abandonment_rate}%`}
          color={metrics.abandonment_rate > 30 ? 'var(--amber)' : 'var(--emerald)'}
          glowColor={metrics.abandonment_rate > 30 ? 'var(--amber-glow)' : 'var(--emerald-glow)'}
        />
      </div>

      {/* ── Main Grid ──────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 flex-1">
        {/* Left: Zone Heatmap + Funnel */}
        <div className="lg:col-span-2 flex flex-col gap-5">
          {/* Zone Activity */}
          <div className="glass-card-elevated p-5 flex-1">
            <div className="flex items-center justify-between mb-5">
              <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
                <BarChart3 className="w-4 h-4" style={{ color: 'var(--emerald)' }} />
                Zone Activity Heatmap
              </h2>
              <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                {heatmap.length} zones
              </span>
            </div>
            <div style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={heatmap} barCategoryGap="20%">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                  <XAxis
                    dataKey="name"
                    stroke="rgba(255,255,255,0.3)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    fontFamily="var(--font-mono)"
                  />
                  <YAxis
                    stroke="rgba(255,255,255,0.3)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    fontFamily="var(--font-mono)"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--bg-card-elevated)',
                      border: '1px solid var(--border-accent)',
                      borderRadius: '8px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                      color: 'var(--text-primary)',
                    }}
                    cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  />
                  <Bar dataKey="visits" radius={[6, 6, 0, 0]}>
                    {heatmap.map((entry, index) => (
                      <Cell
                        key={index}
                        fill={ZONE_COLORS[entry.name] || '#34d399'}
                        fillOpacity={0.3 + (entry.metric / 100) * 0.7}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Funnel */}
          <div className="glass-card-elevated p-5">
            <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest mb-5" style={{ color: 'var(--text-secondary)' }}>
              <Activity className="w-4 h-4" style={{ color: 'var(--cyan)' }} />
              Purchase Funnel
            </h2>
            <div className="space-y-4">
              {funnelStages.map((stage, i) => {
                const pct = funnel.entry_count > 0
                  ? i === 0
                    ? 100
                    : Math.round((stage.count / funnel.entry_count) * 100)
                  : 0;
                return (
                  <div key={stage.label}>
                    <div className="flex justify-between items-center mb-1.5">
                      <span className="font-mono text-xs uppercase tracking-wider" style={{ color: stage.color }}>
                        {stage.label}
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {stage.count}
                        </span>
                        <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                          {pct}%
                        </span>
                      </div>
                    </div>
                    <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                      <motion.div
                        className="h-full rounded-full"
                        style={{ background: stage.color, boxShadow: `0 0 12px ${stage.color}40` }}
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Column: Live Feed + Anomalies */}
        <div className="flex flex-col gap-5">
          {/* Live Camera Feed */}
          <div className="glass-card-elevated p-5 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
                <Eye className="w-4 h-4" style={{ color: 'var(--cyan)' }} />
                Live Camera Feed
              </h2>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full animate-pulse-glow" style={{ background: hasLiveFrame ? 'var(--cyan)' : 'var(--text-muted)' }} />
                <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                  {hasLiveFrame ? 'streaming' : 'waiting'}
                </span>
              </div>
            </div>
            <div className="w-full bg-black/40 rounded-lg overflow-hidden border border-[var(--border-subtle)] relative aspect-video flex items-center justify-center">
              <canvas
                ref={canvasRef}
                className="w-full h-full object-cover"
                style={{ display: hasLiveFrame ? 'block' : 'none', imageRendering: 'auto' }}
              />
              {!hasLiveFrame && (
                <div className="flex flex-col items-center gap-2 absolute inset-0 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                  <Eye className="w-6 h-6 opacity-30" />
                  <span className="font-mono text-xs uppercase tracking-wider">No Video Signal</span>
                </div>
              )}
            </div>
          </div>

          {/* Live Event Feed */}
          <div className="glass-card-elevated p-5 flex-1 flex flex-col" style={{ maxHeight: 420 }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
                <Zap className="w-4 h-4" style={{ color: 'var(--amber)' }} />
                Live Event Feed
              </h2>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full animate-pulse-glow" style={{ background: 'var(--emerald)' }} />
                <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>streaming</span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
              <AnimatePresence initial={false}>
                {liveEvents.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full py-12" style={{ color: 'var(--text-muted)' }}>
                    <Radio className="w-8 h-8 mb-3 opacity-30" />
                    <p className="font-mono text-xs uppercase tracking-wider">Waiting for events...</p>
                    <p className="font-mono text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Run: npm run simulate</p>
                  </div>
                ) : (
                  liveEvents.slice(0, 25).map((ev) => (
                    <motion.div
                      key={ev.id}
                      initial={{ opacity: 0, x: 30, height: 0 }}
                      animate={{ opacity: 1, x: 0, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25 }}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
                      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}
                    >
                      <span className="text-sm flex-shrink-0">{EVENT_ICONS[ev.event_type] || '📡'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="font-mono text-xs font-medium"
                            style={{ color: EVENT_COLORS[ev.event_type] || 'var(--text-secondary)' }}
                          >
                            {ev.event_type}
                          </span>
                          {ev.zone_id && (
                            <span
                              className="font-mono text-xs px-1.5 py-0.5 rounded"
                              style={{
                                background: `${ZONE_COLORS[ev.zone_id] || '#666'}20`,
                                color: ZONE_COLORS[ev.zone_id] || '#999',
                                fontSize: '9px',
                              }}
                            >
                              {ev.zone_id}
                            </span>
                          )}
                        </div>
                        <span className="font-mono" style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                          {ev.visitor_id} {ev.is_staff ? '(staff)' : ''}
                        </span>
                      </div>
                      <span className="font-mono flex-shrink-0" style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                        {new Date(ev.timestamp).toLocaleTimeString()}
                      </span>
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Anomalies */}
          <div className="glass-card-elevated p-5" style={{ minHeight: 200 }}>
            <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest mb-4" style={{ color: 'var(--text-secondary)' }}>
              <ShieldAlert className="w-4 h-4" style={{ color: 'var(--rose)' }} />
              Anomalies
              {anomalies.length > 0 && (
                <span
                  className="font-mono text-xs px-2 py-0.5 rounded-full"
                  style={{ background: 'var(--rose-glow)', color: 'var(--rose)', fontSize: '10px' }}
                >
                  {anomalies.length}
                </span>
              )}
            </h2>
            <div className="space-y-2 overflow-y-auto" style={{ maxHeight: 200 }}>
              <AnimatePresence>
                {anomalies.length === 0 ? (
                  <p className="font-mono text-xs text-center py-6 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    System optimal — No anomalies
                  </p>
                ) : (
                  anomalies.map((a) => {
                    const isCritical = a.severity === 'CRITICAL';
                    return (
                      <motion.div
                        key={a.id}
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex items-start gap-2.5 p-2.5 rounded-lg"
                        style={{
                          background: isCritical ? 'rgba(251,113,133,0.06)' : 'rgba(251,191,36,0.06)',
                          border: `1px solid ${isCritical ? 'rgba(251,113,133,0.2)' : 'rgba(251,191,36,0.2)'}`,
                        }}
                      >
                        <div
                          className="w-2 h-2 rounded-full mt-1 flex-shrink-0"
                          style={{
                            background: isCritical ? 'var(--rose)' : 'var(--amber)',
                            boxShadow: isCritical ? '0 0 8px var(--rose-glow)' : '0 0 8px var(--amber-glow)',
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span
                              className="font-mono text-xs font-bold uppercase"
                              style={{ color: isCritical ? 'var(--rose)' : 'var(--amber)' }}
                            >
                              {a.type}
                            </span>
                            <span className="font-mono" style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                              {a.time}
                            </span>
                          </div>
                          <p className="font-mono" style={{ fontSize: '10px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            {a.msg}
                          </p>
                        </div>
                      </motion.div>
                    );
                  })
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>

      {/* ── Dwell Time Breakdown ────────────────────── */}
      {Object.keys(metrics.avg_dwell_zone).length > 0 && (
        <div className="glass-card-elevated p-5">
          <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest mb-4" style={{ color: 'var(--text-secondary)' }}>
            <Clock className="w-4 h-4" style={{ color: 'var(--violet)' }} />
            Avg Dwell Time by Zone
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {(Object.entries(metrics.avg_dwell_zone) as [string, string][]).map(([zone, mins]) => {
              const minsNum = parseFloat(mins as string);
              const intensity = maxDwell > 0 ? minsNum / maxDwell : 0;
              const color = ZONE_COLORS[zone] || 'var(--emerald)';
              return (
                <div
                  key={zone}
                  className="rounded-lg p-3 text-center heat-zone"
                  style={{
                    background: `${color}${Math.floor(10 + intensity * 20).toString(16)}`,
                    border: `1px solid ${color}30`,
                  }}
                >
                  <p className="font-mono text-xs uppercase tracking-wider mb-1" style={{ color }}>
                    {zone}
                  </p>
                  <p className="font-mono text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {minsNum.toFixed(1)}
                    <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}> min</span>
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Sales Analytics (CSV Data) ────────────────────── */}
      {analytics.topBrands.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="glass-card-elevated p-5">
            <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest mb-5" style={{ color: 'var(--text-secondary)' }}>
              <TrendingUp className="w-4 h-4" style={{ color: 'var(--cyan)' }} />
              Top Brands (GMV)
            </h2>
            <div style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.topBrands} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                  <XAxis type="number" stroke="rgba(255,255,255,0.3)" fontSize={11} fontFamily="var(--font-mono)" tickFormatter={(v) => `₹${v}`} />
                  <YAxis dataKey="name" type="category" stroke="rgba(255,255,255,0.3)" fontSize={11} fontFamily="var(--font-mono)" width={100} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card-elevated)', border: '1px solid var(--border-accent)', borderRadius: '8px', color: 'var(--text-primary)' }} formatter={(value: number) => `₹${value.toLocaleString()}`} />
                  <Bar dataKey="value" fill="var(--cyan)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="glass-card-elevated p-5">
            <h2 className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest mb-5" style={{ color: 'var(--text-secondary)' }}>
              <ShoppingBag className="w-4 h-4" style={{ color: 'var(--emerald)' }} />
              Category Breakdown
            </h2>
            <div style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.categories}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                  <XAxis dataKey="name" stroke="rgba(255,255,255,0.3)" fontSize={11} fontFamily="var(--font-mono)" />
                  <YAxis stroke="rgba(255,255,255,0.3)" fontSize={11} fontFamily="var(--font-mono)" tickFormatter={(v) => `₹${v}`} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--bg-card-elevated)', border: '1px solid var(--border-accent)', borderRadius: '8px', color: 'var(--text-primary)' }} formatter={(value: number) => `₹${value.toLocaleString()}`} />
                  <Bar dataKey="value" fill="var(--emerald)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ─────────────────────────────────── */}
      <footer
        className="flex flex-wrap items-center justify-between gap-4 pt-4 mt-auto font-mono"
        style={{ borderTop: '1px solid var(--border-subtle)', fontSize: '10px', color: 'var(--text-muted)' }}
      >
        <div className="flex gap-4 md:gap-6 flex-wrap uppercase tracking-widest">
          <span>visitor_threads: {metrics.unique_visitors} active</span>
          <span>detection: yolov8 + bytetrack</span>
          <span>ws_clients: {wsConnected ? '1' : '0'}</span>
        </div>
        <div className="flex gap-4 md:gap-6 items-center uppercase tracking-widest">
          <span style={{ color: wsConnected ? 'var(--emerald)' : 'var(--rose)' }}>
            ● {wsConnected ? 'LIVE_SYNC' : 'OFFLINE'}
          </span>
          <span>© 2026 retail_intel</span>
        </div>
      </footer>
    </div>
  );
}

// ── Sub-Components ─────────────────────────────────────

function KPICard({
  icon,
  label,
  value,
  color,
  glowColor,
  alert = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: string;
  glowColor: string;
  alert?: boolean;
}) {
  return (
    <motion.div
      className="glass-card-elevated p-4 relative overflow-hidden"
      style={{ borderLeft: `3px solid ${color}` }}
      whileHover={{ scale: 1.02, transition: { duration: 0.2 } }}
    >
      {/* Ambient glow */}
      <div
        className="absolute -top-8 -right-8 w-24 h-24 rounded-full blur-2xl"
        style={{ background: glowColor, opacity: 0.4 }}
      />

      <div className="flex justify-between items-start mb-2 relative">
        <p className="font-mono text-xs uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </p>
        <div style={{ color, opacity: 0.6 }}>{icon}</div>
      </div>
      <motion.p
        key={String(value)}
        className="font-mono text-3xl font-semibold relative"
        style={{ color: 'var(--text-primary)' }}
        initial={{ scale: 1.1 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.2 }}
      >
        {value}
      </motion.p>
      {alert && (
        <div
          className="absolute bottom-0 left-0 right-0 h-0.5"
          style={{ background: `linear-gradient(90deg, ${color}, transparent)`, animation: 'shimmer 2s linear infinite', backgroundSize: '200% 100%' }}
        />
      )}
    </motion.div>
  );
}

function StatusChip({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1 mb-0.5" style={{ color: 'var(--text-muted)' }}>
        {icon}
        <span className="uppercase tracking-widest" style={{ fontSize: '9px' }}>{label}</span>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{value}</p>
    </div>
  );
}
