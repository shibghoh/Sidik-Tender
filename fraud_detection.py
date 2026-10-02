"""
fraud_detection.py v2 — Sidik Tender: Fase 1 (lapisan deterministik, NON-LLM) + Report Assembler
LPSE Anti-Fraud Intelligence Engine

Perubahan utama dibanding v1 (lihat juga test_fraud_detection.py):
  1. Semua ambang batas & bobot dipusatkan di CONFIG (satu tempat, ada penjelasan).
  2. Bukti keras (direktur/NPWP sama) tidak lagi "diencerkan" rata-rata berbobot:
     ada ATURAN OVERRIDE yang menaikkan skor ke batas minimal WASPADA/BAHAYA.
  3. Edge graf diberi bobot per jenis relasi (direktur/NPWP > alamat > subnet IP),
     teks alamat/nama dinormalisasi, subnet IP yang dipakai terlalu banyak
     perusahaan (kemungkinan ISP/warnet) diabaikan.
  4. Sinyal baru: tender satu penawar, penawar berulang bersama (co-bidding),
     dan rotasi pemenang antar paket.
  5. Sinyal variansi & timestamp dinonaktifkan jika peserta < 3 (tidak stabil).
  6. Degree centrality diganti ukuran klaster terhubung (lebih bermakna).
  7. Field `alasan` per vendor dan `tingkat` per temuan kini dihasilkan di Python,
     sehingga LLM tidak perlu (dan tidak boleh) mengarang.
  8. JSON laporan dirakit deterministik di Python (build_report_json). LLM hanya
     menulis narasi + pemetaan pasal; assemble_report() memvalidasi keluarannya
     (pasal harus ada di konteks RAG, angka & status harus cocok dengan data).
  9. validate_against_ground_truth memakai ambang yang sama dengan klasifikasi
     dan memberi catatan bahwa data sintetis bukan ukuran akurasi dunia nyata.

PENTING: ambang batas di CONFIG adalah ASUMSI AWAL yang harus dikalibrasi pada
kasus nyata (mis. putusan KPPU). Bukan angka baku dari literatur.

Jalankan langsung:
    python fraud_detection.py tender_data.csv --ground-truth ground_truth.json
"""

import argparse
import csv
import json
import re
from collections import defaultdict
from datetime import datetime
from statistics import mean, pstdev

import networkx as nx

# ---------------------------------------------------------------------------
# 0. KONFIGURASI (satu-satunya tempat angka "ajaib")
# ---------------------------------------------------------------------------

CONFIG = {
    # --- Variansi harga: CV (std/mean) rendah = penawaran mengelompok rapat.
    # CV 0% -> skor 100, CV >= cv_zero_at -> skor 0. (ASUMSI, kalibrasi dgn data nyata)
    "cv_zero_at": 0.12,
    # --- Margin ke HPS: rata-rata rasio penawaran/HPS. ratio_low -> 0, ratio_high -> 100.
    "margin_ratio_low": 0.80,
    "margin_ratio_high": 1.00,
    # --- Timestamp: span submit <= 0 menit -> 100, >= window -> 0.
    # Catatan: peserta jujur pun sering submit mendekati batas waktu, jadi bobotnya kecil.
    "timestamp_window_minutes": 1440,
    # --- Sinyal harga/waktu hanya dihitung bila peserta >= nilai ini.
    "min_participants_for_price_screens": 3,
    # --- Bobot komponen (harus berjumlah 1.0)
    "weights": {
        "variance_screen_score": 0.20,
        "margin_screen_score": 0.10,
        "timestamp_screen_score": 0.10,
        "graph_screen_score": 0.40,
        "cobid_screen_score": 0.20,
    },
    # --- Bobot edge per jenis relasi (kombinasi noisy-OR: 1 - prod(1 - w))
    "edge_weights": {
        "shared_npwp": 1.0,
        "shared_director": 0.9,
        "shared_address": 0.6,
        "shared_ip_subnet": 0.3,
    },
    # Edge dengan bobot >= nilai ini dianggap "bukti keras".
    "hard_edge_min_weight": 0.85,
    # Subnet IP yang dipakai > N perusahaan berbeda diabaikan (kemungkinan ISP/warnet/kampus).
    "max_subnet_group": 4,
    # Campuran skor graf: proporsi bobot-overlap vs ukuran klaster terbesar.
    "graph_mix_overlap": 0.6,
    "graph_mix_cluster": 0.4,
    # --- Co-bidding: pasangan dianggap "berulang" jika muncul bersama di >= N paket.
    "min_repeat_cobid": 3,
    # --- Ambang klasifikasi (indeks 0-100)
    "threshold_waspada": 30.0,
    "threshold_bahaya": 50.0,
    # --- Aturan override (indeks dinaikkan minimal ke nilai ini)
    "override_floor_waspada": 30.0,
    "override_floor_bahaya": 50.0,
    # BAHAYA jika klaster terhubung-keras mencakup >= proporsi peserta ini (min. 2 perusahaan).
    "override_hard_cluster_fraction": 0.6,
}

