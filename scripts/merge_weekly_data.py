#!/usr/bin/env python3
"""Merge a weekly IFPC Guidewheel data pull into public/dashboard.html.

Freshest-wins merge (newest pull is source of truth on any collision):
  Trends_*  -> rawData     new pull's dates replace overlapping days; totalHrs
                           uses exact hrs for new dates + pct*24 approx for the
                           replaced overlap days; totalPct = mean of non-zero %.
  energy    -> energyData  per-day kWh, new pull wins its dates.
  Issues_*  -> issuesData  the new export REPLACES its whole window (from its
                           earliest Start); older issues kept. "Ongoing" -> 0 min.
  Temp/Hum  -> sensorData  hourly points merged, new wins on timestamp.

Usage:
  python3 scripts/merge_weekly_data.py [--dir ~/Downloads]
Reads whichever of these exist in --dir (never moves/renames them):
  Trends_All_*.xlsx, All_devices_energy_calculations*.xlsx,
  Issues_All_Devices_*.xlsx, "IFPC Temp.xlsx" / "IFPC - Temp.xlsx",
  "IFPC Humidity.xlsx" / "IFPC - Humidity.xlsx"
If several files match a pattern, the most recently modified one is used.
"""
import openpyxl, json, re, os, sys, glob
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(HERE, "..", "public", "dashboard.html")
MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
SKIP = {"Relative Humidity (%)", "Temperature (F)", "Total", "Sum"}

def newest(pattern, d):
    hits = glob.glob(os.path.join(d, pattern))
    return max(hits, key=os.path.getmtime) if hits else None

def num(v):
    if v in (None, ""): return None
    try: return float(v)
    except (TypeError, ValueError): return None

def slug(name): return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
def lbl_to_iso(lbl):
    mon, day = lbl.split()
    return f"2026-{MONTHS.index(mon)+1:02d}-{int(day):02d}"
def iso_to_lbl(iso): return f"{MONTHS[int(iso[5:7])-1]} {int(iso[8:10])}"

def sheet_rows(path, sheet=None):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    return rows

# ── merges ────────────────────────────────────────────────────────────────────

def merge_trends(src, path):
    m = re.search(r"const rawData = \{.*?\n        \};", src, re.DOTALL)
    blk = m.group(0)
    dates_old = json.loads(re.search(r"dates: (\[[^\]]*\])", blk).group(1))
    day_isos_old = [lbl_to_iso(dates_old[i]) for i in range(0, len(dates_old), 2)]
    old = {}
    for dm in re.finditer(r'\{ name: ("(?:[^"\\]|\\.)*"), group: ("(?:[^"\\]|\\.)*"), totalPct: \d+, totalHrs: ([0-9.]+), data: (\[[^\]]*\]) \}', blk):
        name = json.loads(dm.group(1)); data = json.loads(dm.group(4))
        old[name] = {"group": json.loads(dm.group(2)), "totalHrs": float(dm.group(3)),
                     "pct": {day_isos_old[i]: data[i*2] for i in range(len(day_isos_old))}}

    rows = sheet_rows(path, "entry")
    header = rows[0]; date_cols = []; c = 1
    while c < len(header):
        h = str(header[c] or "")
        mm = re.match(r"\w{3} (\w{3}) (\d+) (\d{4})\s+\(Runtime %\)", h)
        if mm:
            iso = f"{mm.group(3)}-{MONTHS.index(mm.group(1))+1:02d}-{int(mm.group(2)):02d}"
            date_cols.append((c, c+1, iso)); c += 3
        else:
            c += 1
    new = {}
    for r in rows[1:]:
        name = r[0]
        if not name or name in SKIP: continue
        new[name] = {}
        for cp, ch, iso in date_cols:
            p = num(r[cp]); h = num(r[ch])
            new[name][iso] = (round(p) if p is not None else 0, h or 0.0)

    all_isos = sorted(set(day_isos_old) | {i for _, _, i in date_cols})
    devices = []
    for n in sorted(set(old) | set(new)):
        o = old.get(n, {"group": slug(n), "totalHrs": 0.0, "pct": {}})
        pct = dict(o["pct"])
        overlap = [i for i in new.get(n, {}) if i in pct]
        hrs = o["totalHrs"] - sum(pct[i]/100*24 for i in overlap)
        for iso, (p, h) in new.get(n, {}).items():
            pct[iso] = p; hrs += h
        data = []
        for iso in all_isos:
            p = pct.get(iso, 0) or 0
            data.extend([p, p])
        nz = [v for v in pct.values() if v]
        devices.append({"name": n, "group": o["group"],
                        "totalPct": round(sum(nz)/len(nz)) if nz else 0,
                        "totalHrs": round(max(hrs, 0), 2), "data": data})
    dates, shifts = [], []
    for iso in all_isos:
        lbl = iso_to_lbl(iso); dates.extend([lbl, lbl]); shifts.extend(["Night", "Day"])
    pad = " " * 16
    dev_js = "\n".join(
        f'{pad}{{ name: {json.dumps(d["name"])}, group: {json.dumps(d["group"])}, '
        f'totalPct: {d["totalPct"]}, totalHrs: {d["totalHrs"]}, data: {json.dumps(d["data"])} }},'
        for d in devices)
    raw_block = ("const rawData = {\n            devices: [\n" + dev_js +
                 "\n            ],\n"
                 f"            dates: {json.dumps(dates)},\n"
                 f"            shifts: {json.dumps(shifts)}\n        }};")
    src, n = re.subn(r"const rawData = \{.*?\n        \};", lambda m: raw_block, src, count=1, flags=re.DOTALL)
    assert n == 1
    print(f"  rawData: {len(devices)} devices, {len(all_isos)} days ({all_isos[0]} .. {all_isos[-1]})")
    return src

