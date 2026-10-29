import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {ATELIER_META_TEMPLATES,dispatchAtelierMeta,MetaCloudApiAdapter,type AtelierMetaEnv} from "../../src/core/meta-cloud.js";

const path="https://trigenys-notify.example/v1/dispatch/atelier/whatsapp";
const secret="A".repeat(48);
const env:AtelierMetaEnv={
  ATELIER_META_DISPATCH_ENABLED:"true",
  ATELIER_NOTIFY_INGEST_KEY:secret,
  ATELIER_META_APPROVED_TEMPLATES:"am_vehicle_ready_v1:fr,am_quote_approval_v1:fr,am_invoice_available_v1:fr",
  META_CLOUD_ACCESS_TOKEN:"E".repeat(52),
  META_CLOUD_PHONE_NUMBER_ID:"123456789012345",
  META_CLOUD_API_VERSION:"v25.0"
};
const ready={
  eventId:"cn_123",eventType:"VEHICLE_READY",to:"+237690000001",
  templateName:"am_vehicle_ready_v1",language:"fr",
  variables:["Ada","CE-123-AA","Garage pilote"]
};
function request(body:unknown=ready,auth:string|null=secret,overrides:Record<string,string>={}):Request{
  return new Request(path,{method:"POST",headers:{
    "content-type":"application/json",...(auth?{"x-notify-auth":auth}:{}),...overrides
  },body:JSON.stringify(body)});
}
const accepted=(async()=>new Response(JSON.stringify({messages:[{id:"wamid.TEST123"}]}),{
  status:200,headers:{"content-type":"application/json"}
})) as typeof fetch;

test("staging allowlist contains exactly 8 approved Utility templates in FR/EN, without enabling dispatch",()=>{
  const config=JSON.parse(readFileSync("backend/wrangler.production.jsonc","utf8")) as {
    keep_vars:boolean;
    vars:Record<string,string>;
  };
  assert.equal(config.keep_vars,true);
  assert.equal(config.vars.ATELIER_META_DISPATCH_ENABLED,"false");
  const allowed=(config.vars.ATELIER_META_APPROVED_TEMPLATES??"").split(",").filter(Boolean);
  assert.equal(allowed.length,16);
  assert.equal(new Set(allowed).size,16);
  const expected=Object.values(ATELIER_META_TEMPLATES)
    .flatMap(t=>[t.name+":fr",t.name+":en"]);
  assert.deepEqual([...allowed].sort(),expected.sort());
  assert.equal(allowed.some(x=>x.includes("marketing")||x.includes("hello_world")),false);
});

test("off by default and provider misconfiguration never call Meta",async()=>{
  let calls=0;
  const mock=(async()=>{calls++;return accepted("https://graph.facebook.com");}) as typeof fetch;
  assert.equal((await dispatchAtelierMeta(request(),{...env,ATELIER_META_DISPATCH_ENABLED:undefined},mock)).status,503);
  assert.equal((await dispatchAtelierMeta(request(),{...env,META_CLOUD_ACCESS_TOKEN:undefined},mock)).status,503);
  assert.equal((await dispatchAtelierMeta(request(),{...env,META_CLOUD_API_VERSION:"../../evil"},mock)).status,503);
  assert.equal((await dispatchAtelierMeta(request(),{...env,ATELIER_NOTIFY_INGEST_KEY:"short"},mock)).status,503);
  assert.equal(calls,0);
});

test("server authentication always checked before any dispatch",async()=>{
  let calls=0;
  const mock=(async()=>{calls++;return accepted("https://graph.facebook.com");}) as typeof fetch;
  for(const auth of [null,"bad",secret+"x"]){
    const response=await dispatchAtelierMeta(request(ready,auth),env,mock);
    assert.equal(response.status,401);
  }
  assert.equal(calls,0);
});

