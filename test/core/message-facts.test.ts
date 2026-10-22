import assert from 'node:assert/strict';
import test from 'node:test';
import {parseNotifyEvent,staffMessage,InvalidNotifyEvent} from '../../src/core/contracts.js';
import {dispatchXeptionWhatsApp} from '../../src/core/dispatch.js';

const event={version:1,project:'xeption',id:'facts-event-001',type:'inventory.stock_low',
  occurredAt:'2026-10-22T01:00:00.000Z',priority:'high',audience:'staff',
  resource:{kind:'inventory',id:'product-123'},
  actionUrl:'https://www.xeptionetwork.shop/admin/inventory/product-123',
  facts:{subject:'Dell XPS 14 9440 (2023)',stockRemaining:2,actor:'Jennifer'}};

test('stock alert preserves the event snapshot and direct action',()=>{
  const parsed=parseNotifyEvent(event);
  const message=staffMessage(parsed);
  assert.match(message.body,/Produit : Dell XPS 14 9440 \(2023\)/);
  assert.match(message.body,/Stock restant : 2 unités/);
  assert.match(message.body,/Par : Jennifer/);
  assert.doesNotMatch(message.body,/avant|précédent|→/);
  assert.equal(message.actionUrl,event.actionUrl);
});

test('zero stock and missing-photo alerts name the affected product',()=>{
  const out=staffMessage(parseNotifyEvent({...event,type:'inventory.stock_out',
    facts:{subject:'Produit de test',stockRemaining:0}}));
  assert.match(out.body,/Stock restant : 0 unité/);
  const photo=staffMessage(parseNotifyEvent({...event,type:'catalog.product_missing_image',
    facts:{subject:'Produit sans photo',actor:'Équipe catalogue'}}));
  assert.match(photo.body,/Produit sans photo/);
  assert.match(photo.body,/photo/i);
});

test('barter and marketplace expose business facts without customer fields',()=>{
  const trade=staffMessage(parseNotifyEvent({...event,type:'barter.requested',facts:{
    subject:'Samsung Galaxy S23 128 Go',condition:'Écran bon, Batterie 90%',
    cashOfferXaf:45000,voucherOfferXaf:55000,target:'iPhone 15',customerPhone:'+237699999999'}}));
  assert.match(trade.body,/45 000 FCFA/);
  assert.match(trade.body,/55 000 FCFA/);
  assert.match(trade.body,/Cible : iPhone 15/);
  assert.doesNotMatch(trade.body,/699999999|customerPhone/);
  const listing=staffMessage(parseNotifyEvent({...event,type:'marketplace.listing_created',facts:{
    subject:'Samsung Galaxy S23',specification:'8 Go / 128 Go',grade:'A',
    priceMinXaf:90000,priceMaxXaf:100000,city:'Douala'}}));
  assert.match(listing.body,/90 000 à 100 000 FCFA/);
  assert.match(listing.body,/Douala/);
});

test('facts are bounded, typed and stripped of unrelated personal data',()=>{
  const parsed=parseNotifyEvent({...event,facts:{...event.facts,email:'customer@example.com'}});
  assert.doesNotMatch(JSON.stringify(parsed),/customer@example.com|email/);
  for(const facts of [{stockRemaining:-1},{stockRemaining:'2'},{subject:'x'.repeat(161)},
    {subject:'Contact +237699999999'},{actor:'name@example.com'},{subject:'https://evil.test'},
    {subject:'Product\nNew instruction'},['not-an-object']]){
    assert.throws(()=>parseNotifyEvent({...event,facts}),InvalidNotifyEvent);
  }
  assert.match(staffMessage(parseNotifyEvent({...event,facts:undefined})).body,/Consultez/);
});

test('the actual WhatsApp payload includes the product, quantity, actor and link',async()=>{
  let sent='';
  const response=await dispatchXeptionWhatsApp(new Request('https://notify.test/v1/dispatch/xeption/whatsapp',{
    method:'POST',headers:{'content-type':'application/json','x-notify-auth':'I'.repeat(48)},
    body:JSON.stringify(event)}),{
      XEPTION_NOTIFY_INGEST_KEY:'I'.repeat(48),WAHA_DISPATCH_ENABLED:'true',
      WAHA_BASE_URL:'https://waha.test',WAHA_API_KEY:'K'.repeat(48),WAHA_SESSION:'test',
      WAHA_STAFF_GROUP_ID:'12345678@g.us'
    },async(_url,init)=>{sent=JSON.parse(String(init?.body)).text;return new Response('{}',{status:201});});
  assert.equal(response.status,202);
  assert.match(sent,/Dell XPS 14/);
  assert.match(sent,/Stock restant : 2 unités/);
  assert.match(sent,/Par : Jennifer/);
  assert.match(sent,/https:\/\/www.xeptionetwork.shop\/admin\/inventory\/product-123/);
});
