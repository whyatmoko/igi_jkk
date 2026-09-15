(function tampilkanSemuaDataSmile() {
  const TARGET_LENGTH = 10000;
  const TABLE_ID = "mydata_grid";

  function info(message) {
    console.log(`[SLA Tarik Data] ${message}`);
  }

  function fail(message) {
    console.error(`[SLA Tarik Data] ${message}`);
  }

  function ensureLengthOption(select) {
    const targetValue = String(TARGET_LENGTH);
    const exists = [...select.options].some((option) => option.value === targetValue);
    if (!exists) {
      const option = document.createElement("option");
      option.value = targetValue;
      option.textContent = targetValue;
      select.appendChild(option);
    }
    select.value = targetValue;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function forceViaDataTables(table) {
    const jq = window.jQuery || window.$;
    if (!jq?.fn?.dataTable || !jq.fn.dataTable.isDataTable(table)) return false;

    const api = jq(table).DataTable();
    const before = api.page.info();
    api.page.len(TARGET_LENGTH).draw();
    const after = api.page.info();
    info(`DataTables page length diubah: ${before.length} -> ${after.length}.`);
    info(`Data tampil: ${after.recordsDisplay} entries, halaman aktif ${after.page + 1}/${after.pages || 1}.`);
    return true;
  }

  function forceViaSelect() {
    const select = document.querySelector(`select[name="${TABLE_ID}_length"], .dataTables_length select`);
    if (!select) return false;
    ensureLengthOption(select);
    info(`Dropdown Show entries dipaksa menjadi ${TARGET_LENGTH}.`);
    return true;
  }

  const table = document.getElementById(TABLE_ID) || document.querySelector("table");
  if (!table) {
    fail("Tabel belum ditemukan. Tunggu sampai halaman selesai load, lalu jalankan ulang script ini.");
    return;
  }

  const viaDataTables = forceViaDataTables(table);
  const viaSelect = forceViaSelect();

  if (!viaDataTables && !viaSelect) {
    fail("Tidak menemukan DataTables API atau dropdown Show entries.");
    return;
  }

  window.setTimeout(() => {
    const summary = document.querySelector(`#${TABLE_ID}_info, .dataTables_info`)?.textContent?.replace(/\s+/g, " ").trim();
    if (summary) info(summary);
  }, 1500);
})();
