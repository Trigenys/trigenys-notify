/** Bounded business snapshots; never a raw notification body or customer record. */
export interface StaffEventFacts {
  subject?:string;
  stockRemaining?:number;
  actor?:string;
  condition?:string;
  target?:string;
  cashOfferXaf?:number;
  voucherOfferXaf?:number;
  specification?:string;
  grade?:string;
  priceMinXaf?:number;
  priceMaxXaf?:number;
  city?:string;
  deliveryMode?:string;
  paymentChannel?:string;
  paymentStatus?:string;
  voucherReference?:string;
  deviceModel?:string;
  expiresAtText?:string;
  orderTotalXaf?:number;
  amountPaidXaf?:number;
  closingCashXaf?:number;
  totalInflowXaf?:number;
  totalOutflowXaf?:number;
  debtCount?:number;
  debtOutstandingXaf?:number;
  /** order.created only: the staff must call and deliver the customer. */
  customerName?:string;
  customerPhone?:string;
  customerEmail?:string;
  paymentMethod?:string;
  deliveryAddress?:string;
  items?:OrderItemFact[];
  /** report.weekly_digest only: period label and pre-written sections. */
  digestPeriod?:string;
  digestSections?:DigestSectionFact[];
}
export interface OrderItemFact {name:string;quantity:number;unitPriceXaf?:number;}
export interface DigestSectionFact {title:string;lines:string[];}

const XAF_MAX=1_000_000_000_000;
const textLimits={subject:160,actor:80,condition:180,target:160,city:80,
  deliveryMode:80,paymentChannel:80,paymentStatus:80,voucherReference:40,
  deviceModel:80,expiresAtText:40} as const;
const numericLimits={stockRemaining:1_000_000_000,cashOfferXaf:XAF_MAX,
  voucherOfferXaf:XAF_MAX,priceMinXaf:XAF_MAX,priceMaxXaf:XAF_MAX,
  orderTotalXaf:XAF_MAX,amountPaidXaf:XAF_MAX,closingCashXaf:XAF_MAX,
  totalInflowXaf:XAF_MAX,totalOutflowXaf:XAF_MAX,debtCount:1_000_000,
  debtOutstandingXaf:XAF_MAX} as const;
