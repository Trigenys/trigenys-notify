/**
 * Per-event-type narrowing of a project's WhatsApp groups (declarative, no code per type).
 *
 * WAHA_EVENT_GROUPS_JSON = {"report.weekly_digest":["120363...@g.us"]}
 * - a listed type only reaches the listed groups that are ALREADY routed to the project:
 *   the setting can narrow a delivery, never add a destination;
 * - an unlisted type keeps every routed group (existing behaviour unchanged);
 * - malformed settings throw: the dispatcher fails closed instead of broadcasting.
 */
import {groupIdPattern,type ProjectGroup} from './group-routing.js';

const eventTypePattern=/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const MAX_GROUPS_PER_TYPE=20;

export function parseEventGroups(raw:string|undefined):Map<string,Set<string>>{
  const routes=new Map<string,Set<string>>();
  if(raw===undefined||!raw.trim())return routes;
  const decoded:unknown=JSON.parse(raw);
  if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw Error('EVENT_GROUPS_INVALID');
  for(const [type,groups] of Object.entries(decoded)){
    if(!eventTypePattern.test(type)||!Array.isArray(groups)||!groups.length||groups.length>MAX_GROUPS_PER_TYPE||
      !groups.every(g=>typeof g==='string'&&groupIdPattern.test(g)))throw Error('EVENT_GROUPS_INVALID');
    routes.set(type,new Set(groups as string[]));
  }
  return routes;
}

export function restrictToEventGroups(recipients:ProjectGroup[],type:string,raw:string|undefined):ProjectGroup[]{
  const allowed=parseEventGroups(raw).get(type);
  return allowed?recipients.filter(r=>allowed.has(r.groupId)):recipients;
}
