import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticateWebhook,handleGroupWebhook,handleGroupAdmin,resolveProjectGroup,
  type NotifyDatabase,type GroupEnv
} from "../../src/core/group-routing.js";
import {dispatchXeptionWhatsApp} from "../../src/core/dispatch.js";

type Group={session:string;id:string;name:string;state:string;seen:number};
type Route={session:string;groupId:string;enabled:boolean};
function fakeDb(){
  const groups=new Map<string,Group>();
  const routes=new Map<string,Route>();
  const statements:string[]=[];
  const db:NotifyDatabase={
    prepare(sql){
      statements.push(sql);
      return {
        bind(...args){
          return {
            async run(){
              if(sql.includes("INSERT INTO notify_whatsapp_groups")){
                const [session,id,name,time]=args as [string,string,string,number];
                const key=session+"/"+id;
                const old=groups.get(key);
                groups.set(key,{session,id,name:name||old?.name||"",state:"available",seen:time});
              }else if(sql.includes("UPDATE notify_whatsapp_groups SET state='left'")){
                const [session,id]=args;
                const group=groups.get(session+"/"+id);
                if(group)group.state="left";
              }else if(sql.includes("UPDATE notify_whatsapp_groups SET")&&sql.includes("group_name")){
                const [session,id,name]=args;
                const group=groups.get(session+"/"+id);
                if(group&&name)group.name=String(name);
              }else if(sql.includes("UPDATE notify_whatsapp_routes SET enabled=0")){
                const [session,id]=args;
                for(const route of routes.values()){
                  if(route.session===session&&route.groupId===id)route.enabled=false;
                }
              }else if(sql.includes("INSERT INTO notify_whatsapp_routes")){
                const [project,session,groupId]=args as [string,string,string];
                routes.set(project,{session,groupId,enabled:true});
              }
              return {};
            },
            async first<T>(){
              if(sql.includes("SELECT state FROM notify_whatsapp_groups")){
                const group=groups.get(args[0]+"/"+args[1]);
                return (group?{state:group.state}:null) as T|null;
              }
              if(sql.includes("SELECT r.session AS session")){
                const row=routes.get(String(args[0]));
                const group=row&&groups.get(row.session+"/"+row.groupId);
                return (row?.enabled&&group?.state==="available"?
                  {session:row.session,groupId:row.groupId}:null) as T|null;
              }
              return null;
            },
            async all<T>(){
              const results=Array.from(groups.values()).map(g=>({
                session:g.session,groupId:g.id,name:g.name,state:g.state,
                project:Array.from(routes.entries()).find(([,r])=>r.groupId===g.id)?.[0]||null
              }));
              return {results:results as T[]};
            }
          };
        }
      };
    }
  };
  return {db,groups,routes,statements};
}
const key="private-hmac-secret-with-at-least-32-characters";
const adminKey="private-admin-key-with-at-least-32-characters";
const id="120363123456789@g.us";
const session="trigenys-test";
const webUrl="https://notify.example.com/v1/whatsapp/groups/webhook";
const adminUrl="https://notify.example.com/v1/whatsapp/routes";
async function eventRequest(event:string,signWith=key){
  const body=JSON.stringify({event,session,payload:{group:{id,subject:"TRIGENYS GROUP"}}});
  const cryptoKey=await crypto.subtle.importKey("raw",new TextEncoder().encode(signWith),
    {name:"HMAC",hash:"SHA-512"},false,["sign"]);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",cryptoKey,new TextEncoder().encode(body))))
    .map(x=>x.toString(16).padStart(2,"0")).join("");
  return new Request(webUrl,{method:"POST",body,headers:{
    "content-type":"application/json",
    "x-webhook-hmac":signature,
    "x-webhook-hmac-algorithm":"sha512",
    "x-webhook-timestamp":String(Date.now())
  }});
}
function env(db:NotifyDatabase):GroupEnv{
  return {NOTIFY_DB:db,WAHA_SESSION:session,WAHA_WEBHOOK_HMAC_KEY:key,NOTIFY_ADMIN_KEY:adminKey};
}
test("new group is discovered only after signed WAHA group join",async()=>{
  const data=fakeDb();
  const attacker=await eventRequest("group.v2.join","incorrect-but-long-enough-hmac-key");
  assert.equal((await handleGroupWebhook(attacker,env(data.db))).status,401);
  assert.equal(data.groups.size,0);
  const valid=await eventRequest("group.v2.join");
  assert.equal(await authenticateWebhook(valid,key,await valid.clone().text()),true);
  assert.equal((await handleGroupWebhook(valid,env(data.db))).status,200);
  assert.equal(data.groups.get(session+"/"+id)?.name,"TRIGENYS GROUP");
  assert.equal(await resolveProjectGroup(data.db,"xeption"),null);
});
test("admin must explicitly approve group for project before routing",async()=>{
  const data=fakeDb(),config=env(data.db);
  await handleGroupWebhook(await eventRequest("group.v2.join"),config);
  const body=JSON.stringify({project:"xeption",session,groupId:id});
  const unauth=new Request(adminUrl,{method:"POST",body});
  assert.equal((await handleGroupAdmin(unauth,config)).status,401);
  const invalid=new Request(adminUrl,{method:"POST",body:JSON.stringify({
    project:"unknown-service",session,groupId:id
  }),headers:{"x-notify-admin-key":adminKey}});
  assert.equal((await handleGroupAdmin(invalid,config)).status,400);
  const approved=new Request(adminUrl,{method:"POST",body,headers:{"x-notify-admin-key":adminKey}});
  assert.equal((await handleGroupAdmin(approved,config)).status,200);
  assert.deepEqual(await resolveProjectGroup(data.db,"xeption"),{session,groupId:id});
  assert.equal(await resolveProjectGroup(data.db,"atelier-maitre"),null);
  assert.equal((await handleGroupWebhook(await eventRequest("group.v2.leave"),config)).status,200);
  assert.equal(await resolveProjectGroup(data.db,"xeption"),null);
});
test("D1 project route overrides legacy Xeption group ID and never cross-routes",async()=>{
  const data=fakeDb(),config=env(data.db);
  await handleGroupWebhook(await eventRequest("group.v2.join"),config);
  let requests=0;
  const http=(async(_url:RequestInfo|URL,opts?:RequestInit)=>{
    requests++;
    const body=JSON.parse(String(opts?.body));
    assert.equal(body.chatId,id);
    assert.notEqual(body.chatId,"000000000000@g.us");
    return new Response("{}",{status:201});
  }) as typeof fetch;
  const settings={
    WAHA_DISPATCH_ENABLED:"true",XEPTION_NOTIFY_INGEST_KEY:"I".repeat(48),
    WAHA_BASE_URL:"https://notify.trigenys.com",WAHA_API_KEY:"K".repeat(64),
    WAHA_SESSION:session,WAHA_STAFF_GROUP_ID:"000000000000@g.us",NOTIFY_DB:data.db
  };
  const payload={
    version:1,project:"xeption",id:"event111",
    type:"inventory.stock_low",occurredAt:"2026-10-20T10:00:00Z",
    priority:"high",resource:{kind:"inventory",id:"part001"},audience:"staff",
    actionUrl:"https://www.xeptionetwork.shop/admin/inventory"
  };
  const send=()=>dispatchXeptionWhatsApp(new Request("https://worker.example.com/v1/dispatch/xeption/whatsapp",{
    method:"POST",body:JSON.stringify(payload),headers:{
      "content-type":"application/json","x-notify-auth":settings.XEPTION_NOTIFY_INGEST_KEY
    }
  }),settings,http);
  assert.equal((await send()).status,503); // discovered, not yet approved
  assert.equal(requests,0);
  await handleGroupAdmin(new Request(adminUrl,{
    method:"POST",body:JSON.stringify({project:"xeption",session,groupId:id}),
    headers:{"x-notify-admin-key":adminKey}
  }),config);
  assert.equal((await send()).status,202);
  assert.equal(requests,1);
  await handleGroupWebhook(await eventRequest("group.v2.leave"),config);
  assert.equal((await send()).status,503);
  assert.equal(requests,1);
});
test("webhook fails closed if D1 is absent, and denies stale timestamps",async()=>{
  assert.equal((await handleGroupWebhook(await eventRequest("group.v2.join"),{
    WAHA_WEBHOOK_HMAC_KEY:key
  })).status,503);
  const request=await eventRequest("group.v2.join");
  request.headers.set("x-webhook-timestamp",String(Date.now()-900000));
  const data=fakeDb();
  assert.equal((await handleGroupWebhook(request,env(data.db))).status,401);
});
