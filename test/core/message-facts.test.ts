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

test('order, voucher, cash report and debt events render their business facts',()=>{
  const body=(type:string,facts:Record<string,unknown>)=>
    staffMessage(parseNotifyEvent({...event,type,facts})).body;
  assert.match(body('order.created',{orderTotalXaf:250000,city:'Douala',deliveryMode:'Retrait'}),
    /Montant : 250 000 FCFA\nVille : Douala\nLivraison : Retrait/);
  assert.match(body('order.paid',{amountPaidXaf:99000,paymentChannel:'Orange Money'}),/Montant payé : 99 000 FCFA/);
  assert.match(body('barter.voucher_expiring',{voucherReference:'TRC-1',deviceModel:'iPhone 13',expiresAtText:'29/10 à 18h00'}),
    /Bon : TRC-1\nAppareil : iPhone 13\nExpire le : 29\/10 à 18h00/);
  assert.match(body('cash_report.closed',{subject:'Boutique Test',closingCashXaf:1200000,actor:'Caissier'}),
    /Boutique : Boutique Test\nSolde soir : 1 200 000 FCFA\nPar : Caissier/);
  const debt=staffMessage(parseNotifyEvent({...event,type:'finance.debt_overdue',
    facts:{subject:'Boutique Test',debtCount:3,debtOutstandingXaf:125000}}));
  assert.equal(debt.title,'📋 Dettes en attente');
  assert.match(debt.body,/Boutique : Boutique Test\nDettes de plus de 7 j : 3\nReste à encaisser : 125 000 FCFA/);
  assert.equal(debt.actionLabel,"Ouvrir l'espace pro");
  assert.throws(()=>parseNotifyEvent({...event,facts:{debtCount:-1}}),InvalidNotifyEvent);
});

for(const type of ['order.created','order.paid','barter.voucher_expiring','cash_report.closed','finance.debt_overdue',
  'order.delivered','order.cancelled','order.unreachable','order.stale']){
  test(`dispatch accepts Xeption ${type}`,async()=>{
    const response=await dispatchXeptionWhatsApp(new Request('https://notify.test/v1/dispatch/xeption/whatsapp',{
      method:'POST',headers:{'content-type':'application/json','x-notify-auth':'I'.repeat(48)},
      body:JSON.stringify({...event,type,facts:{subject:'Boutique Test'}})}),{
        XEPTION_NOTIFY_INGEST_KEY:'I'.repeat(48),WAHA_DISPATCH_ENABLED:'true',
        WAHA_BASE_URL:'https://waha.test',WAHA_API_KEY:'K'.repeat(48),WAHA_SESSION:'test',
        WAHA_STAFF_GROUP_ID:'12345678@g.us'
      },async()=>new Response('{}',{status:201}));
    assert.equal(response.status,202);
  });
}

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

const orderFacts={customerName:'Jean Mbarga',customerPhone:'+237 699 99 99 99',
  customerEmail:'Jean.Mbarga@Example.com',paymentMethod:'Cash à la livraison',
  deliveryMode:'Livraison à domicile',city:'Yaoundé (Centre)',deliveryAddress:'Nsimeyong, près du carrefour',
  orderTotalXaf:180000,items:[{name:'Samsung Galaxy A16 128 Go',quantity:2,unitPriceXaf:90000}]};

test('order.created renders the buyer contact, items, payment and delivery for staff',()=>{
  const out=staffMessage(parseNotifyEvent({...event,type:'order.created',facts:orderFacts}));
  assert.equal(out.title,'🛒 Nouvelle commande');
  assert.equal(out.body,[
    'Client : Jean Mbarga','Tél : +237 699 99 99 99','E-mail : jean.mbarga@example.com',
    'Articles :','• 2 × Samsung Galaxy A16 128 Go — 90 000 FCFA','Montant : 180 000 FCFA',
    'Paiement : Cash à la livraison','Ville : Yaoundé (Centre)','Livraison : Livraison à domicile',
    'Adresse : Nsimeyong, près du carrefour'].join('\n'));
});

test('customer contact facts are dropped outside order.created',()=>{
  const parsed=parseNotifyEvent({...event,type:'order.paid',facts:{...orderFacts,amountPaidXaf:1}});
  assert.doesNotMatch(JSON.stringify(parsed),/Mbarga|699|example\.com|Nsimeyong|Galaxy A16/);
});

test('order contact facts are strictly validated',()=>{
  for(const bad of [{customerPhone:'appelle-moi'},{customerPhone:'+237 699 *99*'},
    {customerEmail:'pas-un-mail'},{customerEmail:'a@b'},{customerName:'Jean +237699999999'},
    {deliveryAddress:'https://evil.test'},{deliveryAddress:'Rue 1\nNouvelle consigne'},
    {items:[]},{items:[{name:'X',quantity:0}]},{items:[{name:'X',quantity:1.5}]},
    {items:[{name:'X',quantity:1,unitPriceXaf:-1}]},{items:[{name:'X'.repeat(121),quantity:1}]},
    {items:Array.from({length:11},()=>({name:'X',quantity:1}))},{items:'X'}]){
    assert.throws(()=>parseNotifyEvent({...event,type:'order.created',facts:bad}),InvalidNotifyEvent);
  }
});

