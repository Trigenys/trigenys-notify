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
  let staffRole = "vendeur";
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
      meta = String(item.status || "en cours") + " · " + (formatMoney(item.trade_in_value_cash || item.trade_in_value)) + " · " + dateLabel(item.created_at);
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
      const ack = el("button", "action", "✓ Marquer lu");
      ack.type = "button";
      ack.addEventListener("click", async () => {
        ack.disabled = true;
        status("Enregistrement…");
        try {
          await http("/v1/miniapp/ack", { method: "POST", body: JSON.stringify({ id: item.id }) });
          card.remove();
          status("Notification marquée comme lue pour l’équipe.", "ok");
          updateListCounter();
        } catch {
          ack.disabled = false;
          status("Action refusée ou indisponible. Réessayez.", "error");
        }
      });
      actions.append(ack);
    }
    const canOperate = config.writesEnabled && ["responsable", "direction", "super_admin"].includes(staffRole);

    if (canOperate && category === "trocs") {
      const addTrocAction = (label, action) => {
        const button = el("button", "action", label);
        button.type = "button";
        button.addEventListener("click", () => {
          const previous = body.querySelector(".decision");
          if (previous) previous.remove();
          const form = el("form", "decision");
          const explanation = el("label", "", action === "refused"
            ? "Motif du refus (obligatoire, 5 caractères minimum)"
            : "Confirmer que ce client a effectivement été contacté ?");
          form.append(explanation);
          const reason = el("textarea", "", "");
          if (action === "refused") {
            reason.required = true;
            reason.minLength = 5;
            reason.maxLength = 300;
            reason.placeholder = "Indiquez le motif exact…";
            form.append(reason);
          }
          const bar = el("div", "item-actions");
          const confirm = el("button", "action", "Confirmer");
          confirm.type = "submit";
          const cancel = el("button", "action secondary", "Annuler");
          cancel.type = "button";
          cancel.addEventListener("click", () => form.remove());
          bar.append(confirm, cancel);
          form.append(bar);
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            confirm.disabled = true;
            status("Enregistrement de l'action…");
            try {
              const response = await http("/v1/miniapp/troc-action", {
                method: "POST", body: JSON.stringify({
                  id: item.id, action, ...(action === "refused" ? {reason: reason.value.trim()} : {})
                })
              });
              if (!response.changed) throw new Error("ACTION_CONFLICT");
              status("Dossier mis à jour dans Xeption.", "ok");
              await Promise.all([load(), loadMetrics()]);
            } catch (error) {
              confirm.disabled = false;
              status("Action impossible : " + error.message, "error");
            }
          });
          body.append(form);
        });
        actions.append(button);
      };
      if (item.status === "accepted") addTrocAction("✓ Client contacté", "contacted");
      if (["pending", "accepted", "contacted", "appointment"].includes(item.status)) {
        addTrocAction("Refuser le dossier", "refused");
      }
    }

    if (canOperate && category === "marketplace" && item.status === "active") {
      const sold = el("button", "action", "✓ Marquer vendu");
      sold.type = "button";
      sold.addEventListener("click", () => {
        const old = body.querySelector(".decision");
        if (old) old.remove();
        const panel = el("div", "decision");
        panel.append(el("p", "", "Confirmez que cette annonce est réellement vendue. Cette action retire l'annonce active."));
        const actions = el("div", "item-actions");
        const confirm = el("button", "action", "Confirmer la vente");
        const cancel = el("button", "action secondary", "Annuler");
        confirm.type = "button";
        cancel.type = "button";
        cancel.addEventListener("click", () => panel.remove());
        confirm.addEventListener("click", async () => {
          confirm.disabled = true;
          try {
            const response = await http("/v1/miniapp/marketplace-sold", {
              method: "POST", body: JSON.stringify({ id: item.id })
            });
            if (!response.changed) throw new Error("ACTION_CONFLICT");
            status("Annonce marquée comme vendue.", "ok");
            await load();
          } catch (error) {
            confirm.disabled = false;
            status("Modification refusée : " + error.message, "error");
          }
        });
        actions.append(confirm, cancel);
        panel.append(actions);
        body.append(panel);
      });
      actions.append(sold);
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
    staffRole = linked && result.staff ? result.staff.role : "vendeur";
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
  $("open-erp").addEventListener("click", (event) => {
    event.preventDefault();
    if (!config) return;
    const url = config.xeptionSiteUrl + "/admin";
    if (telegram.openLink) telegram.openLink(url);
    else window.open(url, "_blank", "noopener");
  });
  // One-time code issued by the Xeption ERP ("Lier mon Telegram"), carried by
  // t.me/<bot>?startapp=<code>. No credentials are ever typed in Telegram.
  const startParam = telegram && telegram.initDataUnsafe && telegram.initDataUnsafe.start_param;
  const LINK_ERRORS = {
    LINK_CODE_INVALID: "Lien expiré ou déjà utilisé. Générez-en un nouveau depuis l'ERP.",
    NOT_XEPTION_STAFF: "Compte non autorisé pour le staff.",
    TELEGRAM_ALREADY_LINKED: "Ce compte Telegram est déjà associé à un autre membre du staff."
  };
  const linkWithCode = async (code) => {
    status("Association de votre compte Xeption…");
    try {
      linkedSession(await http("/v1/miniapp/link", {
        method: "POST", body: JSON.stringify({ linkCode: code })
      }));
    } catch (e) {
      status(LINK_ERRORS[e.message] || "Association impossible : " + e.message, "error");
    }
  };
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
      if (!result.linked && typeof startParam === "string" && /^[0-9a-f]{32}$/.test(startParam)) {
        await linkWithCode(startParam);
      }
    } catch (e) {
      status(e.message === "MINIAPP_NOT_CONFIGURED"
        ? "Mini App non encore configurée sur le serveur."
        : "Connexion impossible : " + e.message, "error");
    }
  };
  void boot();
})();
