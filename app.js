const STORAGE_KEY = "sla-monitoring:last-result";
const DB_NAME = "sla-monitoring-db";
const DB_STORE = "datasets";
const DB_KEY = "last-result";
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6p-wOSp1QP31f8g5CbmLsinCmoHcaR5I-scRqj2qYNWmNLKZKReBg52u9SCKclmU9yGPWJBvLbSQW/pub?gid=0&single=true&output=csv";
const RULES = {
  pemeriksaan: {
    durationCol: "lama_pemeriksaan",
    slaCol: "sla_pemeriksaan",
    startCol: "tgl_submit_invoice",
    endCol: "tgl_dokumen_lengkap",
    limit: 7,
    watchStart: 5,
    label: "Pemeriksaan",
  },
  verifikasi: {
    durationCol: "lama_verifikasi",
    slaCol: "sla_verifikasi",
    startCol: "tgl_dokumen_lengkap",
    endCol: "tgl_approval_penetapan",
    limit: 10,
    watchStart: 7,
    label: "Verifikasi",
  },
  pembayaran: {
    durationCol: "lama_pembayaran",
    slaCol: "sla_pembayaran",
    startCol: "tgl_approval_penetapan",
    endCol: "tgl_siap_bayar",
    limit: 7,
    watchStart: 5,
    label: "Pembayaran",
  },
};

const state = {
  data: null,
  filters: {
    mode: "running",
    branch: "ALL",
    status: "ALL",
    process: "ALL",
    search: "",
  },
  pagination: {
    priorityPage: 1,
    claimPage: 1,
    pageSize: 10,
  },
};

const els = {
  fileInput: document.getElementById("fileInput"),
  refreshSheet: document.getElementById("refreshSheet"),
  notice: document.getElementById("notice"),
  summaryCards: document.getElementById("summaryCards"),
  priorityMeta: document.getElementById("priorityMeta"),
  priorityRows: document.getElementById("priorityRows"),
  priorityPagination: document.getElementById("priorityPagination"),
  recapMeta: document.getElementById("recapMeta"),
  recapRows: document.getElementById("recapRows"),
  claimMeta: document.getElementById("claimMeta"),
  claimList: document.getElementById("claimList"),
  claimPagination: document.getElementById("claimPagination"),
  downloadPriority: document.getElementById("downloadPriority"),
  downloadClaims: document.getElementById("downloadClaims"),
  statusFilter: document.getElementById("statusFilter"),
  branchFilter: document.getElementById("branchFilter"),
  processFilter: document.getElementById("processFilter"),
  searchInput: document.getElementById("searchInput"),
  clearData: document.getElementById("clearData"),
  modeSelect: document.getElementById("modeSelect"),
};

function setNotice(message, type = "") {
  els.notice.className = `notice ${type}`.trim();
  els.notice.innerHTML = message;
}

function getLastUpdateData(data = state.data) {
  if (!data) return null;
  if (data.lastUpdateData) return data.lastUpdateData;
  const values = (data.records || [])
    .map((record) => record.tanggal_tarik_data)
    .filter(Boolean);
  if (!values.length) return null;
  const dated = values
    .map((value) => ({ value, date: parseDateValue(value) }))
    .filter((item) => item.date)
    .sort((a, b) => b.date - a.date);
  return dated[0]?.value || values[0];
}

function formatLastUpdateData(value) {
  if (!value) return "-";
  const date = parseDateValue(value);
  if (!date) return String(value);
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}

function getLastSubmitInvoice(data = state.data) {
  if (!data) return null;
  if (data.lastSubmitInvoice) return data.lastSubmitInvoice;
  const dated = (data.records || [])
    .map((record) => parseDateValue(record.tgl_submit_invoice))
    .filter(Boolean)
    .sort((a, b) => b - a);
  return dated[0] || null;
}

function buildDataNotice(message, data = state.data) {
  const lastUpdate = formatLastUpdateData(getLastUpdateData(data));
  const lastSubmit = formatLastUpdateData(getLastSubmitInvoice(data));
  return `${message}<div class="notice-meta">Last update data: <strong>${escapeHtml(lastUpdate)}</strong> <span>Tanggal data terakhir: <strong>${escapeHtml(lastSubmit)}</strong></span></div>`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("id-ID").format(value || 0);
}

function statusClass(status) {
  if (status === "OVER") return "over";
  if (status === "WARNING") return "warning";
  if (status === "BATAS") return "boundary";
  if (status === "AMAN") return "safe";
  return "";
}

