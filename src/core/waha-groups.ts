/** Read-only provider boundary. A discovered name is a suggestion, never consent. */
export interface DiscoveredGroup {id:string;name:string;}
const groupId=/^[0-9-]+@g\.us$/;
const object=(v:unknown):v is Record<string,unknown>=>
  !!v&&typeof v==='object'&&!Array.isArray(v);

export function normalizeWahaGroups(value:unknown):DiscoveredGroup[]{
  if(object(value)){
    for(const field of ['data','groups','items','results']){
      if(Array.isArray(value[field])||object(value[field]))return normalizeWahaGroups(value[field]);
    }
  }
  if(!Array.isArray(value)&&!object(value))throw Error('WAHA_GROUPS_INVALID');
  const entries=Array.isArray(value)?value.map(v=>['',v] as const):Object.entries(value);
  const groups=new Map<string,DiscoveredGroup>();
  for(const [key,row] of entries){
    if(!object(row))throw Error('WAHA_GROUPS_INVALID');
    const nested=object(row.id)?row.id._serialized:undefined;
    const id=typeof row.id==='string'?row.id:typeof nested==='string'?nested:key;
    const name=typeof row.subject==='string'?row.subject:row.name;
    if(!groupId.test(id)||typeof name!=='string'||name.length>120)
      throw Error('WAHA_GROUPS_INVALID');
    if(key&&groupId.test(key)&&key!==id)throw Error('WAHA_GROUPS_INVALID');
    groups.set(id,{id,name});
  }
  return [...groups.values()];
}

export function matchesProject(name:string,project:string):boolean{
  const normalize=(s:string)=>s.normalize('NFKD').replace(/\p{M}/gu,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  return (` ${normalize(name)} `).includes(` ${normalize(project)} `);
}

export class WahaGroupDirectory{
  private readonly base:URL;
  constructor(private readonly config:{baseUrl:string;apiKey:string;session:string},
    private readonly http:typeof fetch=fetch){
    const u=new URL(config.baseUrl);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname!=='/'||
      !/^[-_a-zA-Z0-9]{1,48}$/.test(config.session)||config.apiKey.length<8)
      throw Error('WAHA_DISCOVERY_CONFIG_INVALID');
    this.base=u;
  }
  private async read(path:string):Promise<unknown>{
    const http=this.http;
    const response=await http(new URL(path,this.base).href,{
      headers:{'X-Api-Key':this.config.apiKey,accept:'application/json'},
      signal:AbortSignal.timeout(8000),redirect:'manual'
    });
    if(!response.ok)throw Error('WAHA_DISCOVERY_UNAVAILABLE');
    // Bound the body even when a provider ignores exclude=participants.
    const reader=response.body?.getReader();
    if(!reader)throw Error('WAHA_GROUPS_INVALID');
    const decoder=new TextDecoder();let raw='',bytes=0;
    try{
      for(;;){
        const part=await reader.read();if(part.done)break;
        bytes+=part.value.byteLength;
        if(bytes>1048576){await reader.cancel();throw Error('WAHA_GROUPS_TOO_LARGE');}
        raw+=decoder.decode(part.value,{stream:true});
      }
      raw+=decoder.decode();return JSON.parse(raw);
    }finally{reader.releaseLock();}
  }
  async list():Promise<DiscoveredGroup[]>{
    const path='/api/'+encodeURIComponent(this.config.session)+'/groups';
    const count=await this.read(path+'/count');
    if(!object(count)||!Number.isSafeInteger(count.count)||Number(count.count)<0||Number(count.count)>1000)
      throw Error('WAHA_GROUP_COUNT_INVALID');
    const expected=Number(count.count),found=new Map<string,DiscoveredGroup>();
    // Deterministic pagination; never reconcile an incomplete snapshot.
    for(let offset=0;offset<expected;offset+=100){
      const page=normalizeWahaGroups(await this.read(path+
        '?limit=100&offset='+offset+'&sortBy=id&sortOrder=asc&exclude=participants'));
      for(const group of page)found.set(group.id,group);
      if(found.size===expected)break; // NOWEB can return the whole keyed object.
    }
    if(found.size!==expected)throw Error('WAHA_GROUP_SNAPSHOT_INCOMPLETE');
    return [...found.values()];
  }
}
