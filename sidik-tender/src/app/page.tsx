"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  UploadCloud,
  FileText,
  AlertTriangle,
  ShieldCheck,
  Download,
  Moon,
  Sun,
  Loader2,
  Fingerprint,
  TrendingUp,
  Users,
  BarChart2,
  CheckCircle2,
  XCircle,
  Info,
  AlertCircle,
  Package,
  Scale,
  BookOpen,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";

// ─── Env config ──────────────────────────────────────────────────────────────
const LANGFLOW_URL =
  process.env.NEXT_PUBLIC_LANGFLOW_URL || "http://localhost:7860";
const FLOW_ID =
  process.env.NEXT_PUBLIC_LANGFLOW_FLOW_ID ||
  "508c52b5-6691-43d8-b8e6-4df2f0368aa8";
const LANGFLOW_API_KEY = process.env.NEXT_PUBLIC_LANGFLOW_API_KEY || "";

// ─── Types matching build_report_json() output ───────────────────────────────
interface Temuan {
  no: number;
  kategori: string;
  deskripsi: string;
  regulasi: string;
  tingkat: "TINGGI" | "SEDANG" | "RENDAH";
}

interface Vendor {
  nama: string;
  bid_price: number;
  status: "MENCURIGAKAN" | "NORMAL";
  alasan?: string;
}

interface PaketBerisiko {
  package_id: string;
  package_name: string;
  fraud_risk_index: number;
  status_kesimpulan: "BAHAYA" | "WASPADA" | "AMAN";
}

interface AuditMetrics {
  // Core fields
  status_kesimpulan: string;
  skor_risiko_persentase: number;
  deviasi_hps_persentase: number;
  jumlah_vendor_terafiliasi: number;
  indikator_ditemukan: string[];
  // Extended fields from assemble_report
  temuan_utama?: Temuan[];
  daftar_vendor?: Vendor[];
  paket_dianalisis?: { id: string; nama: string };
  paket_berisiko_lain?: PaketBerisiko[];
  peringatan_regulasi?: string;
  catatan_metode?: string;
}

// ─── Graf afiliasi (dari run_fraud_analysis().graph) ─────────────────────────
interface GraphNode {
  id: string;
  company_name: string;
  npwp?: string;
}
interface GraphEdge {
  source: string;
  target: string;
  reasons: string[];
  weight: number;
}
interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─── Build graph from report_json vendors (no extra data needed) ─────────────
const REASON_KEY_MAP: Record<string, string> = {
  "direktur/pengurus sama": "shared_director",
  "npwp sama": "shared_npwp",
  "alamat kantor sama": "shared_address",
  "subnet ip pengiriman sama": "shared_ip_subnet",
};
const WEIGHT_MAP: Record<string, number> = {
  shared_npwp: 1.0,
  shared_director: 0.9,
  shared_address: 0.6,
  shared_ip_subnet: 0.3,
};

