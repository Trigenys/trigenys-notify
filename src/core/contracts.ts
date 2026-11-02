/**
 * Provider-independent event envelope for Trigenys products.
 * Sources retain their own durable outboxes; this module NEVER sends.
 */
import {parseStaffFacts,businessFactLines,type StaffEventFacts} from './message-facts.js';
export type {StaffEventFacts} from './message-facts.js';
export const NOTIFY_EVENT_VERSION = 1 as const;
export const XEPTION_EVENT_ALIASES = {
  stock_low: "inventory.stock_low",
  stock_out: "inventory.stock_out",
  product_missing_image: "catalog.product_missing_image",
  troc_submitted: "barter.requested",
  marketplace_listed: "marketplace.listing_created"
} as const;

export type KnownXeptionEvent = keyof typeof XEPTION_EVENT_ALIASES;
export type NotifyPriority = "normal" | "high" | "critical";
export type Channel = "telegram" | "whatsapp_waha";

export interface NotifyEventV1 {
  version: typeof NOTIFY_EVENT_VERSION;
  project: string;
  id: string;
  type: string;
  occurredAt: string;
  priority: NotifyPriority;
  resource: {kind:string;id:string};
  audience: "staff";
  actionUrl?: string;
  facts?: StaffEventFacts;
}

export interface XeptionNotificationRow {
  id:string;
  event_type:string;
  created_at:string;
  link_to_id?:string|null;
}

export interface SafeStaffMessage {
  project:string;
  eventId:string;
  title:string;
  body:string;
  priority:NotifyPriority;
  actionUrl?:string;
  actionLabel?:string;
}

