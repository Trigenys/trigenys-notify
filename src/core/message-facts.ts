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
}

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

export function parseStaffFacts(value:unknown):StaffEventFacts|undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_FACTS');
  const source=value as Record<string,unknown>,facts:Record<string,string|number>={};
  for(const [key,max] of Object.entries(textLimits)){
    const raw=source[key];if(raw===undefined)continue;
    if(typeof raw!=='string'||!raw.trim()||raw.length>max||unsafeText.test(raw)||contact.test(raw))
      throw Error('INVALID_FACTS');
    facts[key]=raw.normalize('NFC').trim();
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
  return Object.keys(facts).length?facts:undefined;
}

const amount=(n:number)=>new Intl.NumberFormat('fr-FR',{maximumFractionDigits:0})
  .format(n).replace(/[\u00a0\u202f]/g,' ');

export function businessFactLines(type:string,facts:StaffEventFacts|undefined):string[]{
  if(!facts)return [];
  const lines:string[]=[];
  const inventory=type.startsWith('inventory.')||type==='catalog.product_missing_image';
  if(type==='order.created'){
    if(facts.orderTotalXaf!==undefined)lines.push(`Montant : ${amount(facts.orderTotalXaf)} FCFA`);
    if(facts.city)lines.push('Ville : '+facts.city);
    if(facts.deliveryMode)lines.push('Livraison : '+facts.deliveryMode);
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