function statusLabel(status) {
  return {
    OVER: "Over SLA",
    WARNING: "Mendekati SLA",
    BATAS: "Batas SLA",
    AMAN: "Aman",
    KOSONG: "Data kosong",
  }[status] || status;
}

function escapeHtml(value) {
  return String(value ?? "-")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderDurationCell(check) {
  const days = check?.days ?? "-";
  const limit = check?.limit ?? "-";
  return `<strong>${escapeHtml(days)}</strong> <span class="muted">/ ${escapeHtml(limit)} hari</span>`;
}

function heatClass(value, isOver = false) {
  if (!value) return "";
  if (isOver) return value >= 50 ? "heat-over-strong" : "heat-over";
  if (value >= 100) return "heat-watch-strong";
  return "heat-watch";
}

function renderHeatCell(value, isOver = false, extraClass = "") {
  const display = value ? formatNumber(value) : "0";
  return `<td class="${[heatClass(value, isOver), extraClass].filter(Boolean).join(" ")}">${display}</td>`;
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const isHtml = text.trim().startsWith("<");
    const detail = isHtml ? "Server mengembalikan halaman HTML, bukan data JSON." : text.slice(0, 180);
    throw new Error(`${fallbackMessage} ${detail}`);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const headers = (rows.shift() || []).map((header) => header.trim());
  const records = rows
    .filter((values) => values.some((value) => value.trim()))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""])));
  return { headers, records };
}

function getValue(row, column) {
  const value = row[column];
  return value === "" || value == null ? null : value;
}

function getNumber(row, column) {
  const raw = getValue(row, column);
  if (raw == null) return null;
  const normalized = String(raw).replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSla(value) {
  return String(value ?? "").trim().toUpperCase();
}

function parseDateValue(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }
  const local = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (local) {
    return new Date(Number(local[3]), Number(local[2]) - 1, Number(local[1]));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function diffDays(start, end) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((end - start) / msPerDay));
}

function getDurationDays(row, rule, mode) {
  const directDays = getNumber(row, rule.durationCol);
  if (directDays != null) return [directDays, "kolom durasi"];

  const start = parseDateValue(getValue(row, rule.startCol));
  let end = parseDateValue(getValue(row, rule.endCol));
  if (!start) return [null, "kolom SLA"];
  if (!end && mode === "running") {
    const today = new Date();
    end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  }
  if (!end) return [null, "kolom SLA"];
  return [diffDays(start, end), "estimasi tanggal"];
}

function classifyDuration(days, rule) {
  if (days == null) {
    return { status: "KOSONG", statusLabel: "Data kosong", severity: 0, bucket: "Data kosong" };
  }
  if (days > rule.limit) {
    return { status: "OVER", statusLabel: "Over SLA", severity: 3, bucket: `>${rule.limit} hari` };
  }
  if (days === rule.limit) {
    return { status: "BATAS", statusLabel: "Batas SLA", severity: 2, bucket: `${Math.trunc(days)} hari` };
  }
  if (days >= rule.watchStart) {
    return { status: "WARNING", statusLabel: "Mendekati SLA", severity: 1, bucket: `${Math.trunc(days)} hari` };
  }
  return { status: "AMAN", statusLabel: "Aman", severity: 0, bucket: "Aman" };
}

function classifyWithSla(days, rule, existingSla, mode) {
  const byDuration = classifyDuration(days, rule);
  if (mode === "running") return byDuration;
  if (existingSla.includes("OVER")) {
    return { ...byDuration, status: "OVER", statusLabel: "Over SLA", severity: 3, bucket: `>${rule.limit} hari` };
  }
  if (existingSla.includes("SESUAI")) {
    return { ...byDuration, status: "AMAN", statusLabel: "Sesuai SLA", severity: 0, bucket: "Aman" };
  }
  return byDuration;
}

