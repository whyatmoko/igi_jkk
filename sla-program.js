const programEls = {
  notice: document.getElementById("programNotice"),
  cards: document.getElementById("programCards"),
  rows: document.getElementById("programRows"),
  pagination: document.getElementById("programPagination"),
  meta: document.getElementById("programMeta"),
  branchRecapRows: document.getElementById("branchRecapRows"),
  branchRecapMeta: document.getElementById("branchRecapMeta"),
  refresh: document.getElementById("refreshProgram"),
  dateFilter: document.getElementById("programDateFilter"),
  branchFilter: document.getElementById("programBranchFilter"),
  typeFilter: document.getElementById("programTypeFilter"),
  searchInput: document.getElementById("programSearchInput"),
  resetFilters: document.getElementById("programResetFilters"),
  downloadCsv: document.getElementById("downloadProgramCsv"),
};

const PROGRAM_SLA_GVIZ_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6p-wOSp1QP31f8g5CbmLsinCmoHcaR5I-scRqj2qYNWmNLKZKReBg52u9SCKclmU9yGPWJBvLbSQW/gviz/tq?gid=835183209";

const programState = {
  rows: [],
  source: null,
  filters: {
    date: "ALL",
    branch: "ALL",
    type: "ALL",
    search: "",
  },
  pagination: {
    page: 1,
    pageSize: 20,
  },
};

function escapeHtml(value) {
  return String(value ?? "-")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("id-ID").format(Number(value) || 0);
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function getValue(row, key) {
  const wanted = normalizeKey(key);
  const found = Object.keys(row).find((candidate) => normalizeKey(candidate) === wanted);
  return found ? row[found] : "";
}

function parseGvizProgramTable(table) {
  const headers = (table.cols || []).map((col, index) => String(col.label || col.id || `kolom_${index + 1}`).trim());
  const records = (table.rows || []).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      const cell = row.c?.[index];
      record[header] = cell?.f ?? cell?.v ?? "";
    });
    return record;
  });

  if (headers[0] && /^\d+$/.test(headers[0])) {
    const [, ...cleanHeaders] = headers;
    return {
      columns: cleanHeaders,
      records: records.map((record) => {
        const { [headers[0]]: _rowNumber, ...cleanRecord } = record;
        return cleanRecord;
      }),
    };
  }

  return { columns: headers, records };
}