export class InvalidNotifyEvent extends Error {
  constructor(readonly field:string) {super("Invalid notification "+field);}
}
function validId(value:unknown,max=128):value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= max && /^[a-zA-Z0-9._:-]+$/.test(value);
}
function validProject(value:unknown):value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,48}$/.test(value);
}
function validType(value:unknown):value is string {
  return typeof value === "string" && value.length <= 100 &&
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/.test(value);
}
export function parseNotifyEvent(value:unknown):NotifyEventV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidNotifyEvent("body");
  const d = value as Record<string,unknown>;
  if (d.version !== 1) throw new InvalidNotifyEvent("version");
  if (!validProject(d.project)) throw new InvalidNotifyEvent("project");
  if (!validId(d.id)) throw new InvalidNotifyEvent("id");
  if (!validType(d.type)) throw new InvalidNotifyEvent("type");
  if (d.audience !== "staff") throw new InvalidNotifyEvent("audience");
  if (d.priority !== "normal" && d.priority !== "high" && d.priority !== "critical")
    throw new InvalidNotifyEvent("priority");
  if (typeof d.occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(d.occurredAt) ||
    !Number.isFinite(Date.parse(d.occurredAt))) throw new InvalidNotifyEvent("occurredAt");
  const resource = d.resource;
  if (!resource || typeof resource !== "object" || Array.isArray(resource))
    throw new InvalidNotifyEvent("resource");
  const r = resource as Record<string,unknown>;
  if (!validId(r.kind,60) || !validId(r.id)) throw new InvalidNotifyEvent("resource");
  let actionUrl: string | undefined;
  if (d.actionUrl !== undefined) {
    if (typeof d.actionUrl !== "string" || d.actionUrl.length > 1024)
      throw new InvalidNotifyEvent("actionUrl");
    let url:URL;
    try {url = new URL(d.actionUrl);} catch {throw new InvalidNotifyEvent("actionUrl");}
    if (url.protocol !== "https:" || url.username || url.password ||
      url.hash || !url.hostname || url.port) throw new InvalidNotifyEvent("actionUrl");
    actionUrl = url.href;
  }
  let facts:StaffEventFacts|undefined;
  try{facts=parseStaffFacts(d.facts);}catch{throw new InvalidNotifyEvent('facts');}
  return {
    version:1,project:d.project,id:d.id,type:d.type,occurredAt:d.occurredAt,
    priority:d.priority,resource:{kind:r.kind,id:r.id},audience:"staff",
    ...(actionUrl ? {actionUrl} : {}),...(facts?{facts}:{})
  };
}
/** Must be unique inside the SOURCE application's durable delivery table. */
export function deliveryKey(event:NotifyEventV1,channel:Channel):string {
  if (channel !== "telegram" && channel !== "whatsapp_waha")
    throw new InvalidNotifyEvent("channel");
  return JSON.stringify([event.project,event.id,channel]);
}
/** Does not copy freeform title, message, phone or client details. */
export function fromXeptionNotification(
  row:XeptionNotificationRow,config:{siteUrl:string}
):NotifyEventV1|null {
  if (!Object.hasOwn(XEPTION_EVENT_ALIASES,row.event_type)) return null;
  const type = row.event_type as KnownXeptionEvent;
  let site:URL;
  try {site = new URL(config.siteUrl);}catch {throw new InvalidNotifyEvent("siteUrl");}
  if (site.protocol !== "https:" || site.username || site.password ||
      site.port || site.hash || site.search) throw new InvalidNotifyEvent("siteUrl");
  const tab = {
    stock_low:"inventory",stock_out:"inventory",product_missing_image:"inventory",
    troc_submitted:"troc",marketplace_listed:"marketplace"
  }[type];
  return parseNotifyEvent({
    version:1,project:"xeption",id:row.id,
    type:XEPTION_EVENT_ALIASES[type],occurredAt:row.created_at,
    priority:type==="stock_out"?"critical":type==="stock_low"?"high":"normal",
    resource:{kind:tab,id:row.link_to_id || row.id},
    audience:"staff", actionUrl:new URL("/admin/"+tab,site).toString()
  });
}
const SAFE_TEMPLATES:Record<string,{title:string;detail:string}> = {
  "inventory.stock_low":{title:"📦 Stock faible",detail:"Un produit nécessite un réapprovisionnement."},
  "inventory.stock_out":{title:"🚨 Rupture de stock",detail:"Un produit est en rupture de stock."},
  "catalog.product_missing_image":{title:"🖼️ Photo manquante",detail:"Une fiche produit doit être complétée."},
  "barter.requested":{title:"🔄 Nouvelle demande de troc",detail:"Un dossier est à examiner."},
  "marketplace.listing_created":{title:"🛍️ Nouvelle annonce Marketplace",detail:"Une annonce vient d'être ajoutée."},
  "order.created":{title:"🛒 Nouvelle commande",detail:"Une commande est à traiter."},
  "order.paid":{title:"💳 Paiement reçu",detail:"Une commande vient d'être payée."},
  "barter.voucher_expiring":{title:"⏳ Bon troc bientôt expiré",detail:"Un bon d'achat troc expire bientôt."},
  "cash_report.closed":{title:"🧾 Clôture de caisse",detail:"Une boutique a clôturé sa caisse."},
  "finance.debt_overdue":{title:"📋 Dettes en attente",detail:"Des dettes clients de plus de 7 jours sont à relancer."}
};
const ACTION_LABELS:Record<string,string> = {
  "barter.requested":"Ouvrir le dossier","barter.voucher_expiring":"Ouvrir le dossier",
  "marketplace.listing_created":"Voir la marketplace",
  "order.created":"Ouvrir la commande","order.paid":"Ouvrir la commande",
  "cash_report.closed":"Ouvrir l'espace pro","finance.debt_overdue":"Ouvrir l'espace pro"
};
export function staffMessage(event:NotifyEventV1):SafeStaffMessage {
  const valid=parseNotifyEvent(event);
  const template=Object.hasOwn(SAFE_TEMPLATES,valid.type) ?
    SAFE_TEMPLATES[valid.type] :
    {title:"🔔 Nouvelle alerte",detail:"Une intervention du personnel est nécessaire."};
  const lines=businessFactLines(valid.type,valid.facts);
  const actionLabel=Object.hasOwn(ACTION_LABELS,valid.type)?ACTION_LABELS[valid.type]:'Ouvrir le produit';
  return {
    project:valid.project,eventId:valid.id,title:template.title,
    body:lines.length?lines.join('\n'):template.detail+"\nConsultez l'espace professionnel pour les détails.",
    priority:valid.priority,
    ...(valid.actionUrl?{actionUrl:valid.actionUrl,...(lines.length?{actionLabel}:{})}:{})
  };
}

