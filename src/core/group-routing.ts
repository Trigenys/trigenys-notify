/**
 * Trigenys Notify: group discovery and explicit project-to-group bindings.
 * WAHA reports groups. Only an authorized administrator may bind a project.
 *
 * Durable storage requires Cloudflare D1. In its absence the webhook and
 * administration routes fail closed; existing Xeption dispatch remains intact.
 */
import {WahaGroupDirectory,matchesProject,type DiscoveredGroup} from './waha-groups.js';

export interface NotifyStatement {
  run():Promise<unknown>;
  first<T=Record<string,unknown>>():Promise<T|null>;
  all<T=Record<string,unknown>>():Promise<{results:T[]}>;
}
export interface NotifyDatabase {
  prepare(sql:string):{bind(...args:(string|number|null)[]):NotifyStatement};
  batch(statements:NotifyStatement[]):Promise<unknown>;
}
export interface ProjectGroup {session:string;groupId:string;}

export interface GroupEnv {
  NOTIFY_DB?:NotifyDatabase;
  WAHA_WEBHOOK_HMAC_KEY?:string;
  NOTIFY_ADMIN_KEY?:string;
  WAHA_SESSION?:string;
  WAHA_BASE_URL?:string;
  WAHA_API_KEY?:string;
}
export const groupIdPattern=/^[0-9-]+@g\.us$/;
const projectPattern=/^[a-z][a-z0-9-]{1,48}$/;
const permittedProjects=new Set(["xeption","atelier-maitre","commerce-factory"]);
const eventNames=new Set(["group.v2.join","group.v2.leave","group.v2.update"]);
const reply=(status:number,payload:object)=>new Response(JSON.stringify(payload),{
  status,headers:{"content-type":"application/json","cache-control":"no-store"}
});
function equal(a:string,b:string):boolean {
  const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);
  let diff=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++)diff|=(x[i]??0)^(y[i]??0);
  return diff===0;
}
export async function authenticateWebhook(
  request:Request,key:string,raw:string
):Promise<boolean>{
  if(key.length<32||request.headers.get("x-webhook-hmac-algorithm")!=="sha512")return false;
  const timestamp=Number(request.headers.get("x-webhook-timestamp")??"");
  if(!Number.isSafeInteger(timestamp)||Math.abs(Date.now()-timestamp)>300000)return false;
  const signature=request.headers.get("x-webhook-hmac")??"";
  if(!/^[0-9a-f]{128}$/i.test(signature))return false;
  const cryptoKey=await crypto.subtle.importKey("raw",new TextEncoder().encode(key),
    {name:"HMAC",hash:"SHA-512"},false,["sign"]);
  const actual=await crypto.subtle.sign("HMAC",cryptoKey,new TextEncoder().encode(raw));
  const expected=Array.from(new Uint8Array(actual)).map(v=>v.toString(16).padStart(2,"0")).join("");
  return equal(signature.toLowerCase(),expected);
}
function groupFromEvent(data:unknown):{
  event:string;session:string;groupId:string;name:string
}|null{
  if(!data||typeof data!=="object")return null;
  const d=data as Record<string,unknown>,payload=d.payload;
  if(typeof d.event!=="string"||!eventNames.has(d.event)||
     typeof d.session!=="string"||!/^[-_a-zA-Z0-9]{1,48}$/.test(d.session)||
     !payload||typeof payload!=="object")return null;
  const group=(payload as Record<string,unknown>).group;
  if(!group||typeof group!=="object")return null;
  const g=group as Record<string,unknown>;
  if(typeof g.id!=="string"||!groupIdPattern.test(g.id))return null;
  return {event:d.event,session:d.session,groupId:g.id,
    name:typeof g.subject==="string"?g.subject.slice(0,120):""};
}
export async function handleGroupWebhook(
  request:Request,env:GroupEnv
):Promise<Response>{
  if(request.method!=="POST")return reply(405,{error:"METHOD_NOT_ALLOWED"});
  if(!env.NOTIFY_DB)return reply(503,{error:"GROUP_REGISTRY_UNAVAILABLE"});
  if(Number(request.headers.get("content-length")||0)>16384)
    return reply(413,{error:"BODY_TOO_LARGE"});
  const raw=await request.text();
  if(new TextEncoder().encode(raw).length>16384)return reply(413,{error:"BODY_TOO_LARGE"});
  if(!await authenticateWebhook(request,env.WAHA_WEBHOOK_HMAC_KEY??"",raw))
    return reply(401,{error:"UNAUTHORIZED"});
  let data:unknown;
  try{data=JSON.parse(raw);}catch{return reply(400,{error:"INVALID_JSON"});}
  const group=groupFromEvent(data);
  if(!group)return reply(400,{error:"INVALID_GROUP_EVENT"});
  if(env.WAHA_SESSION && group.session!==env.WAHA_SESSION)
    return reply(400,{error:"UNKNOWN_SESSION"});
  const db=env.NOTIFY_DB;
  const arrived=Date.now();
  if(group.event==="group.v2.join"){
    await db.prepare(
      `INSERT INTO notify_whatsapp_groups(session,group_id,group_name,state,last_seen_ms)
       VALUES(?1,?2,?3,'available',?4)
       ON CONFLICT(session,group_id) DO UPDATE SET
       group_name=CASE WHEN excluded.group_name<>'' THEN excluded.group_name
            ELSE notify_whatsapp_groups.group_name END,
       state='available',last_seen_ms=excluded.last_seen_ms
       WHERE excluded.last_seen_ms>=notify_whatsapp_groups.last_seen_ms`
    ).bind(group.session,group.groupId,group.name,arrived).run();
  }else if(group.event==="group.v2.leave"){
    await db.prepare(
      `UPDATE notify_whatsapp_groups SET state='left',last_seen_ms=?3
       WHERE session=?1 AND group_id=?2 AND last_seen_ms<=?3`
    ).bind(group.session,group.groupId,arrived).run();
    await db.prepare(
      `UPDATE notify_whatsapp_routes SET enabled=0
       WHERE session=?1 AND group_id=?2`
    ).bind(group.session,group.groupId).run();
  }else{
    await db.prepare(
      `UPDATE notify_whatsapp_groups SET
       group_name=CASE WHEN ?3<>'' THEN ?3 ELSE group_name END,
       last_seen_ms=?4
       WHERE session=?1 AND group_id=?2 AND last_seen_ms<=?4`
    ).bind(group.session,group.groupId,group.name,arrived).run();
  }
  // WAHA may retry; all operations are idempotent.
  return reply(200,{accepted:true});
}
export async function resolveProjectGroups(
  db:NotifyDatabase,project:string
):Promise<ProjectGroup[]>{
  if(!projectPattern.test(project))return [];
  const rows=await db.prepare(
    `SELECT r.session AS session,r.group_id AS groupId
     FROM notify_whatsapp_routes r
     JOIN notify_whatsapp_groups g
       ON g.session=r.session AND g.group_id=r.group_id
     WHERE r.project=?1 AND r.enabled=1 AND g.state='available'
     ORDER BY r.session,r.group_id`
  ).bind(project).all<ProjectGroup>();
  return rows.results.filter(r=>groupIdPattern.test(r.groupId)&&/^[-_a-zA-Z0-9]{1,48}$/.test(r.session));
}
/** Compatibility for existing consumers; new dispatch uses all recipients. */
export async function resolveProjectGroup(db:NotifyDatabase,project:string):Promise<ProjectGroup|null>{
  return (await resolveProjectGroups(db,project))[0]??null;
}

