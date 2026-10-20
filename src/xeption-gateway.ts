import { MiniAppError } from "./telegram-auth.js";

export interface MiniAppSettings {
  enabled: boolean;
  writesEnabled: boolean;
  botToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceKey: string;
  xeptionSiteUrl: string;
}

export type StaffRole = "vendeur" | "responsable" | "direction" | "super_admin";
export interface StaffIdentity {
  telegramUserId: string;
  authUserId: string;
  name: string;
  role: StaffRole;
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): MiniAppSettings {
  const url = (env.XEPTION_SUPABASE_URL || "").replace(/\/+$/, "");
  const site = (env.XEPTION_SITE_URL || "https://www.xeptionetwork.shop").replace(/\/+$/, "");
  if (url && (!/^https:\/\//.test(url) || !/^https:\/\//.test(site))) {
    throw new Error("Mini App upstream URLs must use HTTPS");
  }
  return {
    enabled: env.MINIAPP_ENABLED === "true",
    writesEnabled: env.MINIAPP_WRITES_ENABLED === "true",
    botToken: env.TELEGRAM_BOT_TOKEN || "",
    supabaseUrl: url,
    supabaseAnonKey: env.XEPTION_SUPABASE_ANON_KEY || "",
    supabaseServiceKey: env.XEPTION_SUPABASE_SERVICE_ROLE_KEY || "",
    xeptionSiteUrl: site
  };
}

export function normalizedRole(value: unknown): StaffRole | null {
  if (value === "editor") return "vendeur";
  if (value === "manager" || value === "manager_vente") return "responsable";
  if (value === "admin") return "direction";
  return value === "vendeur" || value === "responsable" || value === "direction" || value === "super_admin" ? value : null;
}

const ROLE_RANK: Record<StaffRole, number> = {
  vendeur: 0, responsable: 1, direction: 2, super_admin: 3
};
export function roleAllows(role: StaffRole, target: unknown): boolean {
  if (target === null || target === undefined || target === "" || target === "all") return true;
  const expected = normalizedRole(target);
  return expected !== null && ROLE_RANK[role] >= ROLE_RANK[expected];
}

type Json = Record<string, unknown>;

export class XeptionGateway {
  constructor(readonly settings: MiniAppSettings, private readonly request: typeof fetch = fetch) {}

  isConfigured(): boolean {
    return !!(this.settings.enabled && this.settings.botToken && this.settings.supabaseUrl &&
      this.settings.supabaseAnonKey && this.settings.supabaseServiceKey);
  }

  private async api(
    path: string, query: Record<string, string> = {},
    opts: { method?: string; payload?: Json; service?: boolean; bearer?: string } = {}
  ): Promise<unknown> {
    const url = new URL(path, this.settings.supabaseUrl + "/");
    Object.entries(query).forEach(([name, value]) => url.searchParams.set(name, value));
    const key = opts.service === false ? this.settings.supabaseAnonKey : this.settings.supabaseServiceKey;
    const res = await this.request(url, {
      method: opts.method || "GET",
      headers: {
        apikey: key,
        Authorization: "Bearer " + (opts.bearer || key),
        ...(opts.payload ? { "Content-Type": "application/json" } : {}),
        ...(opts.method === "POST" ? { Prefer: "return=representation" } : {})
      },
      body: opts.payload ? JSON.stringify(opts.payload) : undefined,
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      // Never leak Supabase error bodies or secrets.
      if (res.status === 400) throw new MiniAppError(409, "ACTION_CONFLICT");
      if (res.status === 409) throw new MiniAppError(409, "ALREADY_LINKED");
      if (res.status === 401 || res.status === 403) throw new MiniAppError(401, "XEPTION_AUTH_FAILED");
      throw new MiniAppError(502, "XEPTION_UPSTREAM_ERROR");
    }
    if (res.status === 204) return null;
    return await res.json() as unknown;
  }

  private async staffByEmail(email: string): Promise<{name: string; role: StaffRole}> {
    const rows = await this.api("/rest/v1/staff", {
      select: "name,email,role",
      email: "eq." + email,
      limit: "1"
    });
    const row = Array.isArray(rows) ? rows[0] as Json | undefined : undefined;
    const role = normalizedRole(row?.role);
    if (!row || !role) throw new MiniAppError(403, "NOT_XEPTION_STAFF");
    return { name: typeof row.name === "string" ? row.name : email, role };
  }

  private async linkedUser(telegramUserId: string): Promise<string | null> {
    const rows = await this.api("/rest/v1/telegram_staff_links", {
      select: "auth_user_id",
      telegram_user_id: "eq." + telegramUserId,
      revoked_at: "is.null",
      limit: "1"
    });
    const row = Array.isArray(rows) ? rows[0] as Json | undefined : undefined;
    return typeof row?.auth_user_id === "string" ? row.auth_user_id : null;
  }

  async linkTelegram(telegramUserId: string, xeptionAccessToken: string): Promise<StaffIdentity> {
    if (!xeptionAccessToken || xeptionAccessToken.length > 5000) {
      throw new MiniAppError(401, "XEPTION_AUTH_FAILED");
    }
    const user = await this.api("/auth/v1/user", {}, {
      service: false,
      bearer: xeptionAccessToken
    }) as Json;
    if (typeof user.id !== "string" || typeof user.email !== "string") {
      throw new MiniAppError(401, "XEPTION_AUTH_FAILED");
    }
    const staff = await this.staffByEmail(user.email.trim().toLowerCase());
    const previous = await this.linkedUser(telegramUserId);
    if (previous && previous !== user.id) throw new MiniAppError(409, "TELEGRAM_ALREADY_LINKED");
    if (!previous) {
      await this.api("/rest/v1/telegram_staff_links", {}, {
        method: "POST",
        payload: { telegram_user_id: telegramUserId, auth_user_id: user.id }
      });
    }
    return { telegramUserId, authUserId: user.id, ...staff };
  }

  async requireLinkedStaff(telegramUserId: string): Promise<StaffIdentity> {
    const userId = await this.linkedUser(telegramUserId);
    if (!userId) throw new MiniAppError(403, "LINK_XEPTION_ACCOUNT");
    // Re-check Supabase Auth AND current staff role on every request, not just at linking.
    const user = await this.api("/auth/v1/admin/users/" + encodeURIComponent(userId)) as Json;
    if (typeof user.email !== "string" || user.banned_until && new Date(String(user.banned_until)).getTime() > Date.now()) {
      throw new MiniAppError(403, "XEPTION_ACCOUNT_DISABLED");
    }
    const staff = await this.staffByEmail(user.email.trim().toLowerCase());
    return { telegramUserId, authUserId: userId, ...staff };
  }

  async list(category: string, staff: StaffIdentity): Promise<Json[]> {
    const resource = category === "stock"
      ? ["/rest/v1/products", {select:"id,name,stock,price",stock:"lte.2",order:"name.asc",limit:"60"}]
      : category === "images"
      ? ["/rest/v1/products", {select:"id,name,image,price",or:"(image.is.null,image.eq.,image.ilike.*placeholder*,image.ilike.*icon-192*)",order:"name.asc",limit:"60"}]
      : category === "trocs"
      ? ["/rest/v1/trade_in_requests", {select:"id,device_brand,device_model,status,trade_in_value_cash,trade_in_value,target_product_name,created_at",status:"in.(pending,accepted,contacted,appointment)",order:"created_at.desc",limit:"60"}]
      : category === "marketplace"
      ? ["/rest/v1/marketplace_listings", {select:"id,device_brand,device_model,grade,price_min,price_max,status,city,created_at",order:"created_at.desc",limit:"60"}]
      : category === "alerts"
      ? ["/rest/v1/admin_notifications", {select:"id,title,event_type,link_to_tab,link_to_id,target_role,created_at,read_at",read_at:"is.null",order:"created_at.desc",limit:"60"}]
      : null;
    if (!resource) throw new MiniAppError(400, "INVALID_CATEGORY");
    if (category === "trocs" && !roleAllows(staff.role, "responsable")) {
      throw new MiniAppError(403, "INSUFFICIENT_ROLE");
    }
    const rows = await this.api(resource[0] as string, resource[1] as Record<string,string>);
    if (!Array.isArray(rows)) throw new MiniAppError(502, "XEPTION_UPSTREAM_ERROR");
    return (rows as Json[]).filter(row => category !== "alerts" || roleAllows(staff.role, row.target_role));
  }

  async trocAction(
    requestId: string, action: "contacted" | "refused",
    reason: string | undefined, staff: StaffIdentity
  ): Promise<{changed: boolean; status?: string}> {
    if (!this.settings.writesEnabled) throw new MiniAppError(403, "MINIAPP_READ_ONLY");
    if (!roleAllows(staff.role, "responsable")) throw new MiniAppError(403, "INSUFFICIENT_ROLE");
    const result = await this.api("/rest/v1/rpc/telegram_staff_troc_action", {}, {
      method: "POST",
      payload: {
        p_request_id: requestId,
        p_action: action,
        p_telegram_user_id: staff.telegramUserId,
        p_reason: reason || null
      }
    }) as Json;
    if (!result || typeof result.changed !== "boolean") {
      throw new MiniAppError(502, "XEPTION_UPSTREAM_ERROR");
    }
    return { changed: result.changed, status: typeof result.status === "string" ? result.status : undefined };
  }

  async markMarketplaceSold(listingId: string, staff: StaffIdentity): Promise<boolean> {
    if (!this.settings.writesEnabled) throw new MiniAppError(403, "MINIAPP_READ_ONLY");
    if (!roleAllows(staff.role, "responsable")) throw new MiniAppError(403, "INSUFFICIENT_ROLE");
    const result = await this.api("/rest/v1/rpc/telegram_staff_mark_marketplace_sold", {}, {
      method: "POST",
      payload: { p_listing_id: listingId, p_telegram_user_id: staff.telegramUserId }
    });
    if (typeof result !== "boolean") throw new MiniAppError(502, "XEPTION_UPSTREAM_ERROR");
    return result;
  }

  async acknowledge(notificationId: string, telegramUserId: string): Promise<boolean> {
    if (!this.settings.writesEnabled) throw new MiniAppError(403, "MINIAPP_READ_ONLY");
    const payload = await this.api("/rest/v1/rpc/ack_staff_notification_from_telegram", {}, {
      method: "POST", payload: { p_notification_id: notificationId, p_telegram_user_id: telegramUserId }
    });
    return payload === true;
  }
}