function processSheetRows(rows, columns, mode = "running") {
  const records = [];
  const processItems = [];
  const summary = {
    totalClaims: rows.length,
    overall: { over: 0, warning: 0, safe: 0, empty: 0 },
    process: {},
    buckets: {},
  };
  Object.entries(RULES).forEach(([key, rule]) => {
    summary.process[key] = {
      label: rule.label,
      limit: rule.limit,
      watchStart: rule.watchStart,
      over: 0,
      warning: 0,
      boundary: 0,
      safe: 0,
      empty: 0,
    };
    summary.buckets[key] = {};
  });

  rows.forEach((row, index) => {
    const kodeKlaim = String(getValue(row, "kode_klaim") || `ROW-${index + 2}`).trim();
    const wilayah = getValue(row, "nama_wilayah");
    const kodeKantor = getValue(row, "kode_kantor");
    const kantor = getValue(row, "nama_kantor");
    const kantorTk = getValue(row, "nama_kantor_tk");
    const namaTk = getValue(row, "nama_tk");
    const perusahaan = getValue(row, "nama_perusahaan") || getValue(row, "nama_faskes_detil");
    const statusKlaim = getValue(row, "status_klaim") || (getValue(row, "flag_bayar") === "1" ? "BAYAR" : getValue(row, "flag_bayar"));
    const checks = {};
    let maxSeverity = 0;
    const openProcesses = [];

    Object.entries(RULES).forEach(([key, rule]) => {
      const existingSla = normalizeSla(getValue(row, rule.slaCol));
      const [rawDays, daySource] = getDurationDays(row, rule, mode);
      const days = rawDays == null ? null : Number(rawDays);
      const classification = classifyWithSla(days, rule, existingSla, mode);
      const mismatch = Boolean(existingSla) && (
        (existingSla.includes("OVER") && classification.status !== "OVER")
        || (!existingSla.includes("OVER") && classification.status === "OVER")
      );
      const check = {
        key,
        label: rule.label,
        days: days == null ? null : Number.isInteger(days) ? days : Number(days.toFixed(1)),
        limit: rule.limit,
        watchStart: rule.watchStart,
        slaColumn: existingSla,
        daySource,
        mismatch,
        ...classification,
      };
      checks[key] = check;
      maxSeverity = Math.max(maxSeverity, classification.severity);
      if (classification.severity > 0) openProcesses.push(rule.label);

      const procSummary = summary.process[key];
      if (classification.status === "OVER") procSummary.over += 1;
      else if (classification.status === "BATAS") {
        procSummary.boundary += 1;
        procSummary.warning += 1;
      } else if (classification.status === "WARNING") procSummary.warning += 1;
      else if (classification.status === "AMAN") procSummary.safe += 1;
      else procSummary.empty += 1;

      summary.buckets[key][classification.bucket] = (summary.buckets[key][classification.bucket] || 0) + 1;
      processItems.push({
        kode_klaim: kodeKlaim,
        nama_wilayah: wilayah,
        kode_kantor: kodeKantor,
        nama_kantor: kantor,
        nama_tk: namaTk,
        process: key,
        processLabel: rule.label,
        days: check.days,
        limit: rule.limit,
        status: classification.status,
        statusLabel: classification.statusLabel,
        severity: classification.severity,
        bucket: classification.bucket,
        slaColumn: existingSla,
        mismatch,
      });
    });

    let overallStatus = "AMAN";
    if (maxSeverity >= 3) {
      overallStatus = "OVER";
      summary.overall.over += 1;
    } else if (maxSeverity >= 1) {
      overallStatus = "WARNING";
      summary.overall.warning += 1;
    } else {
      summary.overall.safe += 1;
    }

    records.push({
      kode_klaim: kodeKlaim,
      nama_wilayah: wilayah,
      kode_kantor: kodeKantor,
      nama_kantor: kantor,
      nama_kantor_tk: kantorTk,
      nama_tk: namaTk,
      nama_perusahaan: perusahaan,
      jenis_penetapan: getValue(row, "jenis_penetapan"),
      nama_faskes_detil: getValue(row, "nama_faskes_detil"),
      status_klaim: statusKlaim,
      tgl_rekam: getValue(row, "tgl_rekam"),
      tanggal_tarik_data: getValue(row, "tanggal_tarik_data"),
      tgl_submit_invoice: getValue(row, "tgl_submit_invoice"),
      tgl_dokumen_lengkap: getValue(row, "tgl_dokumen_lengkap"),
      tgl_approval_penetapan: getValue(row, "tgl_approval_penetapan"),
      tgl_siap_bayar: getValue(row, "tgl_siap_bayar"),
      overallStatus,
      priorityScore: maxSeverity,
      openProcesses: openProcesses.length ? openProcesses.join(", ") : "-",
      checks,
    });
  });

  processItems.sort((a, b) => b.severity - a.severity || a.processLabel.localeCompare(b.processLabel) || a.kode_klaim.localeCompare(b.kode_klaim));
  records.sort((a, b) => b.priorityScore - a.priorityScore || a.kode_klaim.localeCompare(b.kode_klaim));
  const payload = { columns, records, processItems, summary, mode };
  payload.lastUpdateData = getLastUpdateData(payload);
  payload.lastSubmitInvoice = getLastSubmitInvoice(payload);
  return payload;
}