def merge_energy(src, path):
    m = re.search(r"var energyData = \{.*?\n        \};", src, re.DOTALL)
    blk = m.group(0)
    isos_old = json.loads(re.search(r"isoDates: (\[[^\]]*\])", blk).group(1))
    old = {}
    for dm in re.finditer(r'\{name:("(?:[^"\\]|\\.)*"),group:("(?:[^"\\]|\\.)*"),totalKwh:[0-9.]+,data:(\[[^\]]*\])\}', blk):
        old[json.loads(dm.group(1))] = dict(zip(isos_old, json.loads(dm.group(3))))
    rows = sheet_rows(path, "energy")
    hdr = [str(h) for h in rows[0]]
    new_days = {}
    for r in rows[1:]:
        if not r[0]: continue
        iso = str(r[0])[:10]
        new_days[iso] = {hdr[i]: (num(r[i]) or 0.0) for i in range(1, len(hdr)) if hdr[i] not in SKIP}
    names = sorted(set(old) | {k for d in new_days.values() for k in d})
    merged = {n: dict(old.get(n, {})) for n in names}
    for iso, day in new_days.items():
        for n in names:
            merged[n][iso] = round(day.get(n, 0.0), 2)
    isos = sorted({i for s in merged.values() for i in s})
    devices = []
    for n in names:
        series = [round(merged[n].get(i, 0.0), 2) for i in isos]
        devices.append((n, slug(n), round(sum(series), 2), series))
    block = ("var energyData = {\n"
             f"            dates: {json.dumps([iso_to_lbl(i) for i in isos])},\n"
             f"            isoDates: {json.dumps(isos)},\n"
             "            devices: [\n"
             + "\n".join(f'                {{name:{json.dumps(n)},group:{json.dumps(g)},totalKwh:{t},data:{json.dumps(s)}}},'
                         for n, g, t, s in devices)
             + "\n            ]\n        };")
    src, n = re.subn(r"var energyData = \{.*?\n        \};", lambda m: block, src, count=1, flags=re.DOTALL)
    assert n == 1
    print(f"  energyData: {len(isos)} days ({isos[0]} .. {isos[-1]}), new-pull days: {len(new_days)}")
    return src

def merge_issues(src, path):
    mi = re.search(r"var issuesData = (\[.*?\]);", src, re.DOTALL)
    old_issues = json.loads(mi.group(1))
    rows = sheet_rows(path, "Issues")
    ih = [str(h) for h in rows[0]]; ix = {h: i for i, h in enumerate(ih)}
    tta_key = next(h for h in ih if h.startswith("Time to Acknowledge"))
    new_issues = []
    for r in rows[1:]:
        if not r[ix["Devices"]]: continue
        dur = num(r[ix["Duration (minutes)"]])
        new_issues.append({
            "start": str(r[ix["Start"]] or ""), "end": str(r[ix["End"]] or ""),
            "duration": int(dur) if dur is not None else 0,
            "device": str(r[ix["Devices"]]), "status": str(r[ix["Status"]] or ""),
            "type": str(r[ix["Type"]] or ""), "tags": str(r[ix["Tags"]] or ""),
            "tta": str(r[ix[tta_key]] or ""), "action": str(r[ix["Action"]] or ""),
        })
    window_start = min(i["start"] for i in new_issues)
    kept = [i for i in old_issues if i["start"] < window_start]
    issues = sorted(new_issues + kept, key=lambda i: i["start"], reverse=True)
    block = "var issuesData = " + json.dumps(issues, ensure_ascii=False, separators=(",", ":")) + ";"
    src, n = re.subn(r"var issuesData = \[.*?\];", lambda m: block, src, count=1, flags=re.DOTALL)
    assert n == 1
    print(f"  issuesData: {len(issues)} total = {len(kept)} kept (< {window_start}) + {len(new_issues)} new")
    return src

