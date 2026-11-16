/**
 * Extracts the WhatsApp message key from a WAHA response or webhook value.
 * WAHA serializes ids as `<fromMe>_<chat>_<key>[_<participant>]` (WEBJS/NOWEB) and NOWEB
 * may also return the raw `key.id`. Only the key is kept: it matches across engines and
 * across sent/received forms, and it contains no chat id or phone number.
 */
const KEY=/^[A-Za-z0-9]{8,64}$/;
const SERIALIZED=/^(?:true|false)_[^_\s]+_([A-Za-z0-9]{8,64})(?:_[^\s]+)?$/;

export function wahaMessageKeyId(value:unknown):string|undefined{
  if(typeof value==='string'){
    const serialized=SERIALIZED.exec(value);
    if(serialized)return serialized[1];
    return KEY.test(value)?value:undefined;
  }
  if(!value||typeof value!=='object')return undefined;
  const v=value as Record<string,unknown>;
  const key=v.key&&typeof v.key==='object'?(v.key as Record<string,unknown>).id:undefined;
  return wahaMessageKeyId(key)??(v.id&&typeof v.id==='object'
    ?wahaMessageKeyId((v.id as Record<string,unknown>)._serialized)??wahaMessageKeyId((v.id as Record<string,unknown>).id)
    :wahaMessageKeyId(v.id));
}

/** Reads a bounded JSON provider body; any parsing problem yields no id, never an error. */
export async function wahaResponseMessageId(response:Response):Promise<string|undefined>{
  try{
    const text=await response.text();
    return text.length<=65536?wahaMessageKeyId(JSON.parse(text)):undefined;
  }catch{return undefined;}
}