const contact=/@|https?:\/\/|www\.|\+\s*\d(?:[\s().-]*\d){7,}|\b\d{9,15}\b|\b(?:237[\s.-]*)?[26]\d{2}(?:[\s.-]*\d{3}){2}\b/i;
const unsafeText=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069*_~`]/;

/**
 * Customer contact fields are accepted for order.created only (documented exception:
 * staff calls the buyer to confirm and deliver). Any other event type drops them.
 */
const ORDER_CONTACT_TYPES=new Set(['order.created']);
const MAX_ITEMS=10;
export const WEEKLY_DIGEST_TYPE='report.weekly_digest';
/** Bounds of a weekly digest; the whole event also stays under the 4096-byte input cap. */
export const DIGEST_LIMITS={sections:12,linesPerSection:15,title:80,line:120,period:40} as const;
/**
 * Digest lines carry grouped amounts ("650 000 000 F"), which the generic phone pattern would
 * reject. The source rows hold no contact data; only explicit contact shapes are refused here.
 */
const digestContact=/@|https?:\/\/|www\.|\+\s*\d(?:[\s().-]*\d){7,}|\b\d{9,15}\b/i;
const digestPeriodPattern=/^du \d{2}\/\d{2} au \d{2}\/\d{2}$/;
const phonePattern=/^\+?\d[\d ]{6,18}\d$/;
const emailPattern=/^[^\s@<>()"',;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function safeText(raw:unknown,max:number,allowContact=false):string{
  if(typeof raw!=='string'||!raw.trim()||raw.length>max||unsafeText.test(raw)||
    (!allowContact&&contact.test(raw)))throw Error('INVALID_FACTS');
  return raw.normalize('NFC').trim().replace(/ {2,}/g,' ');
}

function orderFacts(source:Record<string,unknown>,facts:Record<string,unknown>):void{
  if(source.customerName!==undefined)facts.customerName=safeText(source.customerName,80);
  if(source.paymentMethod!==undefined)facts.paymentMethod=safeText(source.paymentMethod,80);
  if(source.deliveryAddress!==undefined)facts.deliveryAddress=safeText(source.deliveryAddress,160);
  if(source.customerPhone!==undefined){
    const phone=safeText(source.customerPhone,24,true);
    if(!phonePattern.test(phone))throw Error('INVALID_FACTS');
    facts.customerPhone=phone;
  }
  if(source.customerEmail!==undefined){
    const email=safeText(source.customerEmail,254,true);
    if(!emailPattern.test(email))throw Error('INVALID_FACTS');
    facts.customerEmail=email.toLowerCase();
  }
  if(source.items!==undefined){
    if(!Array.isArray(source.items)||!source.items.length||source.items.length>MAX_ITEMS)
      throw Error('INVALID_FACTS');
    facts.items=source.items.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item))throw Error('INVALID_FACTS');
      const i=item as Record<string,unknown>;
      if(typeof i.quantity!=='number'||!Number.isSafeInteger(i.quantity)||i.quantity<1||i.quantity>999)
        throw Error('INVALID_FACTS');
      const out:OrderItemFact={name:safeText(i.name,120),quantity:i.quantity};
      if(i.unitPriceXaf!==undefined){
        if(typeof i.unitPriceXaf!=='number'||!Number.isSafeInteger(i.unitPriceXaf)||
          i.unitPriceXaf<0||i.unitPriceXaf>XAF_MAX)throw Error('INVALID_FACTS');
        out.unitPriceXaf=i.unitPriceXaf;
      }
      return out;
    });
  }
}

function digestText(raw:unknown,max:number):string{
  if(typeof raw!=='string'||!raw.trim()||raw.length>max||unsafeText.test(raw)||digestContact.test(raw))
    throw Error('INVALID_FACTS');
  return raw.normalize('NFC').trim().replace(/ {2,}/g,' ');
}

function digestFacts(source:Record<string,unknown>,facts:Record<string,unknown>):void{
  if(source.digestPeriod!==undefined){
    if(typeof source.digestPeriod!=='string'||source.digestPeriod.length>DIGEST_LIMITS.period||
      !digestPeriodPattern.test(source.digestPeriod))throw Error('INVALID_FACTS');
    facts.digestPeriod=source.digestPeriod;
  }
  if(source.digestSections===undefined)return;
  const sections=source.digestSections;
  if(!Array.isArray(sections)||!sections.length||sections.length>DIGEST_LIMITS.sections)
    throw Error('INVALID_FACTS');
  facts.digestSections=sections.map(section=>{
    if(!section||typeof section!=='object'||Array.isArray(section))throw Error('INVALID_FACTS');
    const s=section as Record<string,unknown>;
    if(!Array.isArray(s.lines)||!s.lines.length||s.lines.length>DIGEST_LIMITS.linesPerSection)
      throw Error('INVALID_FACTS');
    return {title:digestText(s.title,DIGEST_LIMITS.title),
      lines:s.lines.map(line=>digestText(line,DIGEST_LIMITS.line))};
  });
}

export function parseStaffFacts(value:unknown,type?:string):StaffEventFacts|undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_FACTS');
  const source=value as Record<string,unknown>,facts:Record<string,unknown>={};
  for(const [key,max] of Object.entries(textLimits)){
    const raw=source[key];if(raw===undefined)continue;
    facts[key]=safeText(raw,max);
  }
  for(const [key,max] of Object.entries(numericLimits)){
    const raw=source[key];if(raw===undefined)continue;
    if(typeof raw!=='number'||!Number.isSafeInteger(raw)||raw<0||raw>max)throw Error('INVALID_FACTS');
    facts[key]=raw;
  }
  if(source.specification!==undefined){
    if(typeof source.specification!=='string'||!/^\d{1,4} Go(?: \/ \d{1,4} Go)?$/.test(source.specification))
      throw Error('INVALID_FACTS');
    facts.specification=source.specification;
  }
  if(source.grade!==undefined){
    if(typeof source.grade!=='string'||!(/^[A-F][+-]?$/i).test(source.grade))throw Error('INVALID_FACTS');
    facts.grade=source.grade.toUpperCase();
  }
  if(typeof facts.priceMinXaf==='number'&&typeof facts.priceMaxXaf==='number'&&
     facts.priceMinXaf>facts.priceMaxXaf)throw Error('INVALID_FACTS');
  if(type&&ORDER_CONTACT_TYPES.has(type))orderFacts(source,facts);
  if(type===WEEKLY_DIGEST_TYPE)digestFacts(source,facts);
  return Object.keys(facts).length?facts as StaffEventFacts:undefined;
}

const amount=(n:number)=>new Intl.NumberFormat('fr-FR',{maximumFractionDigits:0})
  .format(n).replace(/[\u00a0\u202f]/g,' ');

export function businessFactLines(type:string,facts:StaffEventFacts|undefined):string[]{
  if(!facts)return [];
  const lines:string[]=[];
  const inventory=type.startsWith('inventory.')||type==='catalog.product_missing_image';
  if(type===WEEKLY_DIGEST_TYPE){
    // WhatsApp bold section titles, one blank line between sections; never an actor line.
    return (facts.digestSections??[]).flatMap((section,i)=>
      [...(i?['']:[]),`*${section.title}*`,...section.lines]);
  }
  if(type==='order.created'){
    if(facts.customerName)lines.push('Client : '+facts.customerName);
    if(facts.customerPhone)lines.push('Tél : '+facts.customerPhone);
    if(facts.customerEmail)lines.push('E-mail : '+facts.customerEmail);
    if(facts.items?.length){
      lines.push('Articles :');
      for(const item of facts.items)lines.push(`• ${item.quantity} × ${item.name}`+
        (item.unitPriceXaf!==undefined?` — ${amount(item.unitPriceXaf)} FCFA`:''));
    }
    if(facts.orderTotalXaf!==undefined)lines.push(`Montant : ${amount(facts.orderTotalXaf)} FCFA`);
    if(facts.paymentMethod)lines.push('Paiement : '+facts.paymentMethod);
    if(facts.city)lines.push('Ville : '+facts.city);
    if(facts.deliveryMode)lines.push('Livraison : '+facts.deliveryMode);
    if(facts.deliveryAddress)lines.push('Adresse : '+facts.deliveryAddress);
  }else if(type==='order.paid'){
    if(facts.amountPaidXaf!==undefined)lines.push(`Montant payé : ${amount(facts.amountPaidXaf)} FCFA`);
    if(facts.paymentChannel)lines.push('Moyen : '+facts.paymentChannel);
    if(facts.paymentStatus)lines.push('Statut : '+facts.paymentStatus);
  }else if(type==='barter.voucher_expiring'){
    if(facts.voucherReference)lines.push('Bon : '+facts.voucherReference);
    if(facts.deviceModel)lines.push('Appareil : '+facts.deviceModel);
    if(facts.expiresAtText)lines.push('Expire le : '+facts.expiresAtText);
  }else if(type==='cash_report.closed'){
    if(facts.subject)lines.push('Boutique : '+facts.subject);
    if(facts.totalInflowXaf!==undefined)lines.push(`Entrées : ${amount(facts.totalInflowXaf)} FCFA`);
    if(facts.totalOutflowXaf!==undefined)lines.push(`Dépenses : ${amount(facts.totalOutflowXaf)} FCFA`);
    if(facts.closingCashXaf!==undefined)lines.push(`Solde soir : ${amount(facts.closingCashXaf)} FCFA`);
  }else if(type==='finance.debt_overdue'){
    if(facts.subject)lines.push('Boutique : '+facts.subject);
    if(facts.debtCount!==undefined)lines.push(`Dettes de plus de 7 j : ${amount(facts.debtCount)}`);
    if(facts.debtOutstandingXaf!==undefined)lines.push(`Reste à encaisser : ${amount(facts.debtOutstandingXaf)} FCFA`);
  }
  if(lines.length){if(facts.actor)lines.push('Par : '+facts.actor);return lines;}
  if(!inventory&&type!=='barter.requested'&&type!=='marketplace.listing_created')return [];
  if(facts.subject)lines.push(`${inventory?'Produit':'Appareil'} : ${facts.subject}`);
  if(type==='inventory.stock_low'||type==='inventory.stock_out'){
    if(facts.stockRemaining!==undefined)
      lines.push(`Stock restant : ${amount(facts.stockRemaining)} unité${facts.stockRemaining>1?'s':''}`);
  }else if(type==='catalog.product_missing_image'){
    lines.push('À compléter : photo du produit.');
  }else if(type==='barter.requested'){
    if(facts.condition)lines.push('État : '+facts.condition);
    if(facts.cashOfferXaf!==undefined)lines.push(`Offre cash : ${amount(facts.cashOfferXaf)} FCFA`);
    if(facts.voucherOfferXaf!==undefined)lines.push(`Bon d'achat : ${amount(facts.voucherOfferXaf)} FCFA`);
    if(facts.target)lines.push('Cible : '+facts.target);
  }else if(type==='marketplace.listing_created'){
    if(facts.specification)lines.push('Configuration : '+facts.specification);
    if(facts.grade)lines.push('Grade : '+facts.grade);
    if(facts.priceMinXaf!==undefined&&facts.priceMaxXaf!==undefined)
      lines.push(`Prix : ${amount(facts.priceMinXaf)} à ${amount(facts.priceMaxXaf)} FCFA`);
    if(facts.city)lines.push('Ville : '+facts.city);
  }
  if(facts.actor)lines.push('Par : '+facts.actor);
  return lines;
}