def merge_sensors(src, temp_path, hum_path):
    sblk = re.search(r"/\* GW_SENSOR_DATA_START \*/.*?/\* GW_SENSOR_DATA_END \*/", src, re.DOTALL).group(0)

    def parse_existing(sensor_type):
        m2 = re.search(r'type: "' + sensor_type + r'".*?start: "([^"]+)", stepMin: 60, values: (\[[^\]]*\])', sblk, re.DOTALL)
        start = datetime.strptime(m2.group(1), "%Y-%m-%dT%H:%M:%S")
        vals = json.loads(m2.group(2))
        return {start + timedelta(hours=i): v for i, v in enumerate(vals) if v is not None}

    def read_new(path):
        rows = sheet_rows(path, "diagnostics")
        out = {}
        for r in rows[1:]:
            if r[0] in (None, ""): continue
            v = num(r[1])
            if v is None: continue
            out[datetime.strptime(str(r[0]), "%Y-%m-%d %I:%M:%S %p")] = round(v, 2)
        return out

    def merged(sensor_type, path):
        series = parse_existing(sensor_type)
        series.update(read_new(path))
        ts = sorted(series)
        values, t = [], ts[0]
        while t <= ts[-1]:
            values.append(series.get(t)); t += timedelta(hours=1)
        return ts[0].strftime("%Y-%m-%dT%H:%M:%S"), values

    t_start, t_vals = merged("temperature", temp_path)
    h_start, h_vals = merged("humidity", hum_path)
    js = lambda vals: "[" + ",".join("null" if v is None else str(v) for v in vals) + "]"
    block = (
        "/* GW_SENSOR_DATA_START */\n"
        "      var sensorData = {\n"
        "        sensors: [\n"
        '          { name: "Temperature (F)", location: "", type: "temperature", unit: "\\u00b0F",\n'
        "            spec: { min: 40, max: 75 }, flag: true,\n"
        f'            start: "{t_start}", stepMin: 60, values: {js(t_vals)} }},\n'
        '          { name: "Humidity (%)", location: "", type: "humidity", unit: "% RH",\n'
        "            spec: { max: 59 }, flag: true,\n"
        f'            start: "{h_start}", stepMin: 60, values: {js(h_vals)} }}\n'
        "        ],\n"
        "        isPlaceholder: false\n"
        "      };\n"
        "      /* GW_SENSOR_DATA_END */")
    src, n = re.subn(r"/\* GW_SENSOR_DATA_START \*/.*?/\* GW_SENSOR_DATA_END \*/", lambda m: block, src, count=1, flags=re.DOTALL)
    assert n == 1
    print(f"  sensors: temp from {t_start} ({sum(1 for v in t_vals if v is not None)} pts), "
          f"humidity from {h_start} ({sum(1 for v in h_vals if v is not None)} pts)")
    return src

# ── main ──────────────────────────────────────────────────────────────────────
def arg(flag):
    return os.path.expanduser(sys.argv[sys.argv.index(flag) + 1]) if flag in sys.argv else None

def main():
    d = arg("--dir") or os.path.expanduser("~/Downloads")
    src = open(HTML, encoding="utf-8").read()

    # Explicit paths beat globbing — Downloads often holds same-day exports for
    # OTHER plants (e.g. numbered Baggers = Assemblers). ALWAYS eyeball the
    # detected filenames + device list before trusting a glob match.
    trends = arg("--trends") or newest("Trends_All_*.xlsx", d)
    energy = arg("--energy") or newest("All_devices_energy_calculations*.xlsx", d)
    issues = arg("--issues") or newest("Issues_All_Devices_*.xlsx", d)
    temp   = arg("--temp")   or newest("IFPC*Temp.xlsx", d)
    hum    = arg("--hum")    or newest("IFPC*Humidity.xlsx", d)

    for label, path in [("trends", trends), ("energy", energy), ("issues", issues), ("temp", temp), ("humidity", hum)]:
        print(f"{label}: {os.path.basename(path) if path else '(none found — skipped)'}")

    if trends: src = merge_trends(src, trends)
    if energy: src = merge_energy(src, energy)
    if issues: src = merge_issues(src, issues)
    if temp and hum: src = merge_sensors(src, temp, hum)

    open(HTML, "w", encoding="utf-8").write(src)
    print(f"written: {HTML} ({len(src)} bytes)")

if __name__ == "__main__":
    main()