export async function projectHasCandidates(db:NotifyDatabase,project:string,session:string):Promise<boolean>{
  const associated=await db.prepare(`SELECT project FROM notify_whatsapp_routes
    WHERE project=?1 LIMIT 1`).bind(project).first();
  if(associated)return true; // A revocation or departure must not silently switch groups.
  const groups=await db.prepare(`SELECT group_name FROM notify_whatsapp_groups
    WHERE session=?1 AND state='available'`).bind(session).all<{group_name:string}>();
  return groups.results.some(g=>matchesProject(g.group_name,project));
}

export async function reconcileGroups(db:NotifyDatabase,session:string,groups:DiscoveredGroup[],
  startedAt=Date.now()):Promise<void>{
  const statements=groups.map(g=>db.prepare(`INSERT INTO notify_whatsapp_groups
    (session,group_id,group_name,state,last_seen_ms) VALUES(?1,?2,?3,'available',?4)
    ON CONFLICT(session,group_id) DO UPDATE SET group_name=excluded.group_name,
    state='available',last_seen_ms=excluded.last_seen_ms
    WHERE notify_whatsapp_groups.last_seen_ms<=excluded.last_seen_ms`)
    .bind(session,g.id,g.name,startedAt));
  statements.push(db.prepare(`UPDATE notify_whatsapp_groups SET state='left',last_seen_ms=?3
    WHERE session=?1 AND last_seen_ms<=?3 AND group_id NOT IN
      (SELECT value FROM json_each(?2))`)
    .bind(session,JSON.stringify(groups.map(g=>g.id)),startedAt));
  statements.push(db.prepare(`UPDATE notify_whatsapp_routes SET enabled=0 WHERE session=?1
    AND group_id IN (SELECT group_id FROM notify_whatsapp_groups WHERE session=?1 AND state='left')`)
    .bind(session));
  statements.push(db.prepare(`INSERT INTO notify_whatsapp_discovery(session,last_synced_ms)
    VALUES(?1,?2) ON CONFLICT(session) DO UPDATE SET last_synced_ms=MAX(last_synced_ms,excluded.last_synced_ms)`)
    .bind(session,startedAt));
  // All changes commit together; a partial provider listing is never imported.
  await db.batch(statements);
}