test("known UTILITY template reaches fixed graph.facebook.com endpoint with bearer only",async()=>{
  let calls=0;
  const mock=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    calls++;
    assert.equal(String(input),"https://graph.facebook.com/v25.0/123456789012345/messages");
    assert.equal(init?.method,"POST");
    assert.equal(new Headers(init?.headers).get("Authorization"),"Bearer "+"E".repeat(52));
    const payload=JSON.parse(String(init?.body)) as Record<string,any>;
    assert.equal(payload.to,"237690000001");
    assert.equal(payload.messaging_product,"whatsapp");
    assert.equal(payload.recipient_type,"individual");
    assert.equal(payload.type,"template");
    assert.equal(payload.template.name,"am_vehicle_ready_v1");
    assert.equal(payload.template.language.code,"fr");
    assert.deepEqual(payload.template.components,[{type:"body",parameters:[
      {type:"text",text:"Ada"},{type:"text",text:"CE-123-AA"},
      {type:"text",text:"Garage pilote"}
    ]}]);
    assert.equal(payload.text,undefined);
    return accepted("https://graph.facebook.com");
  }) as typeof fetch;
  const response=await dispatchAtelierMeta(request(),env,mock);
  assert.equal(response.status,202);
  assert.deepEqual(await response.json(),{
    accepted:true,status:"QUEUED",provider:"whatsapp-cloud",
    providerMessageId:"wamid.TEST123",accountRef:"123456789012345"
  });
  assert.equal(calls,1);
});

test("quote URL template sends only validated opaque suffix, never a full URL",async()=>{
  let calls=0;
  const mock=(async (_input:RequestInfo|URL,init?:RequestInit)=>{
    calls++;
    const payload=JSON.parse(String(init?.body)) as Record<string,any>;
    assert.deepEqual(payload.template.components[1],{
      type:"button",sub_type:"url",index:"0",
      parameters:[{type:"text",text:"a".repeat(43)}]
    });
    return accepted("https://graph.facebook.com");
  }) as typeof fetch;
  const quote={
    eventId:"cn_quote_123",eventType:"QUOTE_APPROVAL_REQUESTED",to:"+237690000001",
    templateName:"am_quote_approval_v1",language:"fr",
    variables:["Ada","Garage","D-24","25 000 FCFA"],
    buttons:[{index:0,urlSuffix:"a".repeat(43)}]
  };
  assert.equal((await dispatchAtelierMeta(request(quote),env,mock)).status,202);
  assert.equal(calls,1);
});

test("invoice contact button uses only the opaque URL suffix, rejects unguarded and arbitrary URLs",async()=>{
  let calls=0;
  const mock=(async(_input:RequestInfo|URL,init?:RequestInit)=>{
    calls++;
    const payload=JSON.parse(String(init?.body)) as Record<string,any>;
    assert.equal(payload.template.name,"am_invoice_available_v1");
    assert.deepEqual(payload.template.components[1],{
      type:"button",sub_type:"url",index:"0",
      parameters:[{type:"text",text:"A".repeat(43)}]
    });
    return accepted("https://graph.facebook.com");
  }) as typeof fetch;
  const body={
    eventId:"cn_invoice_123",eventType:"INVOICE_AVAILABLE",to:"+237690000001",
    templateName:"am_invoice_available_v1",language:"fr",
    variables:["Ada","FAC-123","85 000 FCFA","Garage Akwa"],
    buttons:[{index:0,urlSuffix:"A".repeat(43)}]
  };
  assert.equal((await dispatchAtelierMeta(request(body),env,mock)).status,202);
  for(const buttons of [undefined,[],[{index:0,urlSuffix:"https://evil.example"}],[{index:1,urlSuffix:"A".repeat(43)}]]){
    const result=await dispatchAtelierMeta(request({...body,buttons}),env,mock);
    assert.equal(result.status,400);
  }
  assert.equal(calls,1);
});

