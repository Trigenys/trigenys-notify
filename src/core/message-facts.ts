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
}

const textLimits={subject:160,actor:80,condition:180,target:160,city:80} as const;
const numericLimits={stockRemaining:1_000_000_000,cashOfferXaf:1_000_000_000_000,
  voucherOfferXaf:1_000_000_000_000,priceMinXaf:1_000_000_000_000,
  priceMaxXaf:1_000_000_000_000} as const;
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
