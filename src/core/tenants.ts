/**
 * An application must opt in to each channel and approve its own action domain.
 * Prevents accidental cross-tenant messages and action-link phishing.
 */
import {
  parseNotifyEvent,staffMessage,type Channel,
  type NotifyEventV1,type SafeStaffMessage
} from "./contracts.js";

export interface TenantPolicy {
  project:string;
  allowedActionOrigins:readonly string[];
  channels:Partial<Record<Channel,boolean>>;
}
export class TenantPolicyError extends Error {
  constructor(readonly code:"UNKNOWN_TENANT"|"CHANNEL_DISABLED"|"ACTION_ORIGIN_DENIED"|"INVALID_ORIGIN") {
    super(code);
  }
}
function allowedOrigins(values:readonly string[]):Set<string> {
  const origins=new Set<string>();
  for(const value of values) {
    let url:URL;
    try {url=new URL(value);} catch {throw new TenantPolicyError("INVALID_ORIGIN");}
    if(url.protocol!=="https:" || url.pathname!=="/" || url.search || url.hash ||
       url.username || url.password || url.port) throw new TenantPolicyError("INVALID_ORIGIN");
    origins.add(url.origin);
  }
  return origins;
}
/**
 * Does not persist or send. Consumers must first claim an event from the
 * application's durable outbox and update each channel's delivery separately.
 */
export function prepareDelivery(
  incoming:NotifyEventV1, policy:TenantPolicy,channel:Channel
):SafeStaffMessage {
  const event=parseNotifyEvent(incoming);
  if(event.project!==policy.project)throw new TenantPolicyError("UNKNOWN_TENANT");
  if(policy.channels[channel]!==true)throw new TenantPolicyError("CHANNEL_DISABLED");
  const origins=allowedOrigins(policy.allowedActionOrigins);
  if(event.actionUrl && !origins.has(new URL(event.actionUrl).origin))
    throw new TenantPolicyError("ACTION_ORIGIN_DENIED");
  return staffMessage(event);
}