function buildGraphFromVendors(vendors: Vendor[]): GraphData {
  const nodes: GraphNode[] = vendors.map((v, i) => ({
    id: `V${i}`,
    company_name: v.nama,
  }));
  const nameToId = Object.fromEntries(vendors.map((v, i) => [v.nama.toLowerCase(), `V${i}`]));

  const edgeMap = new Map<string, Set<string>>();

  for (const v of vendors) {
    const srcId = nameToId[v.nama.toLowerCase()];
    if (!v.alasan || v.alasan.toLowerCase().startsWith("tidak ada relasi")) continue;

    // Each semicolon-separated segment: "reason1, reason2 dengan TargetName"
    const segments = v.alasan.split(";").map(s => s.trim());
    for (const seg of segments) {
      const match = seg.match(/^(.+?)\s+dengan\s+(.+)$/i);
      if (!match) continue;
      const reasonsRaw = match[1].split(",").map(r => r.trim().toLowerCase());
      const targetName = match[2].trim().toLowerCase();
      const tgtId = nameToId[targetName];
      if (!tgtId || tgtId === srcId) continue;

      const [a, b] = [srcId, tgtId].sort();
      const key = `${a}|${b}`;
      if (!edgeMap.has(key)) edgeMap.set(key, new Set());
      for (const r of reasonsRaw) {
        const mapped = REASON_KEY_MAP[r];
        if (mapped) edgeMap.get(key)!.add(mapped);
      }
    }
  }

  const edges: GraphEdge[] = [];
  for (const [key, reasons] of edgeMap.entries()) {
    const [source, target] = key.split("|");
    const reasonArr = Array.from(reasons);
    // noisy-OR weight
    let w = 1;
    for (const r of reasonArr) w *= 1 - (WEIGHT_MAP[r] ?? 0.3);
    edges.push({ source, target, reasons: reasonArr, weight: parseFloat((1 - w).toFixed(3)) });
  }

  return { nodes, edges };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function riskColor(score: number) {
  if (score >= 50) return { text: "text-red-500", bg: "bg-red-500", fill: "#ef4444" };
  if (score >= 30) return { text: "text-amber-500", bg: "bg-amber-500", fill: "#f59e0b" };
  return { text: "text-emerald-500", bg: "bg-emerald-500", fill: "#10b981" };
}

function statusStyle(label: string) {
  if (label === "BAHAYA")
    return "bg-red-500/10 text-red-500 border-red-500/30";
  if (label === "WASPADA")
    return "bg-amber-500/10 text-amber-500 border-amber-500/30";
  return "bg-emerald-500/10 text-emerald-500 border-emerald-500/30";
}

function statusIcon(label: string) {
  if (label === "BAHAYA") return <XCircle className="w-5 h-5 text-red-500" />;
  if (label === "WASPADA") return <AlertCircle className="w-5 h-5 text-amber-500" />;
  return <CheckCircle2 className="w-5 h-5 text-emerald-500" />;
}

function temuanColor(tingkat: string) {
  if (tingkat === "TINGGI") return "border-red-500 text-red-500 bg-red-500/10";
  if (tingkat === "SEDANG") return "border-amber-500 text-amber-500 bg-amber-500/10";
  return "border-slate-500 text-slate-400 bg-slate-500/10";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// Warna edge berdasarkan reasons
const REASON_COLOR: Record<string, string> = {
  shared_npwp: "#ef4444",        // merah — terkuat
  shared_director: "#f97316",    // oranye
  shared_address: "#eab308",     // kuning
  shared_ip_subnet: "#64748b",   // abu — terlemah
};
const REASON_LABEL: Record<string, string> = {
  shared_npwp: "NPWP sama",
  shared_director: "Direktur sama",
  shared_address: "Alamat sama",
  shared_ip_subnet: "Subnet IP sama",
};

/** Force-directed affiliation graph (pure SVG + requestAnimationFrame) */
function AffiliationGraph({
  graphData,
  highlightIds,
  dark,
}: {
  graphData: GraphData;
  highlightIds: Set<string>;   // node IDs of the top-package vendors
  dark: boolean;
}) {
  const W = 560, H = 340;
  const PADDING = 60;

  // ── positions state ──────────────────────────────────────────────────────
  type Pos = { x: number; y: number };
  const [positions, setPositions] = useState<Record<string, Pos>>(() => {
    // initial: place in a circle
    const n = graphData.nodes.length;
    const r = Math.min(W, H) / 2 - PADDING;
    const cx = W / 2, cy = H / 2;
    return Object.fromEntries(
      graphData.nodes.map((node, i) => {
        const angle = (2 * Math.PI * i) / n - Math.PI / 2;
        return [node.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }];
      })
    );
  });

  const [hovered, setHovered] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragOffset = useRef<Pos>({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const posRef = useRef(positions);
  posRef.current = positions;
  const rafRef = useRef<number>(0);

  // ── Force simulation ──────────────────────────────────────────────────────
  const runForce = useCallback(() => {
    const nodes = graphData.nodes;
    const edges = graphData.edges;
    if (nodes.length === 0) return;

    const pos = { ...posRef.current };
    const vel: Record<string, Pos> = Object.fromEntries(nodes.map(n => [n.id, { x: 0, y: 0 }]));

    // repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].id, b = nodes[j].id;
        const dx = pos[b].x - pos[a].x;
        const dy = pos[b].y - pos[a].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = 6000 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        vel[b].x += fx; vel[b].y += fy;
        vel[a].x -= fx; vel[a].y -= fy;
      }
    }

    // attraction along edges
    for (const e of edges) {
      const a = e.source, b = e.target;
      if (!pos[a] || !pos[b]) continue;
      const dx = pos[b].x - pos[a].x;
      const dy = pos[b].y - pos[a].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ideal = 120;
      const force = (dist - ideal) * 0.04 * (e.weight + 0.3);
      vel[a].x += (dx / dist) * force;
      vel[a].y += (dy / dist) * force;
      vel[b].x -= (dx / dist) * force;
      vel[b].y -= (dy / dist) * force;
    }

    // gravity toward center
    const cx = W / 2, cy = H / 2;
    for (const n of nodes) {
      vel[n.id].x += (cx - pos[n.id].x) * 0.01;
      vel[n.id].y += (cy - pos[n.id].y) * 0.01;
    }

    // apply — skip dragged node
    const next: Record<string, Pos> = {};
    for (const n of nodes) {
      if (n.id === dragging) { next[n.id] = pos[n.id]; continue; }
      const nx = Math.max(PADDING, Math.min(W - PADDING, pos[n.id].x + vel[n.id].x * 0.15));
      const ny = Math.max(PADDING, Math.min(H - PADDING, pos[n.id].y + vel[n.id].y * 0.15));
      next[n.id] = { x: nx, y: ny };
    }
    setPositions(next);
    rafRef.current = requestAnimationFrame(runForce);
  }, [graphData, dragging]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(runForce);
    // stop after 3 s (settled)
    const stop = setTimeout(() => cancelAnimationFrame(rafRef.current), 3000);
    return () => { cancelAnimationFrame(rafRef.current); clearTimeout(stop); };
  }, [runForce]);

  // ── Drag handlers ──────────────────────────────────────────────────────────
  const getSVGPoint = (e: React.MouseEvent | React.TouchEvent): Pos => {
    const rect = svgRef.current!.getBoundingClientRect();
    const client = "touches" in e ? e.touches[0] : e;
    return {
      x: ((client.clientX - rect.left) / rect.width) * W,
      y: ((client.clientY - rect.top) / rect.height) * H,
    };
  };

  const onMouseDown = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const pt = getSVGPoint(e);
    dragOffset.current = { x: pt.x - posRef.current[id].x, y: pt.y - posRef.current[id].y };
    setDragging(id);
    cancelAnimationFrame(rafRef.current);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const pt = getSVGPoint(e);
    setPositions(prev => ({
      ...prev,
      [dragging]: {
        x: Math.max(PADDING, Math.min(W - PADDING, pt.x - dragOffset.current.x)),
        y: Math.max(PADDING, Math.min(H - PADDING, pt.y - dragOffset.current.y)),
      },
    }));
  };

  const onMouseUp = () => {
    if (!dragging) return;
    setDragging(null);
    rafRef.current = requestAnimationFrame(runForce);
    const stop = setTimeout(() => cancelAnimationFrame(rafRef.current), 1500);
    return () => clearTimeout(stop);
  };

  // ── Legend for edge types present in this graph ───────────────────────────
  const presentReasons = Array.from(new Set(graphData.edges.flatMap(e => e.reasons)));

  if (graphData.nodes.length === 0) return null;

  return (
    <div className={`rounded-2xl border overflow-hidden ${dark ? "border-slate-800" : "border-slate-200"}`}>
      {/* Header */}
      <div className={`px-5 py-3 flex items-center gap-2 ${dark ? "bg-slate-900/60" : "bg-slate-50"}`}>
        <svg className="w-4 h-4 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/>
          <line x1="9" y1="6" x2="15" y2="6"/><line x1="6" y1="9" x2="12" y2="15"/>
          <line x1="18" y1="9" x2="12" y2="15"/>
        </svg>
        <span className="text-sm font-bold uppercase tracking-wide">Graf Afiliasi Vendor</span>
        <span className={`ml-2 text-xs ${dark ? "text-slate-500" : "text-slate-400"}`}>
          {graphData.nodes.length} vendor · {graphData.edges.length} relasi
        </span>
        <span className={`ml-auto text-[10px] italic ${dark ? "text-slate-600" : "text-slate-400"}`}>
          drag node untuk mengatur posisi
        </span>
      </div>

      {/* SVG canvas */}
      <div className={`${dark ? "bg-[#080e1a]" : "bg-slate-50/70"}`}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full select-none"
          style={{ cursor: dragging ? "grabbing" : "default" }}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        >
          <defs>
            {/* arrow markers per color */}
            {Object.entries(REASON_COLOR).map(([r, col]) => (
              <marker
                key={r}
                id={`arrow-${r}`}
                markerWidth="8" markerHeight="8"
                refX="12" refY="3"
                orient="auto"
              >
                <path d="M0,0 L0,6 L8,3 z" fill={col} opacity="0.7" />
              </marker>
            ))}
          </defs>

          {/* Edges */}
          {graphData.edges.map((e, i) => {
            const a = positions[e.source], b = positions[e.target];
            if (!a || !b) return null;
            const topReason = e.reasons.sort(
              (x, y) =>
                ["shared_npwp","shared_director","shared_address","shared_ip_subnet"].indexOf(x) -
                ["shared_npwp","shared_director","shared_address","shared_ip_subnet"].indexOf(y)
            )[0];
            const color = REASON_COLOR[topReason] ?? "#64748b";
            const isHighlighted =
              (highlightIds.has(e.source) && highlightIds.has(e.target)) ||
              hovered === e.source || hovered === e.target;
            const opacity = isHighlighted ? 1 : 0.25;
            const strokeW = isHighlighted ? Math.max(1.5, e.weight * 3) : 1;

            // curved line
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2 - 20;

            return (
              <g key={i}>
                <path
                  d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeW}
                  strokeOpacity={opacity}
                  strokeDasharray={e.weight < 0.5 ? "4 3" : undefined}
                />
                {/* midpoint label on hover */}
                {isHighlighted && (
                  <text
                    x={(a.x + b.x) / 2}
                    y={(a.y + b.y) / 2 - 24}
                    textAnchor="middle"
                    fontSize="9"
                    fill={color}
                    opacity="0.9"
                  >
                    {e.reasons.map(r => REASON_LABEL[r] ?? r).join(" · ")}
                  </text>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {graphData.nodes.map(node => {
            const p = positions[node.id];
            if (!p) return null;
            const isHighlight = highlightIds.has(node.id);
            const isHovered = hovered === node.id;
            const r = isHighlight ? 18 : 13;
            const nodeColor = isHighlight
              ? (hovered === node.id ? "#ef4444" : "#f97316")
              : dark ? "#334155" : "#94a3b8";
            const textColor = isHighlight
              ? "#fff"
              : dark ? "#94a3b8" : "#475569";
            const strokeColor = isHighlight
              ? (dark ? "#fbbf24" : "#f59e0b")
              : dark ? "#475569" : "#cbd5e1";

            return (
              <g
                key={node.id}
                style={{ cursor: "grab" }}
                onMouseDown={ev => onMouseDown(ev, node.id)}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
              >
                {/* glow for highlighted */}
                {isHighlight && (
                  <circle
                    cx={p.x} cy={p.y} r={r + 5}
                    fill={isHovered ? "#ef444430" : "#f9731620"}
                  />
                )}
                <circle
                  cx={p.x} cy={p.y} r={r}
                  fill={nodeColor}
                  stroke={strokeColor}
                  strokeWidth={isHighlight ? 2 : 1}
                />
                {/* initials */}
                <text
                  x={p.x} y={p.y + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={isHighlight ? "9" : "8"}
                  fontWeight="bold"
                  fill={textColor}
                >
                  {node.company_name
                    .replace(/^(PT|CV|UD)\.?\s*/i, "")
                    .split(/\s+/)
                    .slice(0, 2)
                    .map(w => w[0]?.toUpperCase() ?? "")
                    .join("")}
                </text>
                {/* name label */}
                {(isHighlight || isHovered) && (
                  <text
                    x={p.x}
                    y={p.y + r + 11}
                    textAnchor="middle"
                    fontSize="9"
                    fontWeight={isHighlight ? "bold" : "normal"}
                    fill={isHighlight ? (dark ? "#fbbf24" : "#f97316") : (dark ? "#94a3b8" : "#64748b")}
                  >
                    {node.company_name.length > 22
                      ? node.company_name.slice(0, 20) + "…"
                      : node.company_name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Legend */}
      {presentReasons.length > 0 && (
        <div className={`px-5 py-3 border-t flex flex-wrap gap-4 ${dark ? "border-slate-800 bg-slate-900/30" : "border-slate-100 bg-white"}`}>
          <span className={`text-[10px] font-bold uppercase tracking-widest self-center mr-1 ${dark ? "text-slate-500" : "text-slate-400"}`}>
            Jenis Relasi:
          </span>
          {presentReasons
            .sort((a, b) =>
              ["shared_npwp","shared_director","shared_address","shared_ip_subnet"].indexOf(a) -
              ["shared_npwp","shared_director","shared_address","shared_ip_subnet"].indexOf(b)
            )
            .map(r => (
              <span key={r} className="flex items-center gap-1.5 text-[10px] font-semibold" style={{ color: REASON_COLOR[r] ?? "#64748b" }}>
                <span className="w-5 h-0.5 rounded-full inline-block" style={{ background: REASON_COLOR[r] ?? "#64748b" }} />
                {REASON_LABEL[r] ?? r}
              </span>
            ))}
          <span className={`ml-auto text-[10px] italic ${dark ? "text-slate-600" : "text-slate-400"}`}>
            ● oranye = peserta paket ini &nbsp; ● abu = peserta paket lain
          </span>
        </div>
      )}
    </div>
  );
}

/** Circular radial gauge for risk score */
function RiskGauge({ score, dark }: { score: number; dark: boolean }) {
  const color = riskColor(score);
  const data = [{ value: score, fill: color.fill }];
  const label = score >= 50 ? "BAHAYA" : score >= 30 ? "WASPADA" : "AMAN";
  return (
    <div className={`flex flex-col items-center justify-center p-5 rounded-2xl border ${dark ? "bg-[#0B1120] border-slate-800" : "bg-slate-50 border-slate-200"}`}>
      <p className={`text-xs font-semibold uppercase tracking-widest mb-2 ${dark ? "text-slate-400" : "text-slate-500"}`}>
        Fraud Risk Score
      </p>
      <div className="relative w-32 h-32">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            innerRadius="70%"
            outerRadius="100%"
            data={data}
            startAngle={220}
            endAngle={-40}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
            <RadialBar
              background={{ fill: dark ? "#1e293b" : "#e2e8f0" }}
              dataKey="value"
              angleAxisId={0}
              cornerRadius={6}
            />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-3xl font-black ${color.text}`}>{score}%</span>
          <span className={`text-[10px] font-bold tracking-widest mt-0.5 ${color.text}`}>{label}</span>
        </div>
      </div>
    </div>
  );
}

/** 5-component horizontal bar chart matching fraud_detection.py weights */
function ComponentScoresChart({ metrics, dark }: { metrics: AuditMetrics; dark: boolean }) {
  // We derive approximate component scores from what we have.
  // The full breakdown lives in the fraud_data, but report_json only exposes aggregated fields.
  // We reconstruct a visual representation from the indikator_ditemukan signals.
  const indicators = new Set(metrics.indikator_ditemukan || []);
  const hasRelasi = indicators.has("direktur/pengurus sama") || indicators.has("NPWP sama") ||
                    indicators.has("alamat kantor sama") || indicators.has("subnet IP pengiriman sama");
  const hasCobid = indicators.has("rotasi pemenang antar paket");
  const hasSatu = indicators.has("tender satu penawar");

  const data = [
    {
      name: "Skor Risiko",
      value: metrics.skor_risiko_persentase,
      color: riskColor(metrics.skor_risiko_persentase).fill,
    },
    {
      name: "Margin HPS",
      value: Math.min(metrics.deviasi_hps_persentase, 100),
      color: "#3b82f6",
    },
    {
      name: "Vendor Afiliasi",
      value: Math.min(metrics.jumlah_vendor_terafiliasi * 15, 100),
      color: "#8b5cf6",
    },
    {
      name: "Relasi Graf",
      value: hasRelasi ? 80 : 0,
      color: "#ef4444",
    },
    {
      name: "Co-bidding",
      value: hasCobid ? 100 : hasSatu ? 50 : 0,
      color: "#f59e0b",
    },
  ];

  return (
    <div className={`p-5 rounded-2xl border ${dark ? "bg-[#0B1120] border-slate-800" : "bg-slate-50 border-slate-200"}`}>
      <p className={`text-xs font-semibold uppercase tracking-widest mb-4 ${dark ? "text-slate-400" : "text-slate-500"}`}>
        Komponen Sinyal Risiko
      </p>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={data} layout="vertical" margin={{ left: 4, right: 28, top: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={dark ? "#1e293b" : "#e2e8f0"} />
          <XAxis
            type="number"
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: dark ? "#64748b" : "#94a3b8" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 11, fill: dark ? "#94a3b8" : "#64748b" }}
            width={90}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" }}
            contentStyle={{
              background: dark ? "#0f172a" : "#fff",
              border: `1px solid ${dark ? "#1e293b" : "#e5e7eb"}`,
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(val) => [`${val}%`, ""]}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={16}>
            {data.map((entry, idx) => (
              <Cell key={idx} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Temuan utama table */
function FindingsTable({ temuan, dark }: { temuan: Temuan[]; dark: boolean }) {
  if (!temuan || temuan.length === 0) return null;
  return (
    <div className={`rounded-2xl border overflow-hidden ${dark ? "border-slate-800" : "border-slate-200"}`}>
      <div className={`px-5 py-3 flex items-center gap-2 ${dark ? "bg-slate-900/60" : "bg-slate-50"}`}>
        <AlertTriangle className="w-4 h-4 text-amber-500" />
        <span className="text-sm font-bold uppercase tracking-wide">Temuan Utama</span>
        <span className={`ml-auto text-xs font-bold px-2 py-0.5 rounded-full ${dark ? "bg-slate-700 text-slate-300" : "bg-slate-200 text-slate-600"}`}>
          {temuan.length} temuan
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={`border-b ${dark ? "border-slate-800 text-slate-400" : "border-slate-200 text-slate-500"}`}>
              <th className="px-4 py-2 text-left font-semibold w-8">#</th>
              <th className="px-4 py-2 text-left font-semibold">Deskripsi Temuan</th>
              <th className="px-4 py-2 text-left font-semibold hidden sm:table-cell">Regulasi</th>
              <th className="px-4 py-2 text-center font-semibold">Tingkat</th>
            </tr>
          </thead>
          <tbody>
            {temuan.map((t) => (
              <tr
                key={t.no}
                className={`border-b last:border-0 ${dark ? "border-slate-800 hover:bg-slate-900/40" : "border-slate-100 hover:bg-slate-50"}`}
              >
                <td className={`px-4 py-3 font-mono font-bold ${dark ? "text-slate-500" : "text-slate-400"}`}>{t.no}</td>
                <td className={`px-4 py-3 ${dark ? "text-slate-200" : "text-slate-700"}`}>
                  {t.deskripsi}
                  {t.kategori && (
                    <span className={`ml-2 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${dark ? "bg-slate-700 text-slate-400" : "bg-slate-100 text-slate-500"}`}>
                      {t.kategori}
                    </span>
                  )}
                </td>
                <td className={`px-4 py-3 text-xs font-mono hidden sm:table-cell ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  {t.regulasi || <span className="italic opacity-50">—</span>}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2.5 py-0.5 text-xs font-bold rounded-full border ${temuanColor(t.tingkat)}`}>
                    {t.tingkat}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Vendor list table */
function VendorTable({ vendors, dark }: { vendors: Vendor[]; dark: boolean }) {
  if (!vendors || vendors.length === 0) return null;
  const suspicious = vendors.filter((v) => v.status === "MENCURIGAKAN").length;
  return (
    <div className={`rounded-2xl border overflow-hidden ${dark ? "border-slate-800" : "border-slate-200"}`}>
      <div className={`px-5 py-3 flex items-center gap-2 ${dark ? "bg-slate-900/60" : "bg-slate-50"}`}>
        <Users className="w-4 h-4 text-blue-500" />
        <span className="text-sm font-bold uppercase tracking-wide">Daftar Vendor Peserta</span>
        {suspicious > 0 && (
          <span className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/10 text-red-500 border border-red-500/20">
            {suspicious} mencurigakan
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={`border-b ${dark ? "border-slate-800 text-slate-400" : "border-slate-200 text-slate-500"}`}>
              <th className="px-4 py-2 text-left font-semibold">Nama Vendor</th>
              <th className="px-4 py-2 text-right font-semibold">Harga Penawaran (Rp)</th>
              <th className="px-4 py-2 text-center font-semibold">Status</th>
              <th className="px-4 py-2 text-left font-semibold hidden md:table-cell">Alasan Indikasi</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((v, idx) => (
              <tr
                key={idx}
                className={`border-b last:border-0 ${dark ? "border-slate-800 hover:bg-slate-900/40" : "border-slate-100 hover:bg-slate-50"}`}
              >
                <td className={`px-4 py-3 font-medium ${dark ? "text-slate-200" : "text-slate-800"}`}>{v.nama}</td>
                <td className={`px-4 py-3 text-right font-mono text-sm ${dark ? "text-slate-300" : "text-slate-600"}`}>
                  {v.bid_price.toLocaleString("id-ID")}
                </td>
                <td className="px-4 py-3 text-center">
                  <span
                    className={`px-2.5 py-0.5 text-xs font-bold rounded-full border ${
                      v.status === "MENCURIGAKAN"
                        ? "bg-red-500/10 text-red-500 border-red-500/30"
                        : "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
                    }`}
                  >
                    {v.status}
                  </span>
                </td>
                <td className={`px-4 py-3 text-xs hidden md:table-cell ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  {v.alasan || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Paket-paket lain yang juga berisiko */
function OtherRiskyPackages({ paket, dark }: { paket: PaketBerisiko[]; dark: boolean }) {
  if (!paket || paket.length === 0) return null;
  return (
    <div className={`rounded-2xl border overflow-hidden ${dark ? "border-slate-800" : "border-slate-200"}`}>
      <div className={`px-5 py-3 flex items-center gap-2 ${dark ? "bg-slate-900/60" : "bg-slate-50"}`}>
        <Package className="w-4 h-4 text-orange-500" />
        <span className="text-sm font-bold uppercase tracking-wide">Paket Lain yang Terindikasi</span>
        <span className={`ml-auto text-xs font-bold px-2 py-0.5 rounded-full ${dark ? "bg-slate-700 text-slate-300" : "bg-slate-200 text-slate-600"}`}>
          {paket.length} paket
        </span>
      </div>
      <div className="divide-y divide-slate-800/50">
        {paket.map((p, idx) => {
          const color = riskColor(p.fraud_risk_index);
          return (
            <div
              key={idx}
              className={`px-5 py-3 flex items-center gap-4 ${dark ? "hover:bg-slate-900/40" : "hover:bg-slate-50"}`}
            >
              <div className={`w-2 h-2 rounded-full ${color.bg} shrink-0`} />
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold truncate ${dark ? "text-slate-200" : "text-slate-700"}`}>
                  {p.package_name}
                </p>
                <p className={`text-xs font-mono ${dark ? "text-slate-500" : "text-slate-400"}`}>{p.package_id}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-sm font-black ${color.text}`}>{p.fraud_risk_index}%</span>
                <span className={`px-2 py-0.5 text-xs font-bold rounded-full border ${statusStyle(p.status_kesimpulan)}`}>
                  {p.status_kesimpulan}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function SidikTenderApp() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<AuditMetrics | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);

  const dark = theme === "dark";
  const toggleTheme = () => setTheme(dark ? "light" : "dark");

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setReport(null);
    setMetrics(null);
    setGraphData(null);
    if (!e.target.files?.[0]) return;
    const selectedFile = e.target.files[0];

    if (!selectedFile.name.endsWith(".csv")) {
      setError("Format tidak didukung. Harap unggah berkas CSV.");
      setFile(null);
      return;
    }

    const text = await selectedFile.text();
    const firstLine = text.split("\n")[0].toLowerCase();
    const required = ["package_id", "package_name", "hps", "company_id", "bid_price"];
    const missing = required.filter((col) => !firstLine.includes(col));

    if (missing.length > 0) {
      setError(`Dataset ditolak! Kolom wajib tidak ditemukan: ${missing.join(", ")}.`);
      setFile(null);
      return;
    }

    setFile(selectedFile);
  };

  const runAudit = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);

    try {
      const csvString = await file.text();
      const payload = {
        input_value: "Jalankan audit forensik pengadaan",
        tweaks: {
          // FraudPerceptionComponent node ID from the flow
          "FraudPerceptionComponent-FAzvq": { raw_csv_content: csvString },
          // Also try common fallback IDs in case node ID differs
          "FraudPerceptionComponent-*": { raw_csv_content: csvString },
        },
      };

      const response = await fetch(`${LANGFLOW_URL}/api/v1/run/${FLOW_ID}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(LANGFLOW_API_KEY ? { "x-api-key": LANGFLOW_API_KEY } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Langflow Error (${response.status}): ${errText || response.statusText}`);
      }

      const data = await response.json();
      let rawOutput = "";

      const outputs = data.outputs?.[0]?.outputs?.[0];
      if (outputs?.results?.message?.text) rawOutput = outputs.results.message.text;
      else if (outputs?.messages?.length > 0) rawOutput = outputs.messages[outputs.messages.length - 1].message;
      else if (outputs?.results?.text) rawOutput = outputs.results.text;
      else rawOutput = JSON.stringify(data, null, 2);

      // assemble_report() outputs: ```json {...report_json} ``` then markdown narrative
      const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
      const match = rawOutput.match(jsonRegex);

      if (match?.[1]) {
        try {
          const parsed = JSON.parse(match[1]) as AuditMetrics;
          setMetrics(parsed);
          // Build graf langsung dari daftar_vendor — tidak butuh data eksternal
          if (parsed.daftar_vendor && parsed.daftar_vendor.length > 0) {
            setGraphData(buildGraphFromVendors(parsed.daftar_vendor));
          }
          setReport(rawOutput.replace(jsonRegex, "").trim());
        } catch {
          setMetrics(null);
          setGraphData(null);
          setReport(rawOutput);
        }
      } else {
        setMetrics(null);
        setGraphData(null);
        setReport(rawOutput);
      }
    } catch (err: unknown) {
      setError((err as Error).message || "Gagal memproses data melalui engine Langflow.");
    } finally {
      setLoading(false);
    }
  };

  const downloadReport = () => {
    if (!report && !metrics) return;
    const content = metrics
      ? "```json\n" + JSON.stringify(metrics, null, 2) + "\n```\n\n" + (report || "")
      : report || "";
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `LIAF_SidikTender_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className={`min-h-screen transition-colors duration-300 ${
        dark ? "bg-[#0B1120] text-slate-200" : "bg-slate-50 text-slate-800"
      }`}
    >
      {/* ── Nav ── */}
      <nav
        className={`border-b px-6 py-4 flex justify-between items-center sticky top-0 z-20 backdrop-blur-md ${
          dark ? "border-slate-800 bg-[#0F172A]/90" : "border-slate-200 bg-white/90"
        }`}
      >
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-8 h-8 text-blue-500" />
          <div>
            <h1 className="text-xl font-black tracking-tight">SIDIK TENDER</h1>
          </div>
        </div>
        <button
          onClick={toggleTheme}
          className={`p-2 rounded-full transition-colors ${
            dark ? "bg-slate-800 hover:bg-slate-700" : "bg-slate-100 hover:bg-slate-200"
          }`}
        >
          {dark ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-slate-600" />}
        </button>
      </nav>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-8">
        {/* ── Hero ── */}
        <div className="text-center space-y-3">
          <h2
            className={`text-3xl sm:text-4xl font-black leading-tight ${
              dark ? "text-white" : "text-slate-900"
            }`}
          >
            Sistem Deteksi Integritas Pengadaan
          </h2>
          <p
            className={`max-w-2xl mx-auto text-sm sm:text-base ${
              dark ? "text-slate-400" : "text-slate-500"
            }`}
          >
            Unggah rekaman data penawaran peserta LPSE. Engine AI mendeteksi anomali harga,
            memetakan graf afiliasi kartel, dan mencocokkannya dengan regulasi.
          </p>
        </div>

        {/* ── Upload zone ── */}
        <div
          className={`relative border-2 border-dashed rounded-2xl p-10 text-center transition-all ${
            file
              ? "border-blue-500 bg-blue-500/5"
              : dark
              ? "border-slate-700 hover:border-slate-500 bg-slate-900/50"
              : "border-slate-300 hover:border-slate-400 bg-white"
          }`}
        >
          <input
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <div className="flex flex-col items-center justify-center gap-3 pointer-events-none">
            {file ? (
              <FileText className="w-12 h-12 text-blue-500" />
            ) : (
              <UploadCloud className={`w-12 h-12 ${dark ? "text-slate-500" : "text-slate-400"}`} />
            )}
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {file ? (
                  <span className="text-blue-500 font-bold">{file.name}</span>
                ) : (
                  "Tarik & Lepas dataset CSV di sini, atau klik untuk menelusuri"
                )}
              </p>
              {!file && (
                <p className={`text-xs ${dark ? "text-slate-500" : "text-slate-400"}`}>
                  Wajib memiliki kolom: package_id, package_name, hps, company_id, bid_price
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div
            className={`flex items-start gap-3 p-4 rounded-xl border ${
              dark
                ? "bg-red-950/30 border-red-900/50 text-red-400"
                : "bg-red-50 border-red-200 text-red-600"
            }`}
          >
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {/* ── CTA button ── */}
        <button
          onClick={runAudit}
          disabled={!file || loading}
          className={`w-full py-4 rounded-xl font-bold text-white flex items-center justify-center gap-2 transition-all text-base ${
            !file || loading
              ? "bg-slate-700 cursor-not-allowed opacity-50"
              : "bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-900/30"
          }`}
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" /> Menganalisis Anomali &amp; Graf Relasi...
            </>
          ) : (
            <>
              <ShieldCheck className="w-5 h-5" /> Jalankan Audit Forensik
            </>
          )}
        </button>

        {/* ── REPORT PANEL ── */}
        {(report || metrics) && (
          <div
            className={`rounded-2xl border overflow-hidden shadow-2xl ${
              dark ? "bg-[#0F172A] border-slate-800" : "bg-white border-slate-200"
            }`}
          >
            {/* Panel header */}
            <div
              className={`px-6 py-4 border-b flex flex-wrap justify-between items-center gap-3 ${
                dark ? "border-slate-800 bg-[#0B1120]" : "border-slate-100 bg-slate-50"
              }`}
            >
              <h3 className="font-black flex items-center gap-2 uppercase tracking-widest text-sm">
                <ShieldCheck className="w-5 h-5 text-blue-500" />
                Laporan Investigasi Awal Fraud (LIAF)
              </h3>
              <button
                onClick={downloadReport}
                className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg bg-blue-600/10 text-blue-500 hover:bg-blue-600/20 transition-colors"
              >
                <Download className="w-4 h-4" /> Unduh Laporan
              </button>
            </div>

            <div className="p-6 space-y-8">
              {metrics && (
                <>
                  {/* ── Paket info banner ── */}
                  {metrics.paket_dianalisis && (
                    <div
                      className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${
                        dark
                          ? "bg-slate-900/50 border-slate-700 text-slate-300"
                          : "bg-slate-50 border-slate-200 text-slate-600"
                      }`}
                    >
                      <Package className="w-4 h-4 mt-0.5 shrink-0 text-blue-400" />
                      <div>
                        <span className="text-xs font-bold uppercase tracking-widest opacity-60">
                          Paket Dianalisis
                        </span>
                        <p className="text-sm font-semibold mt-0.5">{metrics.paket_dianalisis.nama}</p>
                        <p className={`text-xs font-mono mt-0.5 ${dark ? "text-slate-500" : "text-slate-400"}`}>
                          {metrics.paket_dianalisis.id}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* ── Status badge ── */}
                  <div
                    className={`flex flex-wrap items-center gap-3 p-4 rounded-2xl border ${
                      dark ? "border-slate-800 bg-slate-900/40" : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    {statusIcon(metrics.status_kesimpulan)}
                    <span
                      className={`text-xs font-bold uppercase tracking-widest ${
                        dark ? "text-slate-400" : "text-slate-500"
                      }`}
                    >
                      Status Kesimpulan
                    </span>
                    <span
                      className={`ml-auto px-5 py-1.5 rounded-full text-sm font-black border ${statusStyle(
                        metrics.status_kesimpulan
                      )}`}
                    >
                      {metrics.status_kesimpulan}
                    </span>
                  </div>

                  {/* ── Key metrics row: gauge + component bar chart + stat cards ── */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {/* Radial gauge */}
                    <RiskGauge score={metrics.skor_risiko_persentase} dark={dark} />

                    {/* Component scores bar chart */}
                    <ComponentScoresChart metrics={metrics} dark={dark} />

                    {/* Stat cards stacked */}
                    <div className="flex flex-col gap-3">
                      <div
                        className={`flex-1 p-4 rounded-2xl border flex items-center gap-4 ${
                          dark ? "bg-[#0B1120] border-slate-800" : "bg-slate-50 border-slate-200"
                        }`}
                      >
                        <div className="p-2 rounded-xl bg-blue-500/10">
                          <TrendingUp className="w-5 h-5 text-blue-500" />
                        </div>
                        <div>
                          <p className={`text-xs font-semibold ${dark ? "text-slate-400" : "text-slate-500"}`}>
                            Rata-rata Penawaran / HPS
                          </p>
                          <p className="text-2xl font-black text-blue-500">
                            {metrics.deviasi_hps_persentase}%
                          </p>
                        </div>
                      </div>
                      <div
                        className={`flex-1 p-4 rounded-2xl border flex items-center gap-4 ${
                          dark ? "bg-[#0B1120] border-slate-800" : "bg-slate-50 border-slate-200"
                        }`}
                      >
                        <div className="p-2 rounded-xl bg-violet-500/10">
                          <Users className="w-5 h-5 text-violet-500" />
                        </div>
                        <div>
                          <p className={`text-xs font-semibold ${dark ? "text-slate-400" : "text-slate-500"}`}>
                            Vendor Terafiliasi
                          </p>
                          <p className="text-2xl font-black text-violet-500">
                            {metrics.jumlah_vendor_terafiliasi} Entitas
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ── Risk score progress bar ── */}
                  <div
                    className={`p-5 rounded-2xl border ${
                      dark ? "bg-slate-900/40 border-slate-800" : "bg-slate-50 border-slate-200"
                    }`}
                  >
                    {/* Header row: label + big score value */}
                    <div className="flex justify-between items-baseline mb-3">
                      <span
                        className={`text-xs font-bold uppercase tracking-widest flex items-center gap-1 ${
                          dark ? "text-slate-400" : "text-slate-500"
                        }`}
                      >
                        <BarChart2 className="w-3.5 h-3.5" />
                        Indeks Risiko Kumulatif
                      </span>
                      <div className="flex items-baseline gap-2">
                        <span className={`text-3xl font-black leading-none ${riskColor(metrics.skor_risiko_persentase).text}`}>
                          {metrics.skor_risiko_persentase}%
                        </span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                          metrics.skor_risiko_persentase < 30
                            ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
                            : metrics.skor_risiko_persentase < 50
                            ? "bg-amber-500/10 text-amber-500 border-amber-500/30"
                            : "bg-red-500/10 text-red-500 border-red-500/30"
                        }`}>
                          {metrics.skor_risiko_persentase < 30 ? "AMAN" : metrics.skor_risiko_persentase < 50 ? "WASPADA" : "BAHAYA"}
                        </span>
                      </div>
                    </div>

                    {/* Track + bar (overflow visible so markers can poke out) */}
                    <div className="relative pt-1 pb-6">
                      {/* Track background */}
                      <div className={`w-full h-4 rounded-full ${dark ? "bg-slate-800" : "bg-slate-200"}`} />

                      {/* Filled bar */}
                      <div
                        className={`absolute top-1 left-0 h-4 rounded-full transition-all duration-700 ${
                          riskColor(metrics.skor_risiko_persentase).bg
                        }`}
                        style={{ width: `${metrics.skor_risiko_persentase}%` }}
                      />

                      {/* WASPADA threshold marker at 30% */}
                      <div className="absolute top-0 bottom-0" style={{ left: "30%" }}>
                        <div className="absolute top-1 w-0.5 h-4 bg-amber-400 rounded-full" />
                        <div
                          className="absolute top-6 text-[10px] font-bold text-amber-400 whitespace-nowrap"
                          style={{ transform: "translateX(-50%)" }}
                        >
                          ⚠ 30% WASPADA
                        </div>
                      </div>

                      {/* BAHAYA threshold marker at 50% */}
                      <div className="absolute top-0 bottom-0" style={{ left: "50%" }}>
                        <div className="absolute top-1 w-0.5 h-4 bg-red-500 rounded-full" />
                        <div
                          className="absolute top-6 text-[10px] font-bold text-red-500 whitespace-nowrap"
                          style={{ transform: "translateX(-50%)" }}
                        >
                          ✕ 50% BAHAYA
                        </div>
                      </div>

                      {/* Score pointer */}
                      {metrics.skor_risiko_persentase > 0 && (
                        <div
                          className="absolute top-0 bottom-0"
                          style={{ left: `${Math.min(metrics.skor_risiko_persentase, 98)}%` }}
                        >
                          <div
                            className={`absolute -top-0.5 w-1.5 h-5 rounded-full border-2 ${
                              dark ? "border-slate-900" : "border-white"
                            } ${riskColor(metrics.skor_risiko_persentase).bg}`}
                            style={{ transform: "translateX(-50%)" }}
                          />
                        </div>
                      )}
                    </div>

                    {/* Axis labels: 0 — 100 */}
                    <div className={`flex justify-between text-[10px] mt-0.5 ${dark ? "text-slate-600" : "text-slate-400"}`}>
                      <span>0%</span>
                      <span>50%</span>
                      <span>100%</span>
                    </div>
                  </div>

                  {/* ── Anomaly indicators ── */}
                  <div
                    className={`p-5 rounded-2xl border-l-4 ${
                      dark
                        ? "bg-blue-950/20 border-blue-500 border border-blue-900/30"
                        : "bg-blue-50 border-blue-500 border border-blue-200"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-4">
                      <Fingerprint className="w-5 h-5 text-blue-500" />
                      <p className="text-sm font-black tracking-widest uppercase">Pemicu Anomali Terdeteksi</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {metrics.indikator_ditemukan?.length > 0 ? (
                        metrics.indikator_ditemukan.map((item, idx) => (
                          <span
                            key={idx}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-full border ${
                              dark
                                ? "bg-blue-900/40 text-blue-300 border-blue-700"
                                : "bg-blue-100 text-blue-700 border-blue-200"
                            }`}
                          >
                            <AlertTriangle className="w-3 h-3" />
                            {item}
                          </span>
                        ))
                      ) : (
                        <span
                          className={`flex items-center gap-1.5 text-sm italic ${
                            dark ? "text-slate-500" : "text-slate-400"
                          }`}
                        >
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" /> Tidak terdeteksi anomali
                          relasional — data tampak bersih.
                        </span>
                      )}
                    </div>
                  </div>

                  {/* ── Temuan table ── */}
                  {metrics.temuan_utama && <FindingsTable temuan={metrics.temuan_utama} dark={dark} />}

                  {/* ── Vendor table ── */}
                  {metrics.daftar_vendor && <VendorTable vendors={metrics.daftar_vendor} dark={dark} />}

                  {/* ── Affiliation graph ── */}
                  {graphData && graphData.nodes.length > 0 && (() => {
                    // highlightIds = semua vendor MENCURIGAKAN
                    // node IDs di-generate sebagai V0, V1, ... sesuai urutan daftar_vendor
                    const highlightIds = new Set(
                      (metrics.daftar_vendor ?? [])
                        .map((v, i) => v.status === "MENCURIGAKAN" ? `V${i}` : null)
                        .filter(Boolean) as string[]
                    );
                    return (
                      <AffiliationGraph
                        graphData={graphData}
                        highlightIds={highlightIds}
                        dark={dark}
                      />
                    );
                  })()}

                  {/* ── Other risky packages ── */}
                  {metrics.paket_berisiko_lain && metrics.paket_berisiko_lain.length > 0 && (
                    <OtherRiskyPackages paket={metrics.paket_berisiko_lain} dark={dark} />
                  )}

                  {/* ── Regulatory warning ── */}
                  {metrics.peringatan_regulasi && (
                    <div
                      className={`flex items-start gap-3 p-4 rounded-xl border ${
                        dark
                          ? "bg-amber-950/20 border-amber-900/40 text-amber-400"
                          : "bg-amber-50 border-amber-200 text-amber-700"
                      }`}
                    >
                      <Scale className="w-4 h-4 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-black uppercase tracking-widest mb-1">Peringatan Regulasi</p>
                        <p className="text-sm">{metrics.peringatan_regulasi}</p>
                      </div>
                    </div>
                  )}

                  {/* ── Method note ── */}
                  {metrics.catatan_metode && (
                    <div
                      className={`flex items-start gap-3 p-4 rounded-xl border ${
                        dark
                          ? "bg-slate-900/40 border-slate-700/40 text-slate-500"
                          : "bg-slate-50 border-slate-200 text-slate-400"
                      }`}
                    >
                      <BookOpen className="w-4 h-4 mt-0.5 shrink-0" />
                      <p className="text-xs">{metrics.catatan_metode}</p>
                    </div>
                  )}
                </>
              )}

              {/* ── Narrative report (LLM output) ── */}
              {report && (
                <div className={`border-t pt-8 ${dark ? "border-slate-800" : "border-slate-200"}`}>
                  <div className={`flex items-center gap-2 mb-5 ${dark ? "text-slate-400" : "text-slate-500"}`}>
                    <Info className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase tracking-widest">
                      Narasi Forensik &amp; Pemetaan Hukum
                    </span>
                  </div>
                  <div
                    className={`prose prose-sm max-w-none leading-relaxed ${
                      dark ? "prose-invert" : ""
                    } prose-headings:font-black prose-h2:text-base prose-h3:text-sm prose-h2:uppercase prose-h2:tracking-wider prose-table:text-sm`}
                  >
                    <ReactMarkdown>{report}</ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      <footer
        className={`text-center py-6 text-xs border-t mt-10 ${
          dark ? "text-slate-600 border-slate-800" : "text-slate-400 border-slate-200"
        }`}
      >
        SIDIK TENDER
      </footer>
    </div>
  );
}
