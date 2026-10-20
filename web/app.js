(() => {
  "use strict";
  const telegram = window.Telegram && window.Telegram.WebApp;
  const initData = telegram && telegram.initData;
  const $ = (id) => document.getElementById(id);
  const TABS = {
    alerts: ["Alertes à traiter", "Notifications non lues du personnel.", "🔔"],
    stock: ["Stock faible", "Produits avec 2 unités ou moins.", "📦"],
    images: ["Photos manquantes", "Fiches à compléter.", "🖼️"],
    trocs: ["Dossiers de troc", "Demandes en cours.", "🔄"],
    marketplace: ["Marketplace", "Dernières annonces.", "🛍️"]
  };
  let config;
  let category = "alerts";
  let linked = false;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const status = (message, kind = "") => {
    $("status").className = "status " + kind;
    $("status").textContent = message;
  };
  const headers = (json = false) => ({
    "X-Telegram-Init-Data": initData || "",
    ...(json ? { "Content-Type": "application/json" } : {})
  });
  const http = async (path, options = {}) => {
    const res = await fetch(path, {
      cache: "no-store",
      ...options,
      headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) }
    });
    let data = {};
    try { data = await res.json(); } catch { /* upstream error */ }
    if (!res.ok) throw new Error(data.error || "HTTP_" + res.status);
    return data;
  };
  const formatMoney = (amount) => typeof amount === "number"
    ? new Intl.NumberFormat("fr-FR").format(amount) + " FCFA" : "—";
  const dateLabel = (raw) => {
    if (!raw) return "";
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  };
  const section = () => {
    $("section-title").textContent = TABS[category][0];
    $("section-description").textContent = TABS[category][1];
    document.querySelectorAll(".tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.category === category);
      button.setAttribute("aria-selected", String(button.dataset.category === category));
    });
  };
  const actionLink = (label, target) => {
    const link = el("a", "action secondary", label + " ↗");
    link.href = config.xeptionSiteUrl + target;
    link.rel = "noreferrer noopener";
    link.target = "_blank";
    return link;
  };
  const itemCard = (item) => {
    const icon = el("div", "item-icon", TABS[category][2]);
    const card = el("article", "item");
    const body = el("div", "item-body");
    const head = el("div", "item-head");
    let title = "", meta = "", target = "/admin";
    if (category === "alerts") {
      title = item.title || "Nouvelle alerte";
      meta = (item.event_type || "") + " · " + dateLabel(item.created_at);
      const routes = { inventory: "/admin/inventory", troc: "/admin/troc", marketplace: "/marketplace", orders: "/admin/orders" };
      target = Object.hasOwn(routes, item.link_to_tab) ? routes[item.link_to_tab] : "/admin";
    } else if (category === "stock" || category === "images") {
      title = item.name || "Produit";
      meta = category === "stock"
        ? "Stock : " + String(item.stock ?? 0) + " · " + formatMoney(item.price)
        : "Visuel absent · " + formatMoney(item.price);
      target = "/admin/inventory";
    } else if (category === "trocs") {
      title = [item.device_brand, item.device_model].filter(Boolean).join(" ") || "Appareil";
      meta = String(item.status || "en cours") + " · " + (formatMoney(item.offer_cash)) + " · " + dateLabel(item.created_at);
      target = "/admin/troc";
    } else {
      title = [item.device_brand, item.device_model].filter(Boolean).join(" ") || "Annonce";
      meta = (item.status || "active") + " · " + formatMoney(item.price_min) + " – " + formatMoney(item.price_max);
      target = "/marketplace";
    }
    head.append(el("strong", "item-title", title), el("span", "item-time", dateLabel(item.created_at)));
    body.append(head, el("div", "item-meta", meta));
    const actions = el("div", "item-actions");
    actions.append(actionLink(category === "alerts" ? "Ouvrir" : "Gérer dans Xeption", target));
    if (category === "alerts" && config.writesEnabled) {
      const ack = el("button", "action", "✓ Marquer traité");
      ack.type = "button";
      ack.addEventListener("click", async () => {
        ack.disabled = true;
        status("Enregistrement…");
        try {
          await http("/v1/miniapp/ack", { method: "POST", body: JSON.stringify({ id: item.id }) });
          card.remove();
          status("Alerte prise en compte.", "ok");
          updateListCounter();
        } catch {
          ack.disabled = false;
          status("Action refusée ou indisponible. Réessayez.", "error");
        }
      });
      actions.append(ack);
    }
    body.append(actions);
    card.append(icon, body);
    return card;
  };
  const updateListCounter = () => { $("item-count").textContent = String($("feed").childElementCount); };
  const load = async () => {
    section();
    status("Chargement de " + TABS[category][0].toLowerCase() + "…");
    const feed = $("feed");
    feed.replaceChildren();
    try {
      const result = await http("/v1/miniapp/items?category=" + encodeURIComponent(category));
      result.items.forEach((item) => feed.append(itemCard(item)));
      if (!result.items.length) {
        const empty = el("div", "empty");
        empty.append(el("strong", "", "Rien à signaler."), el("span", "", "Cette rubrique est à jour."));
        feed.append(empty);
      }
      $("item-count").textContent = String(result.items.length);
      if (["alerts", "stock", "trocs"].includes(category)) {
        $("count-" + category).textContent = String(result.items.length);
      }
      status("", "");
    } catch (e) {
      if (e.message === "INSUFFICIENT_ROLE") status("Accès réservé aux responsables.", "error");
      else if (e.message === "EXPIRED_TELEGRAM_SESSION") status("Session expirée : fermez puis rouvrez la Mini App.", "error");
      else status("Impossible de récupérer les informations. " + e.message, "error");
    }
  };
  const loadMetrics = async () => {
    for (const key of ["alerts", "stock", "trocs"]) {
      try {
        const result = await http("/v1/miniapp/items?category=" + key);
        $("count-" + key).textContent = String(result.items.length);
      } catch { $("count-" + key).textContent = "—"; }
    }
  };
  const linkedSession = (result) => {
    linked = Boolean(result.linked);
    $("login").classList.toggle("hidden", linked);
    $("operations").classList.toggle("hidden", !linked);
    if (linked) {
      $("staff-name").textContent = result.staff.name.split(/\s+/)[0] || "l'équipe";
      $("role").textContent = result.staff.role;
      status("", "");
      void Promise.all([load(), loadMetrics()]);
    } else {
      status("Compte Telegram vérifié. Associez votre profil professionnel Xeption.");
    }
  };
  $("tabs").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-category]");
    if (!button) return;
    category = button.dataset.category;
    void load();
  });
  $("refresh").addEventListener("click", () => {
    if (linked) void Promise.all([load(), loadMetrics()]);
  });
  $("link-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("email").value.trim();
    const password = $("password").value;
    $("link-button").disabled = true;
    status("Connexion à Xeption…");
    try {
      // Credentials travel DIRECTLY to Xeption Supabase Auth over HTTPS; never via Notify.
      const auth = await fetch(config.supabaseUrl + "/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: config.supabaseAnonKey },
        body: JSON.stringify({ email, password }),
        cache: "no-store"
      });
      const token = await auth.json();
      if (!auth.ok || !token.access_token) throw new Error("INVALID_CREDENTIALS");
      $("password").value = "";
      const result = await http("/v1/miniapp/link", {
        method: "POST", body: JSON.stringify({ xeptionAccessToken: token.access_token })
      });
      linkedSession(result);
    } catch (e) {
      status(e.message === "INVALID_CREDENTIALS" ? "Identifiants Xeption incorrects." :
        e.message === "NOT_XEPTION_STAFF" ? "Compte non autorisé pour le staff." :
        "Association impossible : " + e.message, "error");
    } finally { $("link-button").disabled = false; $("password").value = ""; }
  });
  const boot = async () => {
    if (!initData) {
      status("Ouvrez cette application depuis le bot Telegram Xeption.", "error");
      return;
    }
    telegram.ready();
    telegram.expand();
    try {
      config = await http("/v1/miniapp/public-config");
      const result = await http("/v1/miniapp/session");
      linkedSession(result);
    } catch (e) {
      status(e.message === "MINIAPP_NOT_CONFIGURED"
        ? "Mini App non encore configurée sur le serveur."
        : "Connexion impossible : " + e.message, "error");
    }
  };
  void boot();
})();