test("invalid events, unapproved templates, recipient injection and free text cannot send",async()=>{
  let calls=0;
  const mock=(async()=>{calls++;return accepted("https://graph.facebook.com");}) as typeof fetch;
  const invalid=[
    {...ready,eventType:"PROMOTION"},
    {...ready,templateName:"am_marketing_v1"},
    {...ready,language:"es"},
    {...ready,to:"+237690000001@c.us"},
    {...ready,to:"https://attacker.example"},
    {...ready,variables:["Ada","CE-123-AA"]},
    {...ready,variables:["Ada\nInjected","CE-123-AA","Garage"]},
    {...ready,variables:["Ada","CE-123-AA","Garage"],text:"Hi"},
    {...ready,buttons:[{index:0,urlSuffix:"some-private-token"}]},
    {...ready,eventId:"../escape"},
    {...ready,eventType:"QUOTE_APPROVAL_REQUESTED",templateName:"am_quote_approval_v1",
      variables:["a","b","c","d"],buttons:[{index:0,urlSuffix:"https://attacker.example"}]}
  ];
  for(const bad of invalid){
    const response=await dispatchAtelierMeta(request(bad),env,mock);
    assert.equal(response.status,400,JSON.stringify(bad));
  }
  const unapproved=await dispatchAtelierMeta(request(ready),{
    ...env,ATELIER_META_APPROVED_TEMPLATES:"am_appointment_reminder_v1:fr"
  },mock);
  assert.equal(unapproved.status,503);
  assert.equal((await unapproved.json() as {error:string}).error,"TEMPLATE_NOT_APPROVED");
  assert.equal(calls,0);
});

test("hard body cap, method and media checks are enforced",async()=>{
  assert.equal((await dispatchAtelierMeta(new Request(path,{method:"GET"}),env,accepted)).status,405);
  const text=new Request(path,{method:"POST",headers:{"content-type":"text/plain","x-notify-auth":secret},body:"x"});
  assert.equal((await dispatchAtelierMeta(text,env,accepted)).status,415);
  const large=request({...ready,extra:"Q".repeat(5000)});
  assert.equal((await dispatchAtelierMeta(large,env,accepted)).status,413);
});

test("Meta errors are redacted and distinguish retryable from ambiguous outcomes",async()=>{
  for(const [status,body,expectedStatus,expectedCode,retryable] of [
    [429,{error:{code:130429,message:"PRIVATE phone token"}},503,"RATE_LIMITED",true],
    [500,{error:{message:"PRIVATE phone token"}},503,"PROVIDER_UNAVAILABLE",true],
    [401,{error:{code:190,message:"PRIVATE phone token"}},502,"PROVIDER_REJECTED",false],
    [400,{error:{code:131042,message:"PRIVATE phone token"}},502,"PROVIDER_REJECTED",false],
    [200,{messages:[]},502,"UNKNOWN_OUTCOME",false]
  ] as const){
    const mock=(async()=>new Response(JSON.stringify(body),{status})) as typeof fetch;
    const response=await dispatchAtelierMeta(request(),env,mock);
    assert.equal(response.status,expectedStatus);
    const data=await response.text();
    assert.equal(JSON.parse(data).error,expectedCode);
    assert.equal(JSON.parse(data).retryable,retryable);
    assert.doesNotMatch(data,/PRIVATE|token|phone/i);
  }
  const failed=(async()=>{throw new TypeError("private host name / secret");}) as typeof fetch;
  const response=await dispatchAtelierMeta(request(),env,failed);
  assert.equal(response.status,502);
  assert.deepEqual(await response.json(),{error:"UNKNOWN_OUTCOME",retryable:false});
});

test("adapter constructor and module import cannot initiate sending",()=>{
  let calls=0;
  const mock=(async()=>{calls++;return accepted("https://graph.facebook.com");}) as typeof fetch;
  new MetaCloudApiAdapter(env,mock);
  assert.equal(calls,0);
});