async function fetchPublishedSheetData() {
  const response = await fetch(SHEET_CSV_URL);
  if (!response.ok) throw new Error("Gagal mengambil CSV dari Google Spreadsheet.");
  const text = await response.text();
  if (text.trim().startsWith("<")) {
    throw new Error("Google Spreadsheet belum mengembalikan format CSV.");
  }
  const { headers, records } = parseCsv(text);
  const payload = processSheetRows(records, headers, state.filters.mode);
  payload.fileName = "Google Spreadsheet SLA";
  payload.sourceUrl = SHEET_CSV_URL;
  payload.sourceMode = "browser";
  return payload;
}

function downloadExcelFile(fileName, sheetName, headers, rows) {
  const tableRows = [
    `<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`,
    ...rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`),
  ].join("");
  const html = `
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          table { border-collapse: collapse; font-family: Arial, sans-serif; font-size: 12px; }
          th, td { border: 1px solid #cbd5e1; padding: 6px 8px; }
          th { background: #172033; color: white; }
        </style>
      </head>
      <body>
        <table>${tableRows}</table>
      </body>
    </html>
  `;
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}

function exportPriorityRows() {
  if (!state.data) {
    setNotice("Belum ada data untuk di-download. Upload file terlebih dahulu.", "error");
    return;
  }
  const rows = filteredProcessItems()
    .filter((item) => item.severity > 0 || state.filters.status !== "ALL")
    .map((item) => [
      item.kode_klaim,
      item.nama_kantor || "-",
      item.processLabel,
      item.days ?? "-",
      item.limit,
      item.statusLabel,
    ]);
  downloadExcelFile("daftar-prioritas-sla", "Daftar Prioritas", ["Kode Klaim", "Kantor", "Proses", "Hari", "Batas", "Status"], rows);
}

function exportClaimRows() {
  if (!state.data) {
    setNotice("Belum ada data untuk di-download. Upload file terlebih dahulu.", "error");
    return;
  }
  const rows = filteredClaims().map((claim) => [
    claim.kode_klaim,
    claim.nama_kantor || "-",
    claim.nama_tk || "-",
    claim.nama_perusahaan || "-",
    claim.status_klaim || "-",
    statusLabel(claim.overallStatus),
    claim.checks.pemeriksaan?.days ?? "-",
    claim.checks.pemeriksaan?.statusLabel ?? "-",
    claim.checks.verifikasi?.days ?? "-",
    claim.checks.verifikasi?.statusLabel ?? "-",
    claim.checks.pembayaran?.days ?? "-",
    claim.checks.pembayaran?.statusLabel ?? "-",
  ]);
  downloadExcelFile(
    "monitoring-kode-klaim",
    "Monitoring Klaim",
    ["Kode Klaim", "Kantor", "Nama TK", "Faskes / Perusahaan", "Status Klaim", "Overall", "Pemeriksaan Hari", "Status Pemeriksaan", "Verifikasi Hari", "Status Verifikasi", "Pembayaran Hari", "Status Pembayaran"],
    rows
  );
}

function resetPages() {
  state.pagination.priorityPage = 1;
  state.pagination.claimPage = 1;
}

function paginateRows(rows, page) {
  const pageSize = state.pagination.pageSize;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    currentPage,
    totalPages,
    start,
    end: Math.min(start + pageSize, rows.length),
    totalRows: rows.length,
  };
}

function renderPagination(target, pageInfo, pageKey) {
  if (!target) return;
  const disabledPrev = pageInfo.currentPage <= 1 ? "disabled" : "";
  const disabledNext = pageInfo.currentPage >= pageInfo.totalPages ? "disabled" : "";
  target.innerHTML = `
    <div class="page-status">
      Baris ${formatNumber(pageInfo.totalRows ? pageInfo.start + 1 : 0)}-${formatNumber(pageInfo.end)}
      dari ${formatNumber(pageInfo.totalRows)}
    </div>
    <div class="page-controls">
      <label>
        Baris
        <select data-page-size>
          <option value="10" ${state.pagination.pageSize === 10 ? "selected" : ""}>10</option>
          <option value="50" ${state.pagination.pageSize === 50 ? "selected" : ""}>50</option>
          <option value="100" ${state.pagination.pageSize === 100 ? "selected" : ""}>100</option>
          <option value="250" ${state.pagination.pageSize === 250 ? "selected" : ""}>250</option>
          <option value="500" ${state.pagination.pageSize === 500 ? "selected" : ""}>500</option>
        </select>
      </label>
      <button type="button" data-page="${pageKey}" data-action="prev" ${disabledPrev}>Sebelumnya</button>
      <span>Halaman ${formatNumber(pageInfo.currentPage)} / ${formatNumber(pageInfo.totalPages)}</span>
      <button type="button" data-page="${pageKey}" data-action="next" ${disabledNext}>Berikutnya</button>
    </div>
  `;
}

function getBranchOptions() {
  const branches = new Set();
  (state.data?.records || []).forEach((claim) => {
    if (claim.nama_kantor) branches.add(claim.nama_kantor);
  });
  return Array.from(branches).sort((a, b) => a.localeCompare(b));
}

function renderBranchOptions() {
  if (!els.branchFilter) return;
  const current = state.filters.branch;
  const branches = getBranchOptions();
  els.branchFilter.innerHTML = [
    `<option value="ALL">Semua cabang</option>`,
    ...branches.map((branch) => `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`),
  ].join("");
  state.filters.branch = current !== "ALL" && branches.includes(current) ? current : "ALL";
  els.branchFilter.value = state.filters.branch;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveData(data) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(data, DB_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      fileName: data.fileName,
      loadedAt: data.loadedAt,
      totalClaims: data.summary?.totalClaims || 0,
      storage: "indexedDB",
    })
  );
}

async function loadData() {
  try {
    const db = await openDatabase();
    const data = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const request = tx.objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (data) return data;
  } catch {
    return null;
  }

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const legacy = JSON.parse(raw);
    if (legacy.records) {
      await saveData(legacy);
      return legacy;
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return null;
}

async function clearStoredData() {
  localStorage.removeItem(STORAGE_KEY);
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(DB_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Browser storage may be unavailable in private mode.
  }
}

async function uploadFile(file) {
  const form = new FormData();
  form.append("file", file);
  form.append("mode", state.filters.mode);
  setNotice("Sedang membaca dan memecah data SLA...", "");
  const response = await fetch("/api/upload", {
    method: "POST",
    body: form,
  });
  const payload = await readJsonResponse(response, "Upload manual hanya tersedia saat aplikasi dijalankan lokal dengan server.");
  if (!response.ok) {
    throw new Error(payload.error || "Gagal membaca file.");
  }
  payload.loadedAt = new Date().toISOString();
  state.data = payload;
  resetPages();
  await saveData(payload);
  const modeLabel = payload.mode === "running" ? "Bulan Berjalan" : "Data Final/Bayar";
  setNotice(buildDataNotice(`Data <strong>${payload.fileName}</strong> berhasil diproses dengan mode <strong>${modeLabel}</strong> dan disimpan lokal di browser.`, payload), "success");
  render();
}

async function refreshFromSheet() {
  setNotice("Sedang mengambil data dari Google Spreadsheet...", "");
  let payload;
  try {
    const response = await fetch(`/api/sheet?mode=${encodeURIComponent(state.filters.mode)}`);
    payload = await readJsonResponse(response, "Gagal membaca respons Spreadsheet.");
    if (!response.ok) {
      throw new Error(payload.error || "Gagal mengambil data dari Spreadsheet.");
    }
  } catch {
    payload = await fetchPublishedSheetData();
  }
  payload.loadedAt = new Date().toISOString();
  state.data = payload;
  resetPages();
  await saveData(payload);
  const modeLabel = payload.mode === "running" ? "Bulan Berjalan" : "Data Final/Bayar";
  setNotice(buildDataNotice(`Data <strong>${payload.fileName}</strong> berhasil diambil dari Spreadsheet dengan mode <strong>${modeLabel}</strong> dan disimpan lokal di browser.`, payload), "success");
  render();
}

function renderSummary() {
  if (!state.data?.summary) {
    els.summaryCards.innerHTML = `
      <article class="card"><span>Total Klaim</span><strong>0</strong></article>
      <article class="card"><span>Over SLA</span><strong>0</strong></article>
      <article class="card"><span>Mendekati SLA</span><strong>0</strong></article>
      <article class="card"><span>Aman</span><strong>0</strong></article>
    `;
    return;
  }
  const claims = filteredClaims();
  const totals = claims.reduce(
    (acc, claim) => {
      acc.total += 1;
      if (claim.overallStatus === "OVER") acc.over += 1;
      else if (claim.overallStatus === "WARNING") acc.warning += 1;
      else acc.safe += 1;
      return acc;
    },
    { total: 0, over: 0, warning: 0, safe: 0 }
  );
  els.summaryCards.innerHTML = `
    <article class="card"><span>Total Klaim</span><strong>${formatNumber(totals.total)}</strong></article>
    <article class="card"><span>Over SLA</span><strong>${formatNumber(totals.over)}</strong></article>
    <article class="card"><span>Mendekati SLA</span><strong>${formatNumber(totals.warning)}</strong></article>
    <article class="card"><span>Aman</span><strong>${formatNumber(totals.safe)}</strong></article>
  `;
}

function matchesSearch(item) {
  const q = state.filters.search.trim().toLowerCase();
  if (!q) return true;
  return [
    item.kode_klaim,
    item.nama_kantor,
    item.nama_kantor_tk,
    item.nama_tk,
    item.nama_perusahaan,
    item.processLabel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function filteredProcessItems() {
  const items = state.data?.processItems || [];
  return items.filter((item) => {
    if (state.filters.branch !== "ALL" && item.nama_kantor !== state.filters.branch) return false;
    if (state.filters.process !== "ALL" && item.process !== state.filters.process) return false;
    if (state.filters.status !== "ALL" && item.status !== state.filters.status) return false;
    return matchesSearch(item);
  });
}

function renderPriorityRows() {
  const rows = filteredProcessItems().filter((item) => item.severity > 0 || state.filters.status !== "ALL");
  const page = paginateRows(rows, state.pagination.priorityPage);
  state.pagination.priorityPage = page.currentPage;
  els.priorityMeta.textContent = `${formatNumber(rows.length)} proses tampil`;
  if (!rows.length) {
    els.priorityRows.innerHTML = `<tr><td colspan="6">Tidak ada proses yang cocok dengan filter.</td></tr>`;
    renderPagination(els.priorityPagination, page, "priorityPage");
    return;
  }
  els.priorityRows.innerHTML = page.rows
    .map((item) => `
      <tr>
        <td><strong>${item.kode_klaim}</strong></td>
        <td>${item.nama_kantor || "-"}</td>
        <td>${item.processLabel}</td>
        <td>${item.days ?? "-"}</td>
        <td>${item.limit}</td>
        <td><span class="status ${item.status}">${item.statusLabel}</span></td>
      </tr>
    `)
    .join("");
  renderPagination(els.priorityPagination, page, "priorityPage");
}

function claimMatchesFilter(claim) {
  const q = state.filters.search.trim().toLowerCase();
  const process = state.filters.process;
  const status = state.filters.status;
  if (state.filters.branch !== "ALL" && claim.nama_kantor !== state.filters.branch) return false;
  if (q) {
    const haystack = [
      claim.kode_klaim,
      claim.nama_kantor,
      claim.nama_kantor_tk,
      claim.nama_tk,
      claim.nama_perusahaan,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  const checks = Object.values(claim.checks);
  const scoped = process === "ALL" ? checks : checks.filter((check) => check.key === process);
  if (status === "ALL") return true;
  return scoped.some((check) => check.status === status);
}

function filteredClaims() {
  return (state.data?.records || []).filter(claimMatchesFilter);
}

function buildRecapRows(claims) {
  const groups = new Map();
  const emptyBuckets = () => ({
    p5: new Set(),
    p6: new Set(),
    p7: new Set(),
    pOver: new Set(),
    v8: new Set(),
    v9: new Set(),
    v10: new Set(),
    vOver: new Set(),
    b5: new Set(),
    b6: new Set(),
    b7: new Set(),
    bOver: new Set(),
  });
  claims.forEach((claim) => {
    const kodeKantor = claim.kode_kantor || "-";
    const kantor = claim.nama_kantor || "-";
    const key = `${kodeKantor}||${kantor}`;
    if (!groups.has(key)) {
      groups.set(key, {
        kodeKantor,
        kantor,
        total: new Set(),
        buckets: emptyBuckets(),
      });
    }
    const group = groups.get(key);
    group.total.add(claim.kode_klaim);
    const checks = claim.checks || {};
    const pemeriksaan = Number(checks.pemeriksaan?.days);
    const verifikasi = Number(checks.verifikasi?.days);
    const pembayaran = Number(checks.pembayaran?.days);
    if (pemeriksaan === 5) group.buckets.p5.add(claim.kode_klaim);
    else if (pemeriksaan === 6) group.buckets.p6.add(claim.kode_klaim);
    else if (pemeriksaan === 7) group.buckets.p7.add(claim.kode_klaim);
    else if (pemeriksaan > 7) group.buckets.pOver.add(claim.kode_klaim);

    if (verifikasi === 8) group.buckets.v8.add(claim.kode_klaim);
    else if (verifikasi === 9) group.buckets.v9.add(claim.kode_klaim);
    else if (verifikasi === 10) group.buckets.v10.add(claim.kode_klaim);
    else if (verifikasi > 10) group.buckets.vOver.add(claim.kode_klaim);

    if (pembayaran === 5) group.buckets.b5.add(claim.kode_klaim);
    else if (pembayaran === 6) group.buckets.b6.add(claim.kode_klaim);
    else if (pembayaran === 7) group.buckets.b7.add(claim.kode_klaim);
    else if (pembayaran > 7) group.buckets.bOver.add(claim.kode_klaim);
  });
  return Array.from(groups.values())
    .map((group) => {
      const counts = Object.fromEntries(
        Object.entries(group.buckets).map(([key, value]) => [key, value.size])
      );
      const totalOver = counts.pOver + counts.vOver + counts.bOver;
      const totalWatch = counts.p5 + counts.p6 + counts.p7 + counts.v8 + counts.v9 + counts.v10 + counts.b5 + counts.b6 + counts.b7;
      return {
        kodeKantor: group.kodeKantor,
        kantor: group.kantor,
        total: group.total.size,
        totalOver,
        totalWatch,
        ...counts,
      };
    })
    .sort((a, b) => b.totalOver - a.totalOver || b.totalWatch - a.totalWatch || a.kodeKantor.localeCompare(b.kodeKantor) || a.kantor.localeCompare(b.kantor));
}

function renderRecapRows() {
  const claims = filteredClaims();
  const rows = buildRecapRows(claims);
  const totalOver = rows.reduce((sum, row) => sum + row.totalOver, 0);
  const totalWarning = rows.reduce((sum, row) => sum + row.totalWatch, 0);
  els.recapMeta.textContent = `${formatNumber(totalOver)} over, ${formatNumber(totalWarning)} akan over`;
  if (!rows.length) {
    els.recapRows.innerHTML = `<tr><td colspan="14">Belum ada rekap yang cocok dengan filter.</td></tr>`;
    return;
  }
  const totalRow = rows.reduce(
    (acc, row) => {
      Object.keys(acc).forEach((key) => {
        acc[key] += row[key] || 0;
      });
      return acc;
    },
    { total: 0, p5: 0, p6: 0, p7: 0, pOver: 0, v8: 0, v9: 0, v10: 0, vOver: 0, b5: 0, b6: 0, b7: 0, bOver: 0 }
  );
  const bodyRows = rows
    .map((row) => `
      <tr>
        <td><strong>${escapeHtml(row.kantor)}</strong></td>
        <td class="total-cell">${formatNumber(row.total)}</td>
        ${renderHeatCell(row.p5)}
        ${renderHeatCell(row.p6)}
        ${renderHeatCell(row.p7)}
        ${renderHeatCell(row.pOver, true)}
        ${renderHeatCell(row.v8)}
        ${renderHeatCell(row.v9)}
        ${renderHeatCell(row.v10)}
        ${renderHeatCell(row.vOver, true)}
        ${renderHeatCell(row.b5)}
        ${renderHeatCell(row.b6)}
        ${renderHeatCell(row.b7)}
        ${renderHeatCell(row.bOver, true)}
      </tr>
    `)
    .join("");
  els.recapRows.innerHTML = `${bodyRows}
    <tr class="recap-total-row">
      <td>Total</td>
      <td class="total-cell">${formatNumber(totalRow.total)}</td>
      ${renderHeatCell(totalRow.p5)}
      ${renderHeatCell(totalRow.p6)}
      ${renderHeatCell(totalRow.p7)}
      ${renderHeatCell(totalRow.pOver, true)}
      ${renderHeatCell(totalRow.v8)}
      ${renderHeatCell(totalRow.v9)}
      ${renderHeatCell(totalRow.v10)}
      ${renderHeatCell(totalRow.vOver, true)}
      ${renderHeatCell(totalRow.b5)}
      ${renderHeatCell(totalRow.b6)}
      ${renderHeatCell(totalRow.b7)}
      ${renderHeatCell(totalRow.bOver, true)}
    </tr>`;
}

function renderClaimList() {
  const claims = filteredClaims();
  const page = paginateRows(claims, state.pagination.claimPage);
  state.pagination.claimPage = page.currentPage;
  els.claimMeta.textContent = `${formatNumber(claims.length)} klaim tampil`;
  if (!claims.length) {
    els.claimList.innerHTML = `<tr><td colspan="12">Belum ada klaim yang cocok dengan filter.</td></tr>`;
    renderPagination(els.claimPagination, page, "claimPage");
    return;
  }
  els.claimList.innerHTML = page.rows
    .map((claim) => `
      <tr>
        <td><strong>${escapeHtml(claim.kode_klaim)}</strong></td>
        <td>${escapeHtml(claim.nama_kantor)}</td>
        <td>${escapeHtml(claim.nama_tk)}</td>
        <td>${escapeHtml(claim.nama_perusahaan)}</td>
        <td>${escapeHtml(claim.status_klaim)}</td>
        <td><span class="status ${claim.overallStatus}">${statusLabel(claim.overallStatus)}</span></td>
        <td>${renderDurationCell(claim.checks.pemeriksaan)}</td>
        <td><span class="status ${claim.checks.pemeriksaan.status}">${claim.checks.pemeriksaan.statusLabel}</span></td>
        <td>${renderDurationCell(claim.checks.verifikasi)}</td>
        <td><span class="status ${claim.checks.verifikasi.status}">${claim.checks.verifikasi.statusLabel}</span></td>
        <td>${renderDurationCell(claim.checks.pembayaran)}</td>
        <td><span class="status ${claim.checks.pembayaran.status}">${claim.checks.pembayaran.statusLabel}</span></td>
      </tr>
    `)
    .join("");
  renderPagination(els.claimPagination, page, "claimPage");
}

function render() {
  renderBranchOptions();
  renderSummary();
  renderPriorityRows();
  renderRecapRows();
  renderClaimList();
}

els.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    await uploadFile(file);
  } catch (error) {
    setNotice(error.message, "error");
  } finally {
    event.target.value = "";
  }
});

els.refreshSheet.addEventListener("click", async () => {
  try {
    await refreshFromSheet();
  } catch (error) {
    setNotice(error.message, "error");
  }
});

els.statusFilter.addEventListener("change", (event) => {
  state.filters.status = event.target.value;
  resetPages();
  render();
});

els.branchFilter.addEventListener("change", (event) => {
  state.filters.branch = event.target.value;
  resetPages();
  render();
});

els.processFilter.addEventListener("change", (event) => {
  state.filters.process = event.target.value;
  resetPages();
  render();
});

els.modeSelect.addEventListener("change", (event) => {
  state.filters.mode = event.target.value;
  const modeLabel = state.filters.mode === "running" ? "Bulan Berjalan" : "Data Final/Bayar";
  setNotice(buildDataNotice(`Mode hitung disiapkan: <strong>${modeLabel}</strong>. Ambil ulang data agar mode ini diterapkan.`), "");
});

els.searchInput.addEventListener("input", (event) => {
  state.filters.search = event.target.value;
  resetPages();
  render();
});

els.clearData.addEventListener("click", async () => {
  await clearStoredData();
  state.data = null;
  state.filters.branch = "ALL";
  resetPages();
  setNotice("Data lokal sudah dihapus. Upload file baru untuk mulai monitoring.", "");
  els.priorityMeta.textContent = "-";
  els.recapMeta.textContent = "-";
  els.claimMeta.textContent = "-";
  render();
});

els.downloadPriority.addEventListener("click", exportPriorityRows);
els.downloadClaims.addEventListener("click", exportClaimRows);

document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (!button) return;
  const pageKey = button.dataset.page;
  const direction = button.dataset.action === "next" ? 1 : -1;
  state.pagination[pageKey] += direction;
  render();
});

document.addEventListener("change", (event) => {
  const select = event.target.closest("select[data-page-size]");
  if (!select) return;
  state.pagination.pageSize = Number(select.value);
  resetPages();
  render();
});

async function init() {
  if (els.modeSelect) {
    els.modeSelect.value = state.filters.mode;
  }
  state.data = await loadData();
  if (state.data) {
    setNotice(buildDataNotice(`Data terakhir <strong>${state.data.fileName}</strong> dimuat dari penyimpanan lokal browser.`), "success");
    if (state.data.mode && els.modeSelect) {
      state.filters.mode = state.data.mode;
      els.modeSelect.value = state.data.mode;
    }
  }
  render();
}

init();