export async function syncWahaGroups(env:GroupEnv,http:typeof fetch=fetch,force=false):Promise<number|null>{
  if(!env.NOTIFY_DB||!env.WAHA_BASE_URL||!env.WAHA_API_KEY||!env.WAHA_SESSION)
    throw Error('WAHA_DISCOVERY_NOT_CONFIGURED');
  const db=env.NOTIFY_DB,startedAt=Date.now();
  const previous=await db.prepare(`SELECT last_synced_ms FROM notify_whatsapp_discovery WHERE session=?1`)
    .bind(env.WAHA_SESSION).first<{last_synced_ms:number}>();
  if(!force&&previous&&startedAt-previous.last_synced_ms<60000)return null;
  const groups=await new WahaGroupDirectory({baseUrl:env.WAHA_BASE_URL,
    apiKey:env.WAHA_API_KEY,session:env.WAHA_SESSION},http).list();
  await reconcileGroups(db,env.WAHA_SESSION,groups,startedAt);
  return groups.length;
}

export async function handleGroupAdmin(request:Request,env:GroupEnv,http:typeof fetch=fetch):Promise<Response>{
  if(!env.NOTIFY_DB)return reply(503,{error:"GROUP_REGISTRY_UNAVAILABLE"});
  const key=env.NOTIFY_ADMIN_KEY??"";
  if(key.length<32||!equal(request.headers.get("x-notify-admin-key")??"",key))
    return reply(401,{error:"UNAUTHORIZED"});
  const path=new URL(request.url).pathname,db=env.NOTIFY_DB;
  if(path==='/v1/whatsapp/groups/sync'&&request.method==='POST'){
    try{return reply(200,{discovered:await syncWahaGroups(env,http,true),autoAssigned:0});}
    catch{return reply(503,{error:'WAHA_DISCOVERY_UNAVAILABLE'});}
  }
  if(path==="/v1/whatsapp/groups"&&request.method==="GET"){
    const result=await db.prepare(
      `SELECT g.session,g.group_id AS groupId,g.group_name AS name,g.state,
       r.project,r.enabled FROM notify_whatsapp_groups g
       LEFT JOIN notify_whatsapp_routes r
       ON g.session=r.session AND g.group_id=r.group_id
       ORDER BY g.last_seen_ms DESC LIMIT 200`
    ).bind().all();
    return reply(200,{groups:result.results.map(row=>({...row,
      suggestedProjects:[...permittedProjects].filter(p=>matchesProject(String(row.name??''),p))
    }))});
  }
  // One-time reconciliation for groups that existed before webhook setup.
  // The imported list is admin-authorized and never automatically routes.
  if(path==="/v1/whatsapp/groups/import"&&request.method==="POST"){
    if(Number(request.headers.get("content-length")||0)>65536)
      return reply(413,{error:"BODY_TOO_LARGE"});
    const raw=await request.text();
    if(raw.length>65536)return reply(413,{error:"BODY_TOO_LARGE"});
    let input:Record<string,unknown>;
    try{const d=JSON.parse(raw);if(!d||typeof d!=="object"||Array.isArray(d))throw Error();
      input=d;}catch{return reply(400,{error:"INVALID_JSON"});}
    const session=input.session;
    if(typeof session!=="string"||!/^[-_a-zA-Z0-9]{1,48}$/.test(session)||
      (env.WAHA_SESSION&&session!==env.WAHA_SESSION)||
      !Array.isArray(input.groups)||input.groups.length>200)
      return reply(400,{error:"INVALID_GROUP_SNAPSHOT"});
    const groups:{id:string;name:string}[]=[];
    for(const row of input.groups){
      if(!row||typeof row!=="object"||Array.isArray(row))
        return reply(400,{error:"INVALID_GROUP_SNAPSHOT"});
      const g=row as Record<string,unknown>;
      if(typeof g.id!=="string"||!groupIdPattern.test(g.id)||
        typeof g.subject!=="string"||g.subject.length>120)
        return reply(400,{error:"INVALID_GROUP_SNAPSHOT"});
      groups.push({id:g.id,name:g.subject});
    }
    const timestamp=Date.now();
    for(const g of groups){
      await db.prepare(
        `INSERT INTO notify_whatsapp_groups(session,group_id,group_name,state,last_seen_ms)
         VALUES(?1,?2,?3,'available',?4)
         ON CONFLICT(session,group_id) DO UPDATE SET
         group_name=excluded.group_name,
         last_seen_ms=excluded.last_seen_ms
         WHERE notify_whatsapp_groups.state='available'`
      ).bind(session,g.id,g.name,timestamp).run();
    }
    return reply(200,{imported:groups.length,autoAssigned:0});
  }
  if(path==="/v1/whatsapp/routes"&&request.method==="POST"){
    if(Number(request.headers.get("content-length")||0)>2048)return reply(413,{error:"BODY_TOO_LARGE"});
    const raw=await request.text();
    if(raw.length>2048)return reply(413,{error:"BODY_TOO_LARGE"});
    let input:Record<string,unknown>;
    try{const d=JSON.parse(raw);if(!d||typeof d!=="object"||Array.isArray(d))throw Error();
      input=d;}catch{return reply(400,{error:"INVALID_JSON"});}
    const project=input.project,session=input.session,groupId=input.groupId;
    if(typeof project!=="string"||!permittedProjects.has(project)||
      typeof session!=="string"||!/^[-_a-zA-Z0-9]{1,48}$/.test(session)||
      typeof groupId!=="string"||!groupIdPattern.test(groupId)||
      (input.enabled!==undefined&&typeof input.enabled!=='boolean')||
      (env.WAHA_SESSION&&session!==env.WAHA_SESSION))
      return reply(400,{error:"INVALID_ROUTE"});
    if(input.enabled===false){
      await db.prepare(`UPDATE notify_whatsapp_routes SET enabled=0
        WHERE project=?1 AND session=?2 AND group_id=?3`).bind(project,session,groupId).run();
      return reply(200,{project,associated:false});
    }
    const group=await db.prepare(
      `SELECT state FROM notify_whatsapp_groups WHERE session=?1 AND group_id=?2`
    ).bind(session,groupId).first<{state:string}>();
    if(!group||group.state!=="available")return reply(409,{error:"GROUP_NOT_AVAILABLE"});
    await db.prepare(
      `INSERT INTO notify_whatsapp_routes(project,session,group_id,enabled,approved_at)
       VALUES(?1,?2,?3,1,datetime('now'))
       ON CONFLICT(project,session,group_id) DO UPDATE SET
       enabled=1,approved_at=excluded.approved_at`
    ).bind(project,session,groupId).run();
    return reply(200,{project,associated:true});
  }
  return reply(404,{error:"NOT_FOUND"});
}

