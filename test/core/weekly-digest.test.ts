import assert from 'node:assert/strict';
import test from 'node:test';
import {parseNotifyEvent,staffMessage,InvalidNotifyEvent} from '../../src/core/contracts.js';
import {dispatchXeptionWhatsApp} from '../../src/core/dispatch.js';
import {parseEventGroups,restrictToEventGroups} from '../../src/core/event-groups.js';
import {DIGEST_LIMITS} from '../../src/core/message-facts.js';

const EMOJI=/\p{Extended_Pictographic}/u;
const KEY='I'.repeat(48);
const TEST_GROUP='12345678@g.us',ADMIN_GROUP='87654321@g.us';

/** Fictitious stores and amounts. */
const sections=[
  {title:'Boutique A',lines:['Entrées : 1 250 000 F','Sorties : 400 000 F','Boss : 650 000 000 F']},
  {title:'Total semaine',lines:['Entrées 1 250 000 F | Sorties 400 000 F | Boss 0 F']},
  {title:'À noter',lines:['- Rien à signaler.']}
];
const event={version:1,project:'xeption',id:'weekly-2026-W46',type:'report.weekly_digest',
  occurredAt:'2026-11-16T07:00:00.000Z',priority:'normal',audience:'staff',
  resource:{kind:'report',id:'weekly-2026-W46'},
  facts:{digestPeriod:'du 09/11 au 15/11',digestSections:sections}};
const withFacts=(facts:Record<string,unknown>)=>({...event,facts:{...event.facts,...facts}});

test('weekly digest renders the validated format: dated bold title, bold sections, no emoji',()=>{
  const message=staffMessage(parseNotifyEvent(event));
  assert.equal(message.title,'*Bilan de la semaine du 09/11 au 15/11*');
  assert.equal(message.body,[
    '*Boutique A*','Entrées : 1 250 000 F','Sorties : 400 000 F','Boss : 650 000 000 F','',
    '*Total semaine*','Entrées 1 250 000 F | Sorties 400 000 F | Boss 0 F','',
    '*À noter*','- Rien à signaler.'
  ].join('\n'));
  assert.doesNotMatch(message.title+message.body,EMOJI);
  assert.equal(message.actionUrl,undefined);
});

test('weekly digest rejects contact data, markup injection and oversized input',()=>{
  const bad=(lines:string[])=>withFacts({digestSections:[{title:'A',lines}]});
  for(const line of ['Appelez le +237 6 99 00 00 00','client@example.test','www.example.test',
    'Total 699000000','Entrées *gras*','ligne\nsuivante'])
    assert.throws(()=>parseNotifyEvent(bad([line])),InvalidNotifyEvent,line);
  assert.throws(()=>parseNotifyEvent(bad(['x'.repeat(DIGEST_LIMITS.line+1)])),InvalidNotifyEvent);
  assert.throws(()=>parseNotifyEvent(bad(Array(DIGEST_LIMITS.linesPerSection+1).fill('x'))),InvalidNotifyEvent);
  assert.throws(()=>parseNotifyEvent(withFacts({digestSections:[]})),InvalidNotifyEvent);
  assert.throws(()=>parseNotifyEvent(withFacts({digestPeriod:'semaine 46'})),InvalidNotifyEvent);
});

test('digest facts are ignored on other event types',()=>{
  const other=parseNotifyEvent({...event,type:'cash_report.closed',facts:{subject:'Boutique A',digestSections:sections}});
  assert.equal(other.facts?.digestSections,undefined);
});

test('event groups narrow a type to routed groups and never add one',()=>{
  const routed=[{session:'s',groupId:TEST_GROUP},{session:'s',groupId:ADMIN_GROUP}];
  const config=JSON.stringify({'report.weekly_digest':[TEST_GROUP,'99999999@g.us']});
  assert.deepEqual(restrictToEventGroups(routed,'report.weekly_digest',config),[routed[0]]);
  assert.deepEqual(restrictToEventGroups(routed,'order.paid',config),routed);
  assert.deepEqual(restrictToEventGroups(routed,'report.weekly_digest',undefined),routed);
  for(const raw of ['[]','{"report.weekly_digest":[]}','{"report.weekly_digest":["not-a-group"]}','{"Bad":["1@g.us"]}','{'])
    assert.throws(()=>parseEventGroups(raw),raw);
});

const dispatch=(body:unknown,extra:Record<string,string>,sent:string[]=[])=>
  dispatchXeptionWhatsApp(new Request('https://notify.test/v1/dispatch/xeption/whatsapp',{
    method:'POST',headers:{'content-type':'application/json','x-notify-auth':KEY},body:JSON.stringify(body)}),{
    XEPTION_NOTIFY_INGEST_KEY:KEY,WAHA_DISPATCH_ENABLED:'true',WAHA_BASE_URL:'https://waha.test',
    WAHA_API_KEY:'K'.repeat(48),WAHA_SESSION:'test',WAHA_STAFF_GROUP_ID:TEST_GROUP,...extra
  },async(_url,init)=>{sent.push(JSON.parse(String(init?.body)).text);return new Response('{}',{status:201});});

test('dispatch sends the weekly digest to the configured test group',async()=>{
  const sent:string[]=[];
  const config=JSON.stringify({'report.weekly_digest':[TEST_GROUP]});
  assert.equal((await dispatch(event,{WAHA_EVENT_GROUPS_JSON:config},sent)).status,202);
  assert.equal(sent.length,1);
  assert.ok(sent[0].startsWith('*Bilan de la semaine du 09/11 au 15/11*\n\n*Boutique A*\n'));
  assert.doesNotMatch(sent[0],EMOJI);
});

test('dispatch fails closed when the digest group is not routed or the setting is malformed',async()=>{
  const elsewhere=JSON.stringify({'report.weekly_digest':[ADMIN_GROUP]});
  const sent:string[]=[];
  assert.equal((await dispatch(event,{WAHA_EVENT_GROUPS_JSON:elsewhere},sent)).status,503);
  assert.equal((await dispatch(event,{WAHA_EVENT_GROUPS_JSON:'{'},sent)).status,503);
  assert.equal(sent.length,0);
});
