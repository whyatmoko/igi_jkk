(function filterSisaHariPembayaran() {
  const TABLE_ID = "mydata_grid";
  const LIMIT = 3;

  function info(message) {
    console.log(`[SLA Tarik Data] ${message}`);
  }

  function fail(message) {
    console.error(`[SLA Tarik Data] ${message}`);
  }

  function textOf(node) {
    return String(node?.textContent ?? node ?? "").replace(/\s+/g, " ").trim();
  }

  function normalizeColumnName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function headersFromTable(table) {
    const headerCells = table.tHead?.rows?.length
      ? [...table.tHead.rows[table.tHead.rows.length - 1].cells]
      : [...table.rows[0]?.cells || []];
    return headerCells.map(textOf).filter(Boolean);
  }

  const table = document.getElementById(TABLE_ID) || document.querySelector("table");
  if (!table) {
    fail("Tabel belum ditemukan. Tunggu halaman selesai load, lalu jalankan ulang script ini.");
    return;
  }

  const headers = headersFromTable(table);
  const columnIndex = headers.findIndex((header) => {
    const normalized = normalizeColumnName(header);
    return normalized.includes("sisa hari") && normalized.includes("pembayaran");
  });

  if (columnIndex < 0) {
    fail(`Kolom Sisa Hari Pembayaran tidak ditemukan. Header terbaca: ${headers.join(" | ")}`);
    return;
  }

  const jq = window.jQuery || window.$;
  if (!jq?.fn?.dataTable || !jq.fn.dataTable.isDataTable(table)) {
    fail("DataTables API tidak ditemukan pada tabel ini.");
    return;
  }

  const api = jq(table).DataTable();
  if (window.__slaSisaHariPembayaranFilter) {
    const oldIndex = jq.fn.dataTable.ext.search.indexOf(window.__slaSisaHariPembayaranFilter);
    if (oldIndex >= 0) jq.fn.dataTable.ext.search.splice(oldIndex, 1);
  }
  if (window.__slaSisaHariPembayaranFilterOld && jq.fn.dataTableExt?.afnFiltering) {
    const oldIndex = jq.fn.dataTableExt.afnFiltering.indexOf(window.__slaSisaHariPembayaranFilterOld);
    if (oldIndex >= 0) jq.fn.dataTableExt.afnFiltering.splice(oldIndex, 1);
  }

  function isAllowedSisaHari(rowData) {
    const rawValue = String(rowData[columnIndex] ?? "").replace(/[^\d-]/g, "").trim();
    if (!rawValue) return false;
    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue) && numericValue >= 0 && numericValue <= LIMIT;
  }

  window.__slaSisaHariPembayaranFilter = (settings, rowData) => {
    if (settings.nTable !== table) return true;
    return isAllowedSisaHari(rowData);
  };

  jq.fn.dataTable.ext.search.push(window.__slaSisaHariPembayaranFilter);

  if (jq.fn.dataTableExt?.afnFiltering) {
    window.__slaSisaHariPembayaranFilterOld = (settings, rowData) => {
      if (settings.nTable !== table) return true;
      return isAllowedSisaHari(rowData);
    };
    jq.fn.dataTableExt.afnFiltering.push(window.__slaSisaHariPembayaranFilterOld);
  }

  if (api.column) {
    api.column(columnIndex).search("^\\s*(0|1|2|3)\\s*$", true, false);
  } else if (jq(table).dataTable) {
    jq(table).dataTable().fnFilter("^\\s*(0|1|2|3)\\s*$", columnIndex, true, false);
  }

  api.page("first").draw();

  const infoData = api.page.info();
  info(`Filter aktif: ${headers[columnIndex]} <= ${LIMIT}.`);
  info(`Entries: ${infoData.recordsTotal} -> ${infoData.recordsDisplay}.`);
})();