REASON_LABEL_ID = {
    "shared_npwp": "NPWP sama",
    "shared_director": "direktur/pengurus sama",
    "shared_address": "alamat kantor sama",
    "shared_ip_subnet": "subnet IP pengiriman sama",
}

SEVERITY_RANK = {"AMAN": 0, "WASPADA": 1, "BAHAYA": 2}

_TITLE_TOKENS = {
    "h", "hj", "haji", "hajjah", "ir", "dr", "drs", "dra", "prof", "st", "mt", "mm",
    "msi", "se", "sh", "mh", "spd", "sp", "ak", "mba", "bsc", "ssi", "skom", "mkom",
    "skm", "amd",
}
_ADDR_EXPAND = {
    "jl": "jalan", "jln": "jalan", "no": "nomor", "kec": "kecamatan", "kel": "kelurahan",
    "kab": "kabupaten", "gg": "gang", "ds": "desa",
}


# ---------------------------------------------------------------------------
# 1. LOAD DATA + NORMALISASI
# ---------------------------------------------------------------------------

def _to_float(value) -> float:
    s = str(value).strip().replace("Rp", "").replace("rp", "").replace(" ", "")
    if re.fullmatch(r"\d{1,3}(,\d{3})+(\.\d+)?", s):
        s = s.replace(",", "")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+(,\d+)?", s):
        s = s.replace(".", "").replace(",", ".")
    return float(s)


def _tokens(text: str) -> list:
    # Hapus titik dulu agar "S.T." -> "st" dan "Jl." -> "jl" (bukan "s","t" / "jl" terpisah).
    cleaned = str(text).lower().replace(".", "")
    return re.sub(r"[^a-z0-9\s]", " ", cleaned).split()


def normalize_director(name):
    if not name:
        return None
    toks = [t for t in _tokens(name) if t not in _TITLE_TOKENS]
    return " ".join(toks) or None


def normalize_address(addr):
    if not addr:
        return None
    toks = [_ADDR_EXPAND.get(t, t) for t in _tokens(addr)]
    return " ".join(toks) or None


def normalize_npwp(npwp):
    if not npwp:
        return None
    digits = re.sub(r"\D", "", str(npwp))
    return digits or None


def _truthy(value) -> bool:
    return str(value).strip().lower() in {"1", "true", "ya", "yes", "y", "menang", "pemenang"}


def _parse_ts(value):
    if not value:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.strip())
    except ValueError:
        return None


def load_data(csv_path: str) -> dict:
    """Baca CSV -> dict paket. Kolom wajib: package_id, package_name, category, hps, opd,
    company_id, company_name, bid_price. Kolom opsional: npwp, director_name,
    office_address, submit_ip, submit_timestamp, is_winner."""
    packages = {}
    has_winner_col = False
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        has_winner_col = "is_winner" in (reader.fieldnames or [])
        for row in reader:
            pid = row["package_id"].strip()
            if pid not in packages:
                hps = _to_float(row["hps"])
                if hps <= 0:
                    raise ValueError(f"HPS paket {pid} harus > 0")
                packages[pid] = {
                    "package_id": pid,
                    "package_name": row.get("package_name", ""),
                    "category": row.get("category", ""),
                    "hps": hps,
                    "opd": row.get("opd", ""),
                    "participants": [],
                }
            packages[pid]["participants"].append({
                "company_id": row["company_id"].strip(),
                "npwp": row.get("npwp") or None,
                "company_name": row.get("company_name", ""),
                "bid_price": _to_float(row["bid_price"]),
                "director_name": row.get("director_name") or None,
                "office_address": row.get("office_address") or None,
                "submit_ip": row.get("submit_ip") or None,
                "submit_timestamp": row.get("submit_timestamp") or None,
                "is_winner": _truthy(row.get("is_winner", "")) if has_winner_col else None,
            })

    # Tentukan pemenang per paket: pakai kolom is_winner jika ada, jika tidak
    # DIINFERENSI = penawaran terendah (asumsi sistem harga terendah; ditandai).
    for pkg in packages.values():
        winners = [p for p in pkg["participants"] if p["is_winner"]]
        if winners:
            pkg["winner_id"], pkg["winner_inferred"] = winners[0]["company_id"], False
        elif pkg["participants"]:
            low = min(pkg["participants"], key=lambda p: p["bid_price"])
            pkg["winner_id"], pkg["winner_inferred"] = low["company_id"], True
        else:
            pkg["winner_id"], pkg["winner_inferred"] = None, True
    return packages


