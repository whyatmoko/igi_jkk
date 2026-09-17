import json
import math
import time
import threading
from datetime import date, timedelta
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
import cgi
import io
import os
import subprocess
import urllib.request

import pandas as pd


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR
DATA_DIR = BASE_DIR / "data"
PROGRAM_CSV_PATH = DATA_DIR / "sla_program.csv"
PROGRAM_BAT_PATH = BASE_DIR / "tarik_sla_program.bat"
PROGRAM_BAT_RUNNER_PATH = DATA_DIR / "run_tarik_sla_program.cmd"
VALID_OFFICE_CODES = {f"L{index:02d}" for index in range(35)}
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6p-wOSp1QP31f8g5CbmLsinCmoHcaR5I-scRqj2qYNWmNLKZKReBg52u9SCKclmU9yGPWJBvLbSQW/pub?gid=802130436&single=true&output=csv"
SHEET_HTML_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6p-wOSp1QP31f8g5CbmLsinCmoHcaR5I-scRqj2qYNWmNLKZKReBg52u9SCKclmU9yGPWJBvLbSQW/pubhtml/sheet?headers=false&gid=802130436"
PROGRAM_SLA_SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6p-wOSp1QP31f8g5CbmLsinCmoHcaR5I-scRqj2qYNWmNLKZKReBg52u9SCKclmU9yGPWJBvLbSQW/pubhtml/sheet?headers=false&gid=835183209"
PROGRAM_SOURCE_URL = "https://smile2.bpjsketenagakerjaan.go.id/smile/mod_pn/form/pn5053_form_detil_sla.php"
PROGRAM_PULL_DELAY_SECONDS = 2
PULL_STATUS_LOCK = threading.Lock()
PULL_STATUS = {
    "running": False,
    "current": "-",
    "processed": 0,
    "total": 0,
    "success": 0,
    "failed": 0,
    "error": "",
    "hasData": False,
    "message": "Belum ada proses tarik data.",
}
INDONESIA_HOLIDAYS = {
    "2026-01-01",
    "2026-01-16",
    "2026-02-16",
    "2026-02-17",
    "2026-03-18",
    "2026-03-19",
    "2026-03-20",
    "2026-03-21",
    "2026-03-22",
    "2026-03-23",
    "2026-03-24",
    "2026-04-03",
    "2026-04-05",
    "2026-05-01",
    "2026-05-14",
    "2026-05-15",
    "2026-05-27",
    "2026-05-28",
    "2026-05-31",
    "2026-06-01",
    "2026-06-16",
    "2026-08-17",
    "2026-08-25",
    "2026-12-24",
    "2026-12-25",
}

RULES = {
    "pemeriksaan": {
        "duration_col": "lama_pemeriksaan",
        "sla_col": "sla_pemeriksaan",
        "start_col": "tgl_submit_invoice",
        "end_col": "tgl_dokumen_lengkap",
        "limit": 7,
        "watch_start": 5,
        "label": "Pemeriksaan",
    },
    "verifikasi": {
        "duration_col": "lama_verifikasi",
        "sla_col": "sla_verifikasi",
        "start_col": "tgl_dokumen_lengkap",
        "end_col": "tgl_approval_penetapan",
        "limit": 10,
        "watch_start": 7,
        "label": "Verifikasi",
    },
    "pembayaran": {
        "duration_col": "lama_pembayaran",
        "sla_col": "sla_pembayaran",
        "start_col": "tgl_approval_penetapan",
        "end_col": "tgl_siap_bayar",
        "limit": 7,
        "watch_start": 5,
        "label": "Pembayaran",
    },
}