function parseDay(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const numeric = Number(raw.replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function parseDataDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  }
  const iso = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKey(value) {
  const date = parseDataDate(value);
  if (!date) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDisplayDate(value) {
  const date = parseDataDate(value);
  if (!date) return value || "-";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function setNotice(message, type = "") {
  programEls.notice.className = `notice ${type}`.trim();
  programEls.notice.innerHTML = message;
}

function selectedDateLabel() {
  if (programState.filters.date === "ALL") {
    const latest = latestDateKey();
    return latest ? formatDisplayDate(latest) : "-";
  }
  return formatDisplayDate(programState.filters.date);
}

function urgencyClass(day) {
  if (day === 0) return "status OVER";
  if (day === 1) return "status WARNING";
  return "status AMAN";
}

function isSlaExcluded(row) {
  const program = String(getValue(row, "tipe_klaim") || "").trim().toUpperCase();
  const status = String(getValue(row, "status_klaim_terakhir") || "").trim().toUpperCase();
  return program === "JKK" && status === "DALAM_PLAFON_JR";
}

function slaCountedRows() {
  return filteredProgramRows().filter((row) => !isSlaExcluded(row));
}

function branchValue(row) {
  return `${getValue(row, "kode_kantor")} - ${getValue(row, "unit_kerja")}`;
}

function matchesProgramFilters(row) {
  const branch = branchValue(row);
  const type = String(getValue(row, "tipe_klaim") || "").trim().toUpperCase();
  const rowDate = dateKey(getValue(row, "tanggal"));
  const q = programState.filters.search.trim().toLowerCase();

  if (programState.filters.date !== "ALL" && rowDate !== programState.filters.date) return false;
  if (programState.filters.branch !== "ALL" && branch !== programState.filters.branch) return false;
  if (programState.filters.type !== "ALL" && type !== programState.filters.type) return false;
  if (!q) return true;

  const haystack = [
    getValue(row, "kode_kantor"),
    getValue(row, "unit_kerja"),
    getValue(row, "kode_klaim"),
    getValue(row, "kpj"),
    getValue(row, "nama_peserta"),
    getValue(row, "tipe_klaim"),
    getValue(row, "status_klaim_terakhir"),
    getValue(row, "kode_petugas"),
  ].join(" ").toLowerCase();
  return haystack.includes(q);
}

function filteredProgramRows() {
  return programState.rows.filter(matchesProgramFilters);
}

function uniqueDateKeys() {
  return Array.from(new Set(programState.rows.map((row) => dateKey(getValue(row, "tanggal"))).filter(Boolean)))
    .sort((a, b) => b.localeCompare(a));
}

function latestDateKey() {
  return uniqueDateKeys()[0] || "";
}

function renderDateFilterOptions() {
  const dates = uniqueDateKeys();
  const latest = dates[0] || "ALL";
  const current = programState.filters.date;
  programEls.dateFilter.innerHTML = [
    `<option value="ALL">Semua tanggal</option>`,
    ...dates.map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(formatDisplayDate(key))}</option>`),
  ].join("");
  programState.filters.date = current !== "ALL" && dates.includes(current) ? current : latest;
  programEls.dateFilter.value = programState.filters.date;
}

function renderBranchFilterOptions() {
  const current = programState.filters.branch;
  const branches = Array.from(new Set(programState.rows.map(branchValue).filter((value) => value.trim() !== "-"))).sort((a, b) => a.localeCompare(b));
  programEls.branchFilter.innerHTML = [
    `<option value="ALL">Semua cabang</option>`,
    ...branches.map((branch) => `<option value="${escapeHtml(branch)}">${escapeHtml(branch)}</option>`),
  ].join("");
  programState.filters.branch = branches.includes(current) ? current : "ALL";
  programEls.branchFilter.value = programState.filters.branch;
}

function programIcon(program) {
  return {
    JKK: "⚕",
    JHT: "▣",
    JKM: "✚",
    JP: "◷",
    JKP: "↗",
  }[program] || "•";
}

function programCountsByDay(day) {
  const programs = ["JKK", "JHT", "JKM", "JP", "JKP"];
  const counts = Object.fromEntries(programs.map((program) => [program, 0]));
  slaCountedRows().forEach((row) => {
    const rowDay = parseDay(getValue(row, "sisa_akhir_pembayaran"));
    const program = String(getValue(row, "tipe_klaim") || "").trim().toUpperCase();
    if (rowDay === day && counts[program] !== undefined) {
      counts[program] += 1;
    }
  });
  return counts;
}

function renderProgramMiniCounts(counts, tone) {
  return `
    <div class="card-programs">
      ${Object.entries(counts).map(([program, value]) => `
        <span class="card-program-chip ${tone} program-${program.toLowerCase()}">
          <i>${escapeHtml(programIcon(program))}</i>
          <b>${escapeHtml(program)}</b>
          <strong>${formatNumber(value)}</strong>
        </span>
      `).join("")}
    </div>
  `;
}

function renderCards() {
  const rows = filteredProgramRows();
  const countedRows = slaCountedRows();
  const total = rows.length;
  const h0 = countedRows.filter((row) => parseDay(getValue(row, "sisa_akhir_pembayaran")) === 0).length;
  const h1 = countedRows.filter((row) => parseDay(getValue(row, "sisa_akhir_pembayaran")) === 1).length;
  const urgent = h0 + h1;
  const jrCount = rows.filter(isSlaExcluded).length;
  const h0Programs = programCountsByDay(0);
  const h1Programs = programCountsByDay(1);

  programEls.cards.innerHTML = `
    <article class="card"><span>Total Klaim</span><strong>${formatNumber(total)}</strong></article>
    <article class="card card-over"><span>Sisa Hari SLA 0</span><strong>${formatNumber(h0)}</strong><em>Urgensi hari ini</em>${renderProgramMiniCounts(h0Programs, "over")}</article>
    <article class="card card-warning"><span>Sisa Hari SLA 1</span><strong>${formatNumber(h1)}</strong><em>Perlu diselesaikan segera</em>${renderProgramMiniCounts(h1Programs, "warning")}</article>
    <article class="card card-paid"><span>Total Urgensi</span><strong>${formatNumber(urgent)}</strong><em>Sisa hari 0 dan 1</em><div class="card-extra-note">JR: <strong>${formatNumber(jrCount)}</strong> klaim</div></article>
  `;
}

function urgentFilteredRows() {
  return filteredProgramRows()
    .map((row) => ({ row, day: parseDay(getValue(row, "sisa_akhir_pembayaran")) }))
    .filter((item) => item.day === 0 || item.day === 1 || isSlaExcluded(item.row))
    .sort((a, b) => {
      const aExcluded = isSlaExcluded(a.row);
      const bExcluded = isSlaExcluded(b.row);
      if (aExcluded !== bExcluded) return aExcluded ? 1 : -1;
      return (a.day ?? 99) - (b.day ?? 99) || String(getValue(a.row, "kode_kantor")).localeCompare(String(getValue(b.row, "kode_kantor")));
    });
}

function resetProgramPage() {
  programState.pagination.page = 1;
}

function paginateUrgentRows(rows) {
  const pageSize = programState.pagination.pageSize;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(Math.max(1, programState.pagination.page), totalPages);
  const start = (currentPage - 1) * pageSize;
  programState.pagination.page = currentPage;
  return {
    rows: rows.slice(start, start + pageSize),
    currentPage,
    totalPages,
    start,
    end: Math.min(start + pageSize, rows.length),
    totalRows: rows.length,
  };
}

function renderProgramPagination(pageInfo) {
  const disabledPrev = pageInfo.currentPage <= 1 ? "disabled" : "";
  const disabledNext = pageInfo.currentPage >= pageInfo.totalPages ? "disabled" : "";
  programEls.pagination.innerHTML = `
    <div class="page-status">
      Baris ${formatNumber(pageInfo.totalRows ? pageInfo.start + 1 : 0)}-${formatNumber(pageInfo.end)}
      dari ${formatNumber(pageInfo.totalRows)}
    </div>
    <div class="page-controls">
      <span>20 baris / halaman</span>
      <button type="button" data-program-page="prev" ${disabledPrev}>Sebelumnya</button>
      <span>Halaman ${formatNumber(pageInfo.currentPage)} / ${formatNumber(pageInfo.totalPages)}</span>
      <button type="button" data-program-page="next" ${disabledNext}>Berikutnya</button>
    </div>
  `;
}

function renderRows() {
  const urgentRows = urgentFilteredRows();
  const excludedCount = urgentRows.filter(({ row }) => isSlaExcluded(row)).length;
  const pageInfo = paginateUrgentRows(urgentRows);

  programEls.meta.textContent = `${formatNumber(urgentRows.length)} klaim tampil${excludedCount ? `, ${formatNumber(excludedCount)} pengecualian SLA` : ""}`;

  if (!urgentRows.length) {
    programEls.rows.innerHTML = `<tr><td colspan="9">Tidak ada klaim dengan sisa hari SLA 0 atau 1.</td></tr>`;
    renderProgramPagination(pageInfo);
    return;
  }

  programEls.rows.innerHTML = pageInfo.rows.map(({ row, day }, index) => {
    const excluded = isSlaExcluded(row);
    return `
    <tr class="${excluded ? "sla-excluded-row" : ""}">
      <td class="row-number">${formatNumber(pageInfo.start + index + 1)}</td>
      <td>${escapeHtml(getValue(row, "tanggal"))}</td>
      <td class="office-cell"><strong>${escapeHtml(getValue(row, "kode_kantor"))} - ${escapeHtml(getValue(row, "unit_kerja"))}</strong></td>
      <td><strong>${escapeHtml(getValue(row, "kode_klaim"))}</strong></td>
      <td>${escapeHtml(getValue(row, "nama_peserta"))}</td>
      <td>${escapeHtml(getValue(row, "tipe_klaim"))}</td>
      <td>${escapeHtml(getValue(row, "status_klaim_terakhir"))}${excluded ? ` <span class="sla-excluded-badge">Tidak dihitung SLA</span>` : ""}</td>
      <td>${escapeHtml(getValue(row, "kode_petugas"))}</td>
      <td><span class="${urgencyClass(day)}">${formatNumber(day)} hari</span></td>
    </tr>
  `;
  }).join("");
  renderProgramPagination(pageInfo);
}

function updateDataNotice() {
  if (!programState.source) return;
  const totalFiltered = filteredProgramRows().length;
  setNotice(
    `Data <strong>${escapeHtml(programState.source.fileName)}</strong> berhasil dimuat. Total <strong>${formatNumber(programState.rows.length)}</strong> klaim. <div class="notice-meta">Last update data: <strong>${escapeHtml(selectedDateLabel())}</strong> <span>Data sesuai filter: <strong>${formatNumber(totalFiltered)}</strong></span></div>`,
    "success"
  );
}

function branchKey(row) {
  return `${getValue(row, "kode_kantor")}||${getValue(row, "unit_kerja")}`;
}

function makeBranchRecap() {
  const programs = ["JKK", "JHT", "JKM", "JP", "JKP"];
  const groups = new Map();
  slaCountedRows().forEach((row) => {
    const day = parseDay(getValue(row, "sisa_akhir_pembayaran"));
    if (day !== 0 && day !== 1) return;

    const key = branchKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        kodeKantor: getValue(row, "kode_kantor"),
        unitKerja: getValue(row, "unit_kerja"),
        h0: 0,
        h1: 0,
        programs: Object.fromEntries(programs.map((program) => [program, { h0: 0, h1: 0 }])),
      });
    }

    const group = groups.get(key);
    if (day === 0) group.h0 += 1;
    if (day === 1) group.h1 += 1;

    const program = String(getValue(row, "tipe_klaim") || "").trim().toUpperCase();
    if (!group.programs[program]) return;
    const bucket = group.programs[program];
    if (day === 0) bucket.h0 += 1;
    if (day === 1) bucket.h1 += 1;
  });

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      total: group.h0 + group.h1,
    }))
    .sort((a, b) => b.total - a.total || b.h0 - a.h0 || a.kodeKantor.localeCompare(b.kodeKantor));
}

function matrixCell(value, type = "") {
  return `<td class="matrix-value ${type}">${value ? formatNumber(value) : ""}</td>`;
}

function renderBranchRecap() {
  const programs = ["JKK", "JHT", "JKM", "JP", "JKP"];
  const rows = makeBranchRecap();
  const totalH0 = rows.reduce((sum, row) => sum + row.h0, 0);
  const totalH1 = rows.reduce((sum, row) => sum + row.h1, 0);
  const programTotals = Object.fromEntries(programs.map((program) => [program, { h0: 0, h1: 0 }]));

  rows.forEach((row) => {
    programs.forEach((program) => {
      programTotals[program].h0 += row.programs[program].h0;
      programTotals[program].h1 += row.programs[program].h1;
    });
  });

  programEls.branchRecapMeta.textContent = `${formatNumber(rows.length)} cabang, ${formatNumber(totalH0 + totalH1)} klaim urgent`;

  if (!rows.length) {
    programEls.branchRecapRows.innerHTML = `<tr><td colspan="12">Tidak ada beban cabang untuk sisa hari 0 atau 1.</td></tr>`;
    return;
  }

  const bodyRows = rows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.kodeKantor)} - ${escapeHtml(row.unitKerja)}</strong></td>
      <td class="matrix-total">${formatNumber(row.total)}</td>
      ${programs.map((program) => matrixCell(row.programs[program].h0, "matrix-zero-cell")).join("")}
      ${programs.map((program) => matrixCell(row.programs[program].h1, "matrix-one-cell")).join("")}
    </tr>
  `).join("");

  const totalRow = `
    <tr class="total-row">
      <td><strong>Total</strong></td>
      <td class="matrix-total">${formatNumber(totalH0 + totalH1)}</td>
      ${programs.map((program) => matrixCell(programTotals[program].h0, "matrix-zero-cell")).join("")}
      ${programs.map((program) => matrixCell(programTotals[program].h1, "matrix-one-cell")).join("")}
    </tr>
  `;

  programEls.branchRecapRows.innerHTML = bodyRows + totalRow;
}

function render() {
  renderCards();
  renderBranchRecap();
  renderRows();
  updateDataNotice();
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadUrgentCsv() {
  const rows = urgentFilteredRows();
  if (!rows.length) {
    setNotice("Tidak ada data urgensi yang cocok dengan filter untuk di-download.", "error");
    return;
  }
  const headers = [
    "tanggal",
    "kode_kantor",
    "unit_kerja",
    "kode_klaim",
    "kpj",
    "nama_peserta",
    "tipe_klaim",
    "status_klaim_terakhir",
    "kode_petugas",
    "sisa_akhir_pembayaran",
    "keterangan_sla",
  ];
  const csvRows = [
    headers.join(","),
    ...rows.map(({ row }) => headers.map((header) => (
      header === "keterangan_sla"
        ? csvEscape(isSlaExcluded(row) ? "Tidak dihitung SLA" : "Dihitung SLA")
        : csvEscape(getValue(row, header))
    )).join(",")),
  ];
  const blob = new Blob([`\uFEFF${csvRows.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const datePart = programState.filters.date === "ALL" ? "semua-tanggal" : programState.filters.date;
  link.href = url;
  link.download = `sla-program-urgensi-${datePart}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function fetchProgramGvizData() {
  return new Promise((resolve, reject) => {
    const callbackName = `slaProgramCallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const cleanup = () => {
      delete window[callbackName];
      script.remove();
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timeout saat mengambil data SLA Program dari Google Spreadsheet."));
    }, 60000);

    window[callbackName] = (payload) => {
      window.clearTimeout(timeout);
      try {
        const parsed = parseGvizProgramTable(payload.table || {});
        cleanup();
        resolve({
          columns: parsed.columns,
          records: parsed.records,
          fileName: "Google Spreadsheet SLA Program",
          sourceUrl: PROGRAM_SLA_GVIZ_URL,
          sourceMode: "jsonp",
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    script.onerror = () => {
      window.clearTimeout(timeout);
      cleanup();
      reject(new Error("Gagal memuat data SLA Program dari Google Spreadsheet."));
    };
    script.src = `${PROGRAM_SLA_GVIZ_URL}&tqx=responseHandler:${callbackName}`;
    document.head.appendChild(script);
  });
}

async function fetchProgramSheetData() {
  const errors = [];
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    try {
      const response = await fetch("/api/sla-program-sheet");
      const text = await response.text();
      if (text.trim().startsWith("<")) {
        throw new Error("Server lokal mengembalikan HTML, bukan JSON.");
      }
      const payload = JSON.parse(text);
      if (!response.ok) throw new Error(payload.error || "Gagal mengambil data SLA Program.");
      return payload;
    } catch (error) {
      errors.push(error.message);
    }
  }

  try {
    return await fetchProgramGvizData();
  } catch (error) {
    errors.push(error.message);
    throw new Error(`Gagal mengambil data SLA Program. ${errors.filter(Boolean).join(" ")}`);
  }
}

async function loadProgramData() {
  setNotice("Sedang mengambil data SLA Program dari Spreadsheet...", "");
  programEls.refresh.disabled = true;
  try {
    const payload = await fetchProgramSheetData();
    programState.rows = payload.records || [];
    programState.source = payload;
    renderDateFilterOptions();
    renderBranchFilterOptions();
    resetProgramPage();
    render();
  } catch (error) {
    programState.rows = [];
    render();
    setNotice(error.message, "error");
  } finally {
    programEls.refresh.disabled = false;
  }
}

programEls.refresh.addEventListener("click", loadProgramData);
programEls.dateFilter.addEventListener("change", (event) => {
  programState.filters.date = event.target.value;
  resetProgramPage();
  render();
});
programEls.branchFilter.addEventListener("change", (event) => {
  programState.filters.branch = event.target.value;
  resetProgramPage();
  render();
});
programEls.typeFilter.addEventListener("change", (event) => {
  programState.filters.type = event.target.value;
  resetProgramPage();
  render();
});
programEls.searchInput.addEventListener("input", (event) => {
  programState.filters.search = event.target.value;
  resetProgramPage();
  render();
});
programEls.resetFilters.addEventListener("click", () => {
  programState.filters.date = latestDateKey() || "ALL";
  programState.filters.branch = "ALL";
  programState.filters.type = "ALL";
  programState.filters.search = "";
  programEls.dateFilter.value = programState.filters.date;
  programEls.branchFilter.value = "ALL";
  programEls.typeFilter.value = "ALL";
  programEls.searchInput.value = "";
  resetProgramPage();
  render();
});
programEls.downloadCsv.addEventListener("click", downloadUrgentCsv);
programEls.pagination.addEventListener("click", (event) => {
  const action = event.target?.dataset?.programPage;
  if (!action) return;
  if (action === "prev") programState.pagination.page -= 1;
  if (action === "next") programState.pagination.page += 1;
  renderRows();
});

loadProgramData();
