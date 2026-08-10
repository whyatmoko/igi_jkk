import json
import math
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import cgi
import io
import urllib.request

import pandas as pd


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6p-wOSp1QP31f8g5CbmLsinCmoHcaR5I-scRqj2qYNWmNLKZKReBg52u9SCKclmU9yGPWJBvLbSQW/pub?gid=0&single=true&output=csv"
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

    direct_days = get_number(row, rule.get("duration_col"))
    if direct_days is not None:
        return direct_days, "kolom durasi"

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
    with urllib.request.urlopen(SHEET_CSV_URL, timeout=45) as response:
        csv_bytes = response.read()
    return pd.read_csv(io.BytesIO(csv_bytes))


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
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self):
        parsed = urlparse(self.path)
        path = parsed.path.strip("/") or "index.html"
        if path not in {"index.html", "app.js", "styles.css"}:
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
        self.serve_static()

    def do_POST(self):
        if urlparse(self.path).path != "/api/upload":
            self.send_error(404)
            return
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length > MAX_UPLOAD_BYTES:
            self.send_json(413, {"error": "Ukuran file terlalu besar."})
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