def as_jsonable(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        try:
            return value.item()
        except ValueError:
            pass
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def get_number(row, col):
    if not col:
        return None
    value = row.get(col)
    if value is None or pd.isna(value):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_sla(value):
    if value is None or pd.isna(value):
        return ""
    return str(value).strip().upper()


def date_key(value):
    return value.strftime("%Y-%m-%d")


def is_working_day(value):
    return value.weekday() < 5 and date_key(value) not in INDONESIA_HOLIDAYS


def next_working_day(value):
    cursor = value
    while not is_working_day(cursor):
        cursor = cursor + timedelta(days=1)
    return cursor


def business_days_inclusive(start, end):
    if start is None or end is None:
        return None
    first_day = next_working_day(start)
    if end < first_day:
        return 0
    cursor = first_day
    days = 0
    while cursor <= end:
        if is_working_day(cursor):
            days += 1
        cursor = cursor + timedelta(days=1)
    return days


def get_duration_days(row, rule, mode):
    direct_days = get_number(row, rule.get("duration_col"))
    if direct_days is not None:
        return direct_days, "kolom durasi"

    today = pd.Timestamp(date.today())

    start_col = rule.get("start_col")
    end_col = rule.get("end_col")
    start = pd.to_datetime(row.get(start_col), errors="coerce") if start_col else None
    end = pd.to_datetime(row.get(end_col), errors="coerce") if end_col else None
    if not pd.isna(start):
        if pd.isna(end) and mode == "running":
            end = today
        if not pd.isna(end):
            days = business_days_inclusive(start.normalize().date(), end.normalize().date())
            return float(days), "hari kerja"

    if pd.isna(start) or pd.isna(end):
        return None, "kolom SLA"
    days = business_days_inclusive(start.normalize().date(), end.normalize().date())
    return float(days), "hari kerja"


def classify_duration(days, rule):
    if days is None:
        return {
            "status": "KOSONG",
            "statusLabel": "Data kosong",
            "severity": 0,
            "bucket": "Data kosong",
        }
    if days > rule["limit"]:
        return {
            "status": "OVER",
            "statusLabel": "Over SLA",
            "severity": 3,
            "bucket": f">{rule['limit']} hari",
        }
    if days == rule["limit"]:
        return {
            "status": "BATAS",
            "statusLabel": "Batas SLA",
            "severity": 2,
            "bucket": f"{int(days)} hari",
        }
    if days >= rule["watch_start"]:
        return {
            "status": "WARNING",
            "statusLabel": "Mendekati SLA",
            "severity": 1,
            "bucket": f"{int(days)} hari",
        }
    return {
        "status": "AMAN",
        "statusLabel": "Aman",
        "severity": 0,
        "bucket": "Aman",
    }


def classify_with_sla(days, rule, existing_sla, mode):
    by_duration = classify_duration(days, rule)
    if mode == "running":
        return by_duration
    if "OVER" in existing_sla:
        return {
            **by_duration,
            "status": "OVER",
            "statusLabel": "Over SLA",
            "severity": 3,
            "bucket": f">{rule['limit']} hari",
        }
    if "SESUAI" in existing_sla:
        return {
            **by_duration,
            "status": "AMAN",
            "statusLabel": "Sesuai SLA",
            "severity": 0,
            "bucket": "Aman",
        }
    return by_duration


def priority_sort_key(item):
    days = item.get("days")
    limit = item.get("limit")
    if days is None or limit is None:
        return (9, 999, 0, item["processLabel"], item["kode_klaim"])
    try:
        days_value = float(days)
        limit_value = float(limit)
    except (TypeError, ValueError):
        return (9, 999, 0, item["processLabel"], item["kode_klaim"])
    if days_value > limit_value:
        return (0, 0, -days_value, item["processLabel"], item["kode_klaim"])
    return (1, limit_value - days_value, -days_value, item["processLabel"], item["kode_klaim"])


def load_workbook(file_bytes, filename):
    suffix = Path(filename).suffix.lower()
    buffer = io.BytesIO(file_bytes)
    if suffix in [".xlsx", ".xls"]:
        return pd.read_excel(buffer)
    if suffix == ".csv":
        return pd.read_csv(buffer)
    raise ValueError("Format file belum didukung. Gunakan .xlsx, .xls, atau .csv.")


def load_published_sheet():
    request = urllib.request.Request(SHEET_HTML_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        html_bytes = response.read()
    frame = parse_html_table(html_bytes)
    first_col = str(frame.columns[0]).strip() if len(frame.columns) else ""
    if first_col.isdigit():
        frame = frame.drop(columns=[frame.columns[0]])
    return frame


def load_program_sla_sheet():
    request = urllib.request.Request(PROGRAM_SLA_SHEET_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        html_bytes = response.read()
    frame = parse_html_table(html_bytes)
    first_col = str(frame.columns[0]).strip() if len(frame.columns) else ""
    if first_col.isdigit():
        frame = frame.drop(columns=[frame.columns[0]])
    return frame


def program_csv_payload(df, file_name="sla_program.csv", last_modified=None):
    df = df.fillna("")
    records = [
        {str(column): as_jsonable(value) for column, value in row.items()}
        for row in df.to_dict(orient="records")
    ]
    if last_modified is None and PROGRAM_CSV_PATH.exists():
        last_modified = date.fromtimestamp(PROGRAM_CSV_PATH.stat().st_mtime).isoformat()
    return {
        "columns": [str(column).strip() for column in df.columns],
        "records": records,
        "rowCount": int(len(records)),
        "fileName": file_name,
        "lastModified": last_modified,
    }


def load_program_csv():
    office_files = sorted(DATA_DIR.glob("L[0-9][0-9].csv"))
    if office_files:
        frames = [pd.read_csv(file_path, dtype=str, keep_default_na=False) for file_path in office_files]
        df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        last_modified = max(date.fromtimestamp(file_path.stat().st_mtime).isoformat() for file_path in office_files)
        return program_csv_payload(df, f"{len(office_files)} file cabang SLA Program", last_modified)
    if not PROGRAM_CSV_PATH.exists():
        raise FileNotFoundError("File CSV lokal belum ada. Jalankan modul tarik data manual terlebih dahulu.")
    df = pd.read_csv(PROGRAM_CSV_PATH, dtype=str, keep_default_na=False)
    return program_csv_payload(df)


def kantor_codes():
    return [f"L{index:02d}" for index in range(34, -1, -1)]


def launch_sla_program_bat(selected_codes):
    DATA_DIR.mkdir(exist_ok=True)
    codes_arg = ",".join(selected_codes)
    runner_lines = [
        "@echo off",
        f'cd /d "{BASE_DIR}"',
    ]
    if codes_arg:
        runner_lines.append(f'call "{PROGRAM_BAT_PATH}" "{codes_arg}"')
    else:
        runner_lines.append(f'call "{PROGRAM_BAT_PATH}"')
    PROGRAM_BAT_RUNNER_PATH.write_text("\r\n".join(runner_lines) + "\r\n", encoding="utf-8")
    creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    subprocess.Popen(
        ["cmd.exe", "/k", str(PROGRAM_BAT_RUNNER_PATH)],
        cwd=str(BASE_DIR),
        creationflags=creationflags,
    )
    return PROGRAM_BAT_RUNNER_PATH


def set_pull_status(**updates):
    with PULL_STATUS_LOCK:
        PULL_STATUS.update(updates)


def get_pull_status():
    with PULL_STATUS_LOCK:
        return dict(PULL_STATUS)


def flatten_columns(columns):
    clean_columns = []
    for column in columns:
        if isinstance(column, tuple):
            parts = [str(part).strip() for part in column if str(part).strip() and not str(part).startswith("Unnamed")]
            clean_columns.append("_".join(parts) if parts else "kolom")
        else:
            clean_columns.append(str(column).strip())
    return clean_columns


class SimpleTableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self._table_depth = 0
        self._in_row = False
        self._in_cell = False
        self._current_table = []
        self._current_row = []
        self._current_cell = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == "table":
            self._table_depth += 1
            if self._table_depth == 1:
                self._current_table = []
        elif self._table_depth and tag == "tr":
            self._in_row = True
            self._current_row = []
        elif self._table_depth and tag in {"td", "th"}:
            self._in_cell = True
            self._current_cell = []

    def handle_data(self, data):
        if self._in_cell:
            self._current_cell.append(data)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self._table_depth and tag in {"td", "th"} and self._in_cell:
            text = " ".join("".join(self._current_cell).split())
            self._current_row.append(text)
            self._in_cell = False
            self._current_cell = []
        elif self._table_depth and tag == "tr" and self._in_row:
            if any(cell for cell in self._current_row):
                self._current_table.append(self._current_row)
            self._in_row = False
            self._current_row = []
        elif tag == "table" and self._table_depth:
            self._table_depth -= 1
            if self._table_depth == 0 and self._current_table:
                self.tables.append(self._current_table)
                self._current_table = []


def unique_columns(columns):
    seen = {}
    unique = []
    for index, column in enumerate(columns, start=1):
        name = str(column).strip() or f"kolom_{index}"
        count = seen.get(name, 0)
        seen[name] = count + 1
        unique.append(name if count == 0 else f"{name}_{count + 1}")
    return unique


def table_to_frame(table):
    rows = [row for row in table if any(cell for cell in row)]
    if len(rows) < 2:
        raise ValueError("Tabel tidak memiliki baris data.")
    width = max(len(row) for row in rows)
    padded = [row + [""] * (width - len(row)) for row in rows]
    headers = unique_columns(padded[0])
    return pd.DataFrame(padded[1:], columns=headers).astype(str)


def parse_html_table(raw):
    html = raw.decode("utf-8", errors="ignore")
    lowered = html.lower()
    if "password" in lowered and ("login" in lowered or "username" in lowered or "user id" in lowered):
        raise ValueError("Respons terlihat sebagai halaman login, bukan tabel data.")
    parser = SimpleTableParser()
    parser.feed(html)
    if not parser.tables:
        raise ValueError("Tidak ada tabel data pada respons.")
    return max((table_to_frame(table) for table in parser.tables), key=lambda frame: frame.shape[0] * max(frame.shape[1], 1))


def fetch_program_table(kdktr):
    query = urlencode({"kdktr": kdktr, "tgl1": "", "tgl2": ""})
    url = f"{PROGRAM_SOURCE_URL}?{query}"
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "SLA-Monitoring-Local/1.0",
            "Accept": "text/html,application/xhtml+xml,application/xml,text/csv,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
        content_type = response.headers.get("Content-Type", "")
    if "csv" in content_type.lower():
        frame = pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False)
    else:
        frame = parse_html_table(raw)
    frame.columns = flatten_columns(frame.columns)
    frame.insert(0, "kdktr_source", kdktr)
    frame.insert(1, "tanggal_tarik_data", date.today().isoformat())
    return frame


def pull_program_source():
    frames = []
    errors = []
    codes = kantor_codes()
    set_pull_status(
        running=True,
        current="-",
        processed=0,
        total=len(codes),
        success=0,
        failed=0,
        error="",
        hasData=False,
        message="Mulai menarik data dari L34 ke L00.",
    )
    for index, kdktr in enumerate(codes):
        set_pull_status(
            current=kdktr,
            processed=index,
            message=f"Sedang menarik data {kdktr}.",
        )
        try:
            frame = fetch_program_table(kdktr)
            if not frame.empty:
                frames.append(frame)
            set_pull_status(
                processed=index + 1,
                success=len(frames),
                failed=len(errors),
                message=f"{kdktr} selesai diproses.",
            )
        except Exception as exc:
            errors.append({"kdktr": kdktr, "error": str(exc)})
            set_pull_status(
                processed=index + 1,
                success=len(frames),
                failed=len(errors),
                message=f"{kdktr} gagal diproses.",
            )
        if index < len(codes) - 1:
            next_code = codes[index + 1]
            set_pull_status(
                current=next_code,
                message=f"Jeda {PROGRAM_PULL_DELAY_SECONDS} detik sebelum menarik {next_code}.",
            )
            time.sleep(PROGRAM_PULL_DELAY_SECONDS)
    if not frames:
        detail = errors[0]["error"] if errors else "Tidak ada data."
        set_pull_status(
            running=False,
            current="-",
            error=f"Gagal menarik data seluruh kantor. Detail awal: {detail}",
            hasData=False,
            message="Tarik data selesai, tetapi tidak ada data yang berhasil diambil.",
        )
        raise RuntimeError(f"Gagal menarik data seluruh kantor. Detail awal: {detail}")
    df = pd.concat(frames, ignore_index=True, sort=False).fillna("")
    DATA_DIR.mkdir(exist_ok=True)
    df.to_csv(PROGRAM_CSV_PATH, index=False, encoding="utf-8-sig")
    payload = program_csv_payload(df)
    payload["pullMeta"] = {
        "requested": len(kantor_codes()),
        "success": len(frames),
        "failed": len(errors),
        "errors": errors[:10],
    }
    set_pull_status(
        running=False,
        current="-",
        processed=len(codes),
        success=len(frames),
        failed=len(errors),
        error="",
        hasData=True,
        message="Tarik data selesai.",
    )
    return payload


def run_program_pull_job():
    try:
        pull_program_source()
    except Exception as exc:
        current = get_pull_status()
        set_pull_status(
            running=False,
            error=str(exc),
            hasData=False,
            message=current.get("message") or "Tarik data gagal.",
        )


def start_program_pull_job():
    status = get_pull_status()
    if status.get("running"):
        return {"started": False, "status": status}
    thread = threading.Thread(target=run_program_pull_job, daemon=True)
    thread.start()
    time.sleep(0.1)
    return {"started": True, "status": get_pull_status()}


def process_dataframe(df, mode="final"):
    df.columns = [str(col).strip() for col in df.columns]
    required = ["kode_klaim"]
    missing = [col for col in required if col not in df.columns]
    missing_rule_inputs = []
    for rule in RULES.values():
        has_duration = rule["duration_col"] in df.columns
        has_sla = rule["sla_col"] in df.columns
        has_dates = rule["start_col"] in df.columns and rule["end_col"] in df.columns
        if not (has_duration or has_sla or has_dates):
            missing_rule_inputs.append(f"{rule['label']} ({rule['duration_col']} atau {rule['sla_col']})")
    if missing:
        raise ValueError("Kolom wajib tidak ditemukan: " + ", ".join(missing))
    if missing_rule_inputs:
        raise ValueError("Input SLA tidak lengkap: " + ", ".join(missing_rule_inputs))

    records = []
    process_items = []
    last_update_data = None
    if "tanggal_tarik_data" in df.columns:
        update_dates = pd.to_datetime(df["tanggal_tarik_data"], errors="coerce").dropna()
        if not update_dates.empty:
            last_update_data = as_jsonable(update_dates.max().normalize())
        else:
            update_values = [as_jsonable(value) for value in df["tanggal_tarik_data"].dropna().unique()]
            last_update_data = update_values[0] if update_values else None
    last_submit_invoice = None
    if "tgl_submit_invoice" in df.columns:
        submit_dates = pd.to_datetime(df["tgl_submit_invoice"], errors="coerce").dropna()
        if not submit_dates.empty:
            last_submit_invoice = as_jsonable(submit_dates.max().normalize())
    summary = {
        "totalClaims": int(len(df)),
        "overall": {"over": 0, "warning": 0, "safe": 0, "empty": 0},
        "process": {},
        "buckets": {},
    }

    for key, rule in RULES.items():
        summary["process"][key] = {
            "label": rule["label"],
            "limit": rule["limit"],
            "watchStart": rule["watch_start"],
            "over": 0,
            "warning": 0,
            "boundary": 0,
            "safe": 0,
            "empty": 0,
        }
        summary["buckets"][key] = {}

    for idx, row in df.iterrows():
        kode_klaim = str(as_jsonable(row.get("kode_klaim")) or "").strip() or f"ROW-{idx + 2}"
        wilayah = as_jsonable(row.get("nama_wilayah"))
        kode_kantor = as_jsonable(row.get("kode_kantor"))
        kantor = as_jsonable(row.get("nama_kantor"))
        kantor_tk = as_jsonable(row.get("nama_kantor_tk"))
        nama_tk = as_jsonable(row.get("nama_tk"))
        perusahaan = as_jsonable(row.get("nama_perusahaan")) or as_jsonable(row.get("nama_faskes_detil"))
        status_klaim = as_jsonable(row.get("status_klaim")) or ("BAYAR" if as_jsonable(row.get("flag_bayar")) == 1 else as_jsonable(row.get("flag_bayar")))
        flag_bayar = as_jsonable(row.get("flag_bayar"))
        tgl_rekam = as_jsonable(row.get("tgl_rekam"))
        jenis_penetapan = as_jsonable(row.get("jenis_penetapan"))
        nama_faskes = as_jsonable(row.get("nama_faskes_detil"))

        checks = {}
        max_severity = 0
        open_processes = []

        for key, rule in RULES.items():
            existing_sla = normalize_sla(row.get(rule["sla_col"]))
            days, day_source = get_duration_days(row, rule, mode)
            classification = classify_with_sla(days, rule, existing_sla, mode)
            mismatch = bool(existing_sla) and (
                ("OVER" in existing_sla and classification["status"] != "OVER")
                or ("OVER" not in existing_sla and classification["status"] == "OVER")
            )
            check = {
                "key": key,
                "label": rule["label"],
                "days": None if days is None else int(days) if days.is_integer() else days,
                "limit": rule["limit"],
                "watchStart": rule["watch_start"],
                "slaColumn": existing_sla,
                "daySource": day_source,
                "mismatch": mismatch,
                **classification,
            }
            checks[key] = check
            max_severity = max(max_severity, classification["severity"])
            if classification["severity"] > 0:
                open_processes.append(rule["label"])

            proc_summary = summary["process"][key]
            if classification["status"] == "OVER":
                proc_summary["over"] += 1
            elif classification["status"] == "BATAS":
                proc_summary["boundary"] += 1
                proc_summary["warning"] += 1
            elif classification["status"] == "WARNING":
                proc_summary["warning"] += 1
            elif classification["status"] == "AMAN":
                proc_summary["safe"] += 1
            else:
                proc_summary["empty"] += 1

            bucket = classification["bucket"]
            summary["buckets"][key][bucket] = summary["buckets"][key].get(bucket, 0) + 1
            process_items.append({
                "kode_klaim": kode_klaim,
                "nama_wilayah": wilayah,
                "kode_kantor": kode_kantor,
                "nama_kantor": kantor,
                "nama_tk": nama_tk,
                "process": key,
                "processLabel": rule["label"],
                "days": check["days"],
                "limit": rule["limit"],
                "status": classification["status"],
                "statusLabel": classification["statusLabel"],
                "severity": classification["severity"],
                "bucket": bucket,
                "slaColumn": existing_sla,
                "mismatch": mismatch,
                "flag_bayar": flag_bayar,
            })

        if max_severity >= 3:
            overall_status = "OVER"
            summary["overall"]["over"] += 1
        elif max_severity >= 1:
            overall_status = "WARNING"
            summary["overall"]["warning"] += 1
        else:
            overall_status = "AMAN"
            summary["overall"]["safe"] += 1

        records.append({
            "kode_klaim": kode_klaim,
            "nama_wilayah": wilayah,
            "kode_kantor": kode_kantor,
            "nama_kantor": kantor,
            "nama_kantor_tk": kantor_tk,
            "nama_tk": nama_tk,
            "nama_perusahaan": perusahaan,
            "jenis_penetapan": jenis_penetapan,
            "nama_faskes_detil": nama_faskes,
            "status_klaim": status_klaim,
            "flag_bayar": flag_bayar,
            "tgl_rekam": tgl_rekam,
            "tanggal_tarik_data": as_jsonable(row.get("tanggal_tarik_data")),
            "tgl_submit_invoice": as_jsonable(row.get("tgl_submit_invoice")),
            "tgl_dokumen_lengkap": as_jsonable(row.get("tgl_dokumen_lengkap")),
            "tgl_approval_penetapan": as_jsonable(row.get("tgl_approval_penetapan")),
            "tgl_siap_bayar": as_jsonable(row.get("tgl_siap_bayar")),
            "overallStatus": overall_status,
            "priorityScore": max_severity,
            "openProcesses": ", ".join(open_processes) if open_processes else "-",
            "checks": checks,
        })

    process_items.sort(key=priority_sort_key)
    records.sort(key=lambda item: (-item["priorityScore"], item["kode_klaim"]))

    return {
        "columns": list(df.columns),
        "records": records,
        "processItems": process_items,
        "summary": summary,
        "mode": mode,
        "lastUpdateData": last_update_data,
        "lastSubmitInvoice": last_submit_invoice,
    }


class AppHandler(BaseHTTPRequestHandler):
    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def serve_static(self):
        parsed = urlparse(self.path)
        path = parsed.path.strip("/") or "index.html"
        if path not in {"index.html", "sla-program.html", "app.js", "sla-program.js", "smile-table-scraper.js", "smile-loop-scraper.js", "smile-open-test-scraper.js", "styles.css", "tarik_sla_program.bat"}:
            self.send_error(404)
            return
        target = (STATIC_DIR / path).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.exists():
            self.send_error(404)
            return
        content_type = "text/html; charset=utf-8"
        if target.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif target.suffix == ".js":
            content_type = "application/javascript; charset=utf-8"
        elif target.suffix == ".bat":
            content_type = "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/sheet":
            try:
                mode = "running"
                query = dict(part.split("=", 1) for part in parsed.query.split("&") if "=" in part)
                requested_mode = str(query.get("mode") or "running").strip().lower()
                if requested_mode in {"final", "running"}:
                    mode = requested_mode
                df = load_published_sheet()
                result = process_dataframe(df, mode)
                result["fileName"] = "Google Spreadsheet SLA"
                result["sourceUrl"] = SHEET_CSV_URL
                self.send_json(200, result)
            except Exception as exc:
                self.send_json(400, {"error": str(exc)})
            return
        if parsed.path == "/api/sla-program-csv":
            try:
                self.send_json(200, load_program_csv())
            except Exception as exc:
                self.send_json(404, {"error": str(exc)})
            return
        if parsed.path == "/api/sla-program-sheet":
            try:
                result = program_csv_payload(load_program_sla_sheet(), "Google Spreadsheet SLA Program")
                result["sourceUrl"] = PROGRAM_SLA_SHEET_URL
                self.send_json(200, result)
            except Exception as exc:
                self.send_json(400, {"error": str(exc)})
            return
        if parsed.path == "/api/sla-program-pull-status":
            self.send_json(200, get_pull_status())
            return
        self.serve_static()

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in {"/api/upload", "/api/sla-program-upload", "/api/sla-program-pull", "/api/sla-program-table-csv", "/api/sla-program-office-csv", "/api/run-sla-program-bat"}:
            self.send_error(404)
            return
        if path == "/api/run-sla-program-bat":
            try:
                if not PROGRAM_BAT_PATH.exists():
                    raise FileNotFoundError("File BAT tarik data belum ditemukan.")
                query = parse_qs(urlparse(self.path).query)
                raw_codes = str((query.get("codes") or [""])[0]).upper().strip()
                selected_codes = []
                if raw_codes:
                    selected_codes = [
                        code.strip()
                        for code in raw_codes.split(",")
                        if code.strip() in VALID_OFFICE_CODES
                    ]
                    if not selected_codes:
                        raise ValueError("Kode kantor pilihan tidak valid.")
                runner_path = launch_sla_program_bat(selected_codes)
                self.send_json(200, {
                    "started": True,
                    "message": "Window tarik data SLA Program sudah dibuka.",
                    "bat": str(PROGRAM_BAT_PATH),
                    "runner": str(runner_path),
                    "codes": selected_codes,
                })
            except Exception as exc:
                self.send_json(400, {"error": str(exc)})
            return
        if path == "/api/sla-program-pull":
            try:
                self.send_json(200, start_program_pull_job())
            except Exception as exc:
                self.send_json(400, {"error": str(exc)})
            return
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length > MAX_UPLOAD_BYTES:
            self.send_json(413, {"error": "Ukuran file terlalu besar."})
            return
        if path == "/api/sla-program-table-csv":
            try:
                raw = self.rfile.read(content_length)
                DATA_DIR.mkdir(exist_ok=True)
                PROGRAM_CSV_PATH.write_bytes(raw)
                df = pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False)
                self.send_json(200, program_csv_payload(df, "sla_program.csv"))
            except Exception as exc:
                self.send_json(400, {"error": str(exc)})
            return
        if path == "/api/sla-program-office-csv":
            try:
                query = parse_qs(urlparse(self.path).query)
                code = str((query.get("code") or [""])[0]).upper().strip()
                valid_codes = {f"L{index:02d}" for index in range(35)}
                if code not in valid_codes:
                    raise ValueError("Kode kantor tidak valid.")
                raw = self.rfile.read(content_length)
                DATA_DIR.mkdir(exist_ok=True)
                office_path = DATA_DIR / f"{code}.csv"
                office_path.write_bytes(raw)
                df = pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False)
                self.send_json(200, {
                    "fileName": office_path.name,
                    "path": str(office_path),
                    "rowCount": int(len(df)),
                    "columns": [str(column) for column in df.columns],
                    "mode": "overwrite",
                })
            except Exception as exc:
                self.send_json(400, {"error": str(exc)})
            return
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": self.headers.get("Content-Type"),
                "CONTENT_LENGTH": str(content_length),
            },
        )
        file_item = form["file"] if "file" in form else None
        if file_item is None or not getattr(file_item, "filename", ""):
            self.send_json(400, {"error": "File belum dipilih."})
            return
        try:
            if path == "/api/sla-program-upload":
                if Path(file_item.filename).suffix.lower() != ".csv":
                    raise ValueError("Format SLA Program harus CSV.")
                file_bytes = file_item.file.read()
                DATA_DIR.mkdir(exist_ok=True)
                PROGRAM_CSV_PATH.write_bytes(file_bytes)
                df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, keep_default_na=False)
                self.send_json(200, program_csv_payload(df, "sla_program.csv"))
                return
            mode = str(form.getvalue("mode") or "final").strip().lower()
            if mode not in {"final", "running"}:
                mode = "final"
            file_bytes = file_item.file.read()
            df = load_workbook(file_bytes, file_item.filename)
            result = process_dataframe(df, mode)
            result["fileName"] = file_item.filename
            self.send_json(200, result)
        except Exception as exc:
            self.send_json(400, {"error": str(exc)})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 8790), AppHandler)
    print("SLA Monitoring running at http://127.0.0.1:8790", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