def _minmax_norm(value, lo, hi):
    if hi == lo:
        return 0.0
    return max(0.0, min(100.0, (value - lo) / (hi - lo) * 100.0))


# ---------------------------------------------------------------------------
# 2. SINYAL HARGA & WAKTU
# ---------------------------------------------------------------------------

def compute_price_screens(package: dict) -> dict:
    participants = package["participants"]
    hps = package["hps"]
    prices = [p["bid_price"] for p in participants]
    n = len(prices)
    ratios = [price / hps for price in prices]
    mean_ratio = mean(ratios)
    cv = (pstdev(prices) / mean(prices)) if n > 1 and mean(prices) > 0 else None

    notes = []
    enough = n >= CONFIG["min_participants_for_price_screens"]
    if not enough:
        notes.append(f"peserta={n} < {CONFIG['min_participants_for_price_screens']}: sinyal variansi & waktu dinonaktifkan")

    variance_score = 0.0
    margin_score = _minmax_norm(mean_ratio, CONFIG["margin_ratio_low"], CONFIG["margin_ratio_high"]) if n >= 2 else 0.0
    ts_score, span_minutes = 0.0, None
    if enough and cv is not None:
        variance_score = _minmax_norm(CONFIG["cv_zero_at"] - cv, 0, CONFIG["cv_zero_at"])
        parsed = sorted(t for t in (_parse_ts(p["submit_timestamp"]) for p in participants) if t)
        if len(parsed) > 1:
            span_minutes = (parsed[-1] - parsed[0]).total_seconds() / 60
            w = CONFIG["timestamp_window_minutes"]
            ts_score = _minmax_norm(w - span_minutes, 0, w)

    return {
        "variance_screen_score": round(variance_score, 1),
        "margin_screen_score": round(margin_score, 1),
        "timestamp_screen_score": round(ts_score, 1),
        "raw": {
            "coefficient_of_variation": round(cv, 4) if cv is not None else None,
            "mean_ratio_to_hps": round(mean_ratio, 4),
            "submit_span_minutes": round(span_minutes, 1) if span_minutes is not None else None,
        },
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# 3. GRAF RELASI (lintas semua paket)
# ---------------------------------------------------------------------------

def _noisy_or(weights):
    p = 1.0
    for w in weights:
        p *= (1.0 - w)
    return 1.0 - p


def build_relation_graph(packages: dict) -> nx.Graph:
    """Node = company_id. Edge = relasi antar perusahaan, dengan atribut:
    reasons (set), weight (noisy-OR bobot per jenis relasi)."""
    g = nx.Graph()
    by_npwp, by_director, by_address, by_subnet = (defaultdict(set) for _ in range(4))

    for pkg in packages.values():
        for p in pkg["participants"]:
            cid = p["company_id"]
            g.add_node(cid, company_name=p["company_name"], npwp=p["npwp"])
            if (k := normalize_npwp(p["npwp"])):
                by_npwp[k].add(cid)
            if (k := normalize_director(p["director_name"])):
                by_director[k].add(cid)
            if (k := normalize_address(p["office_address"])):
                by_address[k].add(cid)
            if p["submit_ip"]:
                octets = p["submit_ip"].strip().split(".")
                if len(octets) == 4:
                    by_subnet[".".join(octets[:3])].add(cid)

    def add_edges(groups, reason, max_group=None):
        for members in groups.values():
            if len(members) < 2 or (max_group and len(members) > max_group):
                continue
            members = sorted(members)
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    a, b = members[i], members[j]
                    if g.has_edge(a, b):
                        g[a][b]["reasons"].add(reason)
                    else:
                        g.add_edge(a, b, reasons={reason})

    add_edges(by_npwp, "shared_npwp")
    add_edges(by_director, "shared_director")
    add_edges(by_address, "shared_address")
    add_edges(by_subnet, "shared_ip_subnet", max_group=CONFIG["max_subnet_group"])

    ew = CONFIG["edge_weights"]
    for a, b in g.edges:
        g[a][b]["weight"] = round(_noisy_or([ew[r] for r in g[a][b]["reasons"]]), 3)
    return g


def _largest_component(nodes, edges):
    """Ukuran & anggota komponen terhubung terbesar (union-find kecil)."""
    parent = {n: n for n in nodes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in edges:
        parent[find(a)] = find(b)
    groups = defaultdict(set)
    for n in nodes:
        groups[find(n)].add(n)
    if not groups:
        return set()
    return max(groups.values(), key=len)


def graph_score_for_package(package: dict, g: nx.Graph) -> dict:
    ids = [p["company_id"] for p in package["participants"]]
    n = len(ids)
    empty = {
        "cluster_overlap_ratio": 0.0, "weighted_overlap": 0.0, "largest_cluster": 1,
        "cluster_fraction": 0.0, "graph_screen_score": 0.0, "connected_reasons": [],
        "hard_pairs": 0, "hard_cluster_size": 1 if n else 0, "hard_cluster_fraction": 0.0,
        "pair_links": [],
    }
    if n < 2:
        return empty

    hard_min = CONFIG["hard_edge_min_weight"]
    total_pairs = n * (n - 1) / 2
    connected, wsum, hard_pairs = 0, 0.0, 0
    reasons, links, edges_all, edges_hard = set(), [], [], []
    for i in range(n):
        for j in range(i + 1, n):
            a, b = ids[i], ids[j]
            if g.has_edge(a, b):
                w, rs = g[a][b]["weight"], g[a][b]["reasons"]
                connected += 1
                wsum += w
                reasons |= rs
                links.append({"a": a, "b": b, "reasons": sorted(rs), "weight": w})
                edges_all.append((a, b))
                if w >= hard_min:
                    hard_pairs += 1
                    edges_hard.append((a, b))

    comp = _largest_component(ids, edges_all)
    hard_comp = _largest_component(ids, edges_hard)
    cluster_fraction = (len(comp) - 1) / (n - 1)
    weighted_overlap = wsum / total_pairs
    score = 100.0 * (CONFIG["graph_mix_overlap"] * weighted_overlap + CONFIG["graph_mix_cluster"] * cluster_fraction)
    return {
        "cluster_overlap_ratio": round(connected / total_pairs, 2),
        "weighted_overlap": round(weighted_overlap, 3),
        "largest_cluster": len(comp),
        "cluster_fraction": round(cluster_fraction, 3),
        "graph_screen_score": round(score, 1),
        "connected_reasons": sorted(reasons),
        "hard_pairs": hard_pairs,
        "hard_cluster_size": len(hard_comp),
        "hard_cluster_fraction": round(len(hard_comp) / n, 3) if len(hard_comp) >= 2 else 0.0,
        "pair_links": links,
    }


# ---------------------------------------------------------------------------
# 3b. CO-BIDDING BERULANG & ROTASI PEMENANG (lintas paket)
# ---------------------------------------------------------------------------

def build_cobid_index(packages: dict) -> dict:
    pairs = defaultdict(set)
    for pid, pkg in packages.items():
        ids = sorted({p["company_id"] for p in pkg["participants"]})
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pairs[(ids[i], ids[j])].add(pid)
    return pairs


def compute_cobid_screen(pkg: dict, packages: dict, pairs: dict) -> dict:
    ids = sorted({p["company_id"] for p in pkg["participants"]})
    n = len(ids)
    out = {"cobid_screen_score": 0.0, "repeat_pair_ratio": 0.0, "rotation_detected": False,
           "repeat_members": [], "repeat_package_count": 0}
    if n < 2:
        return out
    min_rep = CONFIG["min_repeat_cobid"]
    repeat_edges = [(ids[i], ids[j]) for i in range(n) for j in range(i + 1, n)
                    if len(pairs.get((ids[i], ids[j]), ())) >= min_rep]
    total_pairs = n * (n - 1) / 2
    out["repeat_pair_ratio"] = round(len(repeat_edges) / total_pairs, 3)

    rotation = False
    if repeat_edges:
        members = _largest_component(ids, repeat_edges)
        if len(members) >= 2:
            out["repeat_members"] = sorted(members)
            shared = [pid for pid, p in packages.items()
                      if len(members & {x["company_id"] for x in p["participants"]}) >= 2]
            out["repeat_package_count"] = len(shared)
            winners = [packages[pid]["winner_id"] for pid in shared if packages[pid]["winner_id"]]
            rotation = (len(shared) >= min_rep and bool(winners)
                        and all(w in members for w in winners) and len(set(winners)) >= 2)
    out["rotation_detected"] = rotation
    out["cobid_screen_score"] = round(100.0 * (0.5 * out["repeat_pair_ratio"] + 0.5 * (1.0 if rotation else 0.0)), 1)
    return out


# ---------------------------------------------------------------------------
# 4. INDEKS RISIKO + OVERRIDE + KLASIFIKASI
# ---------------------------------------------------------------------------

def compute_fraud_risk_index(price_screens: dict, graph_screens: dict, cobid_screens: dict) -> dict:
    combined = {
        "variance_screen_score": price_screens["variance_screen_score"],
        "margin_screen_score": price_screens["margin_screen_score"],
        "timestamp_screen_score": price_screens["timestamp_screen_score"],
        "graph_screen_score": graph_screens["graph_screen_score"],
        "cobid_screen_score": cobid_screens["cobid_screen_score"],
    }
    weights = CONFIG["weights"]
    assert abs(sum(weights.values()) - 1.0) < 1e-9, "Bobot CONFIG['weights'] harus berjumlah 1.0"
    raw = sum(combined[k] * w for k, w in weights.items())
    return {"fraud_risk_index_raw": round(raw, 1), "component_scores": combined}


def apply_overrides(index_raw: float, n: int, graph_screens: dict, cobid_screens: dict) -> tuple:
    """Bukti keras tidak boleh diencerkan rata-rata. Mengembalikan (indeks_final, daftar_override)."""
    floors, applied = [], []
    if n == 1:
        floors.append(CONFIG["override_floor_waspada"])
        applied.append("tender_satu_penawar")
    if graph_screens["hard_pairs"] > 0:
        floors.append(CONFIG["override_floor_waspada"])
        applied.append("hubungan_kuat_antar_peserta (direktur/NPWP sama)")
        if graph_screens["hard_cluster_fraction"] >= CONFIG["override_hard_cluster_fraction"]:
            floors.append(CONFIG["override_floor_bahaya"])
            applied.append("mayoritas_peserta_dikendalikan_pihak_sama")
    if cobid_screens["rotation_detected"]:
        floors.append(CONFIG["override_floor_waspada"])
        applied.append("rotasi_pemenang_antar_paket")
    final = max([index_raw] + floors)
    return round(final, 1), applied


def classify_risk(fraud_risk_index: float) -> dict:
    """Klasifikasi berdasarkan ambang tetap (bukan keputusan LLM)."""
    if fraud_risk_index >= CONFIG["threshold_bahaya"]:
        return {"status_kesimpulan": "BAHAYA", "tingkat": "TINGGI"}
    if fraud_risk_index >= CONFIG["threshold_waspada"]:
        return {"status_kesimpulan": "WASPADA", "tingkat": "SEDANG"}
    return {"status_kesimpulan": "AMAN", "tingkat": "RENDAH"}


# ---------------------------------------------------------------------------
# 5. VENDOR, TEMUAN, TEKS BUKTI, LAPORAN JSON (semua deterministik)
# ---------------------------------------------------------------------------

def _level(score: float) -> str:
    return "TINGGI" if score >= 75 else "SEDANG" if score >= 50 else "RENDAH"


def build_vendors(pkg: dict, graph_screens: dict, cobid_screens: dict) -> list:
    name_of = {p["company_id"]: p["company_name"] for p in pkg["participants"]}
    alasan = defaultdict(list)
    for link in graph_screens["pair_links"]:
        label = ", ".join(REASON_LABEL_ID[r] for r in link["reasons"])
        alasan[link["a"]].append(f"{label} dengan {name_of[link['b']]}")
        alasan[link["b"]].append(f"{label} dengan {name_of[link['a']]}")
    if cobid_screens["rotation_detected"]:
        for cid in cobid_screens["repeat_members"]:
            if cid in name_of:
                alasan[cid].append(
                    f"berulang mengikuti tender yang sama ({cobid_screens['repeat_package_count']} paket) "
                    "dengan pemenang bergilir")
    vendors = []
    for p in pkg["participants"]:
        reasons = alasan.get(p["company_id"], [])
        vendors.append({
            "nama": p["company_name"],
            "bid_price": p["bid_price"],
            "status": "MENCURIGAKAN" if reasons else "NORMAL",
            "alasan": "; ".join(reasons) if reasons else "Tidak ada relasi terdeteksi dengan peserta lain pada paket ini",
        })
    return vendors


def build_findings(n, comps, graph, price, cobid, overrides) -> list:
    items = []

    def add(kategori, deskripsi, tingkat):
        items.append({"no": len(items) + 1, "kategori": kategori, "deskripsi": deskripsi,
                      "tingkat": tingkat, "regulasi": ""})

    if n == 1:
        add("satu_penawar", "Tender hanya diikuti satu penawar.", "SEDANG")
    if graph["connected_reasons"]:
        labels = ", ".join(REASON_LABEL_ID[r] for r in graph["connected_reasons"])
        lvl = "TINGGI" if graph["hard_cluster_fraction"] >= CONFIG["override_hard_cluster_fraction"] else \
              ("SEDANG" if graph["hard_pairs"] else "RENDAH")
        add("relasi", f"Terdapat relasi antar peserta dalam paket yang sama: {labels} "
                      f"({graph['largest_cluster']} dari {n} peserta saling terhubung).", lvl)
    if comps["variance_screen_score"] >= 50:
        add("variansi", f"Penawaran sangat berdekatan (CV {price['raw']['coefficient_of_variation']*100:.1f}%).",
            _level(comps["variance_screen_score"]))
    if comps["margin_screen_score"] >= 50:
        add("margin_hps", f"Rata-rata penawaran {price['raw']['mean_ratio_to_hps']*100:.1f}% dari HPS (mepet HPS).",
            _level(comps["margin_screen_score"]))
    if comps["timestamp_screen_score"] >= 50:
        add("waktu", f"Seluruh penawaran dikirim dalam rentang {price['raw']['submit_span_minutes']:.0f} menit.",
            _level(comps["timestamp_screen_score"]))
    if cobid["repeat_pair_ratio"] > 0 or cobid["rotation_detected"]:
        txt = f"Peserta berulang mengikuti paket yang sama ({cobid['repeat_package_count']} paket)"
        txt += " dengan pola pemenang bergilir." if cobid["rotation_detected"] else "."
        add("cobid", txt, "TINGGI" if cobid["rotation_detected"] else "SEDANG")
    return items


def analyze_package(pkg, g, cobid_pairs, packages) -> dict:
    n = len(pkg["participants"])
    price = compute_price_screens(pkg)
    graph = graph_score_for_package(pkg, g)
    cobid = compute_cobid_screen(pkg, packages, cobid_pairs)
    risk = compute_fraud_risk_index(price, graph, cobid)
    final_index, overrides = apply_overrides(risk["fraud_risk_index_raw"], n, graph, cobid)
    comps = risk["component_scores"]
    return {
        "package_id": pkg["package_id"],
        "package_name": pkg["package_name"],
        "category": pkg["category"],
        "opd": pkg["opd"],
        "hps": pkg["hps"],
        "participant_count": n,
        "fraud_risk_index": final_index,
        "fraud_risk_index_raw": risk["fraud_risk_index_raw"],
        "overrides_applied": overrides,
        "component_scores": comps,
        "price_screen_raw": price["raw"],
        "data_quality_notes": price["notes"] + (["pemenang diinferensi dari penawaran terendah"] if pkg["winner_inferred"] else []),
        "graph_evidence": {
            "cluster_overlap_ratio": graph["cluster_overlap_ratio"],
            "weighted_overlap": graph["weighted_overlap"],
            "largest_cluster": graph["largest_cluster"],
            "connected_reasons": graph["connected_reasons"],
            "connected_reasons_id": [REASON_LABEL_ID[r] for r in graph["connected_reasons"]],
        },
        "cobid_evidence": {k: cobid[k] for k in ("repeat_pair_ratio", "rotation_detected", "repeat_package_count")},
        "vendors": build_vendors(pkg, graph, cobid),
        "temuan": build_findings(n, comps, graph, price, cobid, overrides),
        **classify_risk(final_index),
    }


def build_report_json(top: dict, all_packages: list) -> dict:
    """JSON laporan akhir (kontrak dgn frontend). Semua angka dari Python, bukan LLM."""
    vendors = top["vendors"]
    return {
        "status_kesimpulan": top["status_kesimpulan"],
        "skor_risiko_persentase": round(top["fraud_risk_index"]),
        "deviasi_hps_persentase": round(top["price_screen_raw"]["mean_ratio_to_hps"] * 100),
        "jumlah_vendor_terafiliasi": sum(1 for v in vendors if v["status"] == "MENCURIGAKAN"),
        "indikator_ditemukan": top["graph_evidence"]["connected_reasons_id"]
                               + (["rotasi pemenang antar paket"] if top["cobid_evidence"]["rotation_detected"] else [])
                               + (["tender satu penawar"] if top["participant_count"] == 1 else []),
        "temuan_utama": top["temuan"],
        "daftar_vendor": vendors,
        "paket_dianalisis": {"id": top["package_id"], "nama": top["package_name"]},
        "paket_berisiko_lain": [
            {"package_id": r["package_id"], "package_name": r["package_name"],
             "fraud_risk_index": r["fraud_risk_index"], "status_kesimpulan": r["status_kesimpulan"]}
            for r in all_packages if r["package_id"] != top["package_id"] and r["status_kesimpulan"] != "AMAN"
        ],
        "peringatan_regulasi": "",
        "catatan_metode": ("Skor dihitung deterministik tanpa LLM. Ini indikator risiko untuk investigasi awal "
                           "oleh auditor, bukan bukti pelanggaran."),
    }


def build_evidence_text(top: dict, all_packages: list) -> str:
    """Ringkasan bukti ringkas & terstruktur untuk prompt LLM (menggantikan dump seluruh graf)."""
    c, raw = top["component_scores"], top["price_screen_raw"]
    L = [
        f"PAKET: {top['package_id']} - {top['package_name']} ({top['category']}, {top['opd']})",
        f"HPS: {top['hps']:,.0f} | Peserta: {top['participant_count']}",
        f"INDEKS RISIKO: {top['fraud_risk_index']} (mentah {top['fraud_risk_index_raw']}) -> {top['status_kesimpulan']}",
        "OVERRIDE: " + (", ".join(top["overrides_applied"]) or "tidak ada"),
        f"SKOR KOMPONEN: variansi={c['variance_screen_score']}, margin_hps={c['margin_screen_score']}, "
        f"waktu={c['timestamp_screen_score']}, graf={c['graph_screen_score']}, cobid={c['cobid_screen_score']}",
        f"ANGKA MENTAH: CV={raw['coefficient_of_variation']}, rasio_rata2_ke_HPS={raw['mean_ratio_to_hps']}, "
        f"rentang_submit_menit={raw['submit_span_minutes']}",
        "TEMUAN:",
    ]
    L += [f"  {t['no']}. [{t['tingkat']}] ({t['kategori']}) {t['deskripsi']}" for t in top["temuan"]] or ["  (tidak ada)"]
    L.append("VENDOR:")
    L += [f"  - {v['nama']} | {v['bid_price']:,.0f} | {v['status']} | {v['alasan']}" for v in top["vendors"]]
    others = [r for r in all_packages if r["package_id"] != top["package_id"] and r["status_kesimpulan"] != "AMAN"]
    if others:
        L.append("PAKET BERISIKO LAIN: " + "; ".join(
            f"{r['package_id']} ({r['fraud_risk_index']}, {r['status_kesimpulan']})" for r in others[:10]))
    if top["data_quality_notes"]:
        L.append("CATATAN DATA: " + "; ".join(top["data_quality_notes"]))
    return "\n".join(L)


def run_fraud_analysis(csv_path: str) -> dict:
    packages = load_data(csv_path)
    g = build_relation_graph(packages)
    pairs = build_cobid_index(packages)

    results = [analyze_package(pkg, g, pairs, packages) for pkg in packages.values()]
    results.sort(key=lambda r: (SEVERITY_RANK[r["status_kesimpulan"]], r["fraud_risk_index"]), reverse=True)

    graph_export = {
        "nodes": [{"id": n, **g.nodes[n]} for n in g.nodes],
        "edges": [{"source": a, "target": b, "reasons": sorted(g[a][b]["reasons"]), "weight": g[a][b]["weight"]}
                  for a, b in g.edges],
    }
    out = {"schema_version": "2", "packages": results, "graph": graph_export}
    if results:
        top = results[0]
        out["top_package"] = top
        out["evidence_text"] = build_evidence_text(top, results)
        out["report_json"] = build_report_json(top, results)
    return out


# ---------------------------------------------------------------------------
# 6. REPORT ASSEMBLER — gabungkan data deterministik + narasi LLM, dengan validasi
# ---------------------------------------------------------------------------

_JSON_FENCE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)
_PASAL = re.compile(r"Pasal\s+(\d+[A-Za-z]?)", re.IGNORECASE)
_UNVERIFIED_HINT = re.compile(r"belum\s+(?:ter)?verifikasi|belum\s+diverifikasi|perlu\s+diverifikasi", re.IGNORECASE)


def _split_llm_output(text: str):
    """Ambil blok JSON pertama (pemetaan regulasi) dan sisa narasi Markdown."""
    m = _JSON_FENCE.search(text or "")
    if not m:
        return None, (text or "").strip()
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        data = None
    return data, (text[:m.start()] + text[m.end():]).strip()


def _allowed_numbers(top: dict) -> set:
    raw = top["price_screen_raw"]
    vals = [top["fraud_risk_index"], top["fraud_risk_index_raw"], top["participant_count"], top["hps"]]
    vals += list(top["component_scores"].values())
    vals += [raw["mean_ratio_to_hps"] * 100, (raw["coefficient_of_variation"] or 0) * 100,
             raw["submit_span_minutes"] or 0, top["graph_evidence"]["cluster_overlap_ratio"] * 100,
             top["graph_evidence"]["weighted_overlap"] * 100, top["graph_evidence"]["largest_cluster"],
             top["cobid_evidence"]["repeat_package_count"]]
    return {float(v) for v in vals}


def validate_narrative(narrative: str, top: dict) -> list:
    """Pemeriksaan ringan: status, angka persen, dan nama perusahaan harus cocok dengan data."""
    notes = []
    for s in ("BAHAYA", "WASPADA", "AMAN"):
        if s != top["status_kesimpulan"] and re.search(rf"\b{s}\b", narrative):
            notes.append(f"Narasi menyebut status {s}, sedangkan status sistem {top['status_kesimpulan']}.")
    allowed = _allowed_numbers(top)
    for m in re.finditer(r"(\d+(?:[.,]\d+)?)\s*%", narrative):
        val = float(m.group(1).replace(",", "."))
        if not any(abs(val - a) <= 0.6 for a in allowed):
            notes.append(f"Angka {m.group(0)} pada narasi tidak ditemukan di data sistem.")
    names = " | ".join(v["nama"].lower() for v in top["vendors"])
    for m in re.finditer(r"\b(?:PT|CV|UD)\.?\s+([A-Z][\w&-]*(?:\s+[A-Z][\w&-]*)?)", narrative):
        if m.group(1).lower() not in names:
            notes.append(f"Nama perusahaan '{m.group(0).strip()}' pada narasi tidak ada di daftar peserta.")
    return list(dict.fromkeys(notes))


def assemble_report(fraud_result: dict, legal_output: str, regulation_context: str) -> str:
    """Keluaran akhir: blok ```json (dirakit Python) + narasi Markdown (dari LLM) + catatan validasi."""
    report = dict(fraud_result.get("report_json") or {})
    top = fraud_result.get("top_package")
    if not report or not top:
        return "Tidak ada paket yang dapat dianalisis dari data yang diberikan."

    mapping, narrative = _split_llm_output(legal_output)
    allowed_pasal = {m.upper() for m in _PASAL.findall(regulation_context or "")}
    notes = []

    reg_by_no = {}
    for item in (mapping or {}).get("pemetaan_regulasi", []) if isinstance(mapping, dict) else []:
        try:
            reg_by_no[int(item.get("no"))] = str(item.get("regulasi", "")).strip()
        except (TypeError, ValueError):
            continue

    for t in report["temuan_utama"]:
        reg = reg_by_no.get(t["no"], "")
        cited = {x.upper() for x in _PASAL.findall(reg)}
        if reg and cited and not cited <= allowed_pasal:
            notes.append(f"Temuan {t['no']}: pasal yang dikutip tidak ada di konteks regulasi dan dihapus.")
            reg = ""
        t["regulasi"] = reg or "Belum ada pasal relevan yang terverifikasi pada basis pengetahuan."

    if _UNVERIFIED_HINT.search(regulation_context or ""):
        report["peringatan_regulasi"] = ("Sebagian redaksi pasal pada basis pengetahuan belum diverifikasi; "
                                         "periksa salinan resmi (JDIH/peraturan.go.id) sebelum dijadikan rujukan.")

    notes += validate_narrative(narrative, top)
    out = "```json\n" + json.dumps(report, ensure_ascii=False, indent=2) + "\n```\n\n" + narrative
    if notes:
        out += "\n\n## Catatan Validasi Otomatis\n" + "\n".join(f"- {n}" for n in notes)
    return out


# ---------------------------------------------------------------------------
# 7. VALIDASI TERHADAP GROUND TRUTH (hanya untuk pengembangan)
# ---------------------------------------------------------------------------

def validate_against_ground_truth(results: dict, ground_truth_path: str, threshold: float = None) -> dict:
    threshold = CONFIG["threshold_waspada"] if threshold is None else threshold
    with open(ground_truth_path, encoding="utf-8") as f:
        truth = json.load(f)
    tainted_true = set(truth["tainted_packages"])
    flagged = {r["package_id"] for r in results["packages"] if r["fraud_risk_index"] >= threshold}

    tp, fp, fn = len(flagged & tainted_true), len(flagged - tainted_true), len(tainted_true - flagged)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "threshold": threshold, "true_positives": tp, "false_positives": fp, "false_negatives": fn,
        "precision": round(precision, 2), "recall": round(recall, 2), "f1_score": round(f1, 2),
        "flagged_packages": sorted(flagged),
        "catatan": ("Ground truth berasal dari generator data sintetis: ini uji konsistensi pada pola yang "
                    "ditanam, BUKAN estimasi akurasi dunia nyata. Jangan dilaporkan sebagai akurasi sistem."),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Sidik Tender — Fase 1 (deterministik)")
    ap.add_argument("csv_path")
    ap.add_argument("--ground-truth")
    ap.add_argument("--out", default="fase1_output.json")
    args = ap.parse_args()

    output = run_fraud_analysis(args.csv_path)
    print("\n=== TOP PAKET BERISIKO ===")
    for r in output["packages"][:10]:
        print(f"{r['package_id']:15s} risk={r['fraud_risk_index']:5.1f} {r['status_kesimpulan']:8s} {r['package_name']}")
    if args.ground_truth:
        print("\n=== VALIDASI vs GROUND TRUTH ===")
        for k, v in validate_against_ground_truth(output, args.ground_truth).items():
            print(f"{k}: {v}")
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\nOutput lengkap ditulis ke {args.out}")