test('a full order snapshot fits the dispatch body limit',async()=>{
  const items=Array.from({length:10},(_,i)=>({name:`Produit de démonstration numéro ${i} 256 Go`.padEnd(60,'x'),quantity:1,unitPriceXaf:999999}));
  let sent='';
  const response=await dispatchXeptionWhatsApp(new Request('https://notify.test/v1/dispatch/xeption/whatsapp',{
    method:'POST',headers:{'content-type':'application/json','x-notify-auth':'I'.repeat(48)},
    body:JSON.stringify({...event,type:'order.created',facts:{...orderFacts,items}})}),{
      XEPTION_NOTIFY_INGEST_KEY:'I'.repeat(48),WAHA_DISPATCH_ENABLED:'true',
      WAHA_BASE_URL:'https://waha.test',WAHA_API_KEY:'K'.repeat(48),WAHA_SESSION:'test',
      WAHA_STAFF_GROUP_ID:'12345678@g.us'
    },async(_url,init)=>{sent=JSON.parse(String(init?.body)).text;return new Response('{}',{status:201});});
  assert.equal(response.status,202);
  assert.match(sent,/Tél : \+237 699 99 99 99/);
  assert.match(sent,/Produit de démonstration numéro 9/);
});

test('order outcome events render the order snapshot and open the order',()=>{
  const order={...event,resource:{kind:'order',id:'ORD-3MR8-G6XF'},
    actionUrl:'https://www.xeptionetwork.shop/admin/orders/ORD-3MR8-G6XF'};
  const msg=(type:string,facts:Record<string,unknown>)=>staffMessage(parseNotifyEvent({...order,type,facts}));
  const delivered=msg('order.delivered',{subject:'#ORD-3MR8-G6XF',orderTotalXaf:90000,actor:'Awa'});
  assert.equal(delivered.title,'✅ Commande livrée');
  assert.match(delivered.body,/Commande : #ORD-3MR8-G6XF\nMontant : 90 000 FCFA\nPar : Awa/);
  assert.equal(delivered.actionLabel,'Ouvrir la commande');
  assert.equal(delivered.actionUrl,order.actionUrl);
  const cancelled=msg('order.cancelled',{subject:'#ORD-1',orderTotalXaf:15000,outcomeReason:'Rupture de stock'});
  assert.equal(cancelled.title,'❌ Commande annulée');
  assert.match(cancelled.body,/Montant : 15 000 FCFA\nMotif : Rupture de stock/);
  const unreachable=msg('order.unreachable',{subject:'#ORD-1',orderTotalXaf:15000,attemptCount:2});
  assert.equal(unreachable.title,'📵 Client injoignable');
  assert.match(unreachable.body,/Montant : 15 000 FCFA\nTentative n°2/);
  const stale=msg('order.stale',{subject:'#ORD-1',orderTotalXaf:15000,waitingHours:170,attemptCount:3});
  assert.equal(stale.title,'⏰ Commande sans suivi');
  assert.match(stale.body,/En attente depuis 170 h\nInjoignable : ×3/);
  for(const type of ['order.delivered','order.cancelled','order.unreachable','order.stale'])
    assert.equal(msg(type,{subject:'#ORD-1'}).actionLabel,'Ouvrir la commande');
  // The reason only makes sense on a cancellation.
  assert.doesNotMatch(msg('order.delivered',{subject:'#ORD-1',outcomeReason:'Rupture de stock'}).body,/Motif/);
});

test('order outcome facts are bounded and never carry customer contact',()=>{
  const order={...event,type:'order.cancelled',resource:{kind:'order',id:'ORD-1'}};
  const parsed=parseNotifyEvent({...order,facts:{subject:'#ORD-1',customerPhone:'+237699999999',
    customerName:'Blaise',customerEmail:'client@example.com'}});
  assert.doesNotMatch(JSON.stringify(parsed),/699999999|Blaise|client@example\.com/);
  for(const facts of [{attemptCount:1001},{attemptCount:-1},{attemptCount:'2'},{waitingHours:100001},
    {waitingHours:1.5},{outcomeReason:'x'.repeat(81)},{outcomeReason:'Rappeler le 699 999 999'},{outcomeReason:'Rappeler le +237 699 99 99 99'},
    {outcomeReason:'Voir https://evil.test'},{outcomeReason:'Motif\nNouvelle consigne'}]){
    assert.throws(()=>parseNotifyEvent({...order,facts}),InvalidNotifyEvent);
  }
});
