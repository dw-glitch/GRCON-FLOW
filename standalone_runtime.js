(function (root) {
  "use strict";

  root.GRCONModuleLoader = Object.freeze({
    async ensure(name) {
      if (name === "xlsx" && !root.XLSX) throw new Error("Biblioteca XLSX não carregada.");
      if (name === "excel" && !root.ExcelJS) throw new Error("Biblioteca ExcelJS não carregada.");
      return true;
    }
  });

  let toastTimer = 0;
  root.GrconNotify = function GrconNotify(message, type) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = String(message || "");
    toast.dataset.type = type || "info";
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 4200);
  };

  document.addEventListener("DOMContentLoaded", () => {
    const config = root.GRCON_SOLICITACOES_CONFIG || {};
    const badge = document.getElementById("storage-badge");
    const role = document.getElementById("role-badge");
    const notice = document.getElementById("standalone-notice");
    const labels = { owner: "Proprietário", admin: "Administrador", operator: "Operador", viewer: "Consulta" };
    if (role) role.textContent = labels[config.role] || config.role || "Proprietário";
    if (badge) {
      if (config.storageDriver === "supabase") {
        badge.textContent = "Supabase independente";
        badge.classList.add("is-online");
      } else {
        badge.textContent = "Armazenamento local";
        badge.classList.add("is-local");
      }
    }
    if (notice) notice.hidden = config.storageDriver === "supabase";
  });
})(window);
