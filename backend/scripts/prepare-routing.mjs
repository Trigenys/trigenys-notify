/** Provision/migrate only in the existing main-branch Workers Builds pipeline.
 * The build's Cloudflare token is never copied into runtime bindings or logs.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

export async function ensureRoutingDatabase(config,{token,http=fetch}){
  const binding=config.d1_databases?.find(db=>db.binding==='NOTIFY_DB');
  if(!binding?.database_name||!config.account_id)throw Error('ROUTING_BINDING_NOT_CONFIGURED');
  const root=`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/d1/database`;
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  async function lookup(){
    return http(root+'/'+encodeURIComponent(binding.database_id||binding.database_name),{
      headers,signal:AbortSignal.timeout(20000),redirect:'error'});
  }
  let response=await lookup();
  if(response.status===404&&!binding.database_id){
    response=await http(root,{method:'POST',headers,body:JSON.stringify({name:binding.database_name}),
      signal:AbortSignal.timeout(20000),redirect:'error'});
    // A second build may have created the same database concurrently.
    if(response.status===409)response=await lookup();
  }
  if(!response.ok)throw Error('ROUTING_D1_API_HTTP_'+response.status);
  const body=await response.json();
  if(body.success===false||typeof body.result?.uuid!=='string'||
    !/^[0-9a-f-]{36}$/i.test(body.result.uuid)||body.result.name!==binding.database_name)
    throw Error('ROUTING_D1_RESPONSE_INVALID');
  binding.database_id=body.result.uuid;
  return config;
}

async function main(){
  if(process.env.WORKERS_CI!=='1'){
    console.log('Routing provisioning skipped outside Workers Builds.');return;
  }
  if(process.env.WORKERS_CI_BRANCH!=='main'){
    throw Error('ROUTING_PROVISION_REQUIRES_MAIN_BRANCH');
  }
  const token=process.env.CLOUDFLARE_API_TOKEN;
  if(!token)throw Error('ROUTING_PROVISION_BUILD_TOKEN_MISSING');
  const configPath='wrangler.production.jsonc';
  const config=await ensureRoutingDatabase(JSON.parse(await readFile(configPath,'utf8')),{token});
  await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
  const result=spawnSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),
    'd1','migrations','apply','NOTIFY_DB','--remote','--config',configPath],{
      stdio:'inherit',env:{...process.env,CI:'true'}});
  if(result.status!==0)throw Error('ROUTING_MIGRATIONS_FAILED');
  console.log('Routing database ready; migrations applied before Worker deployment.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(error=>{
    // Deliberately omit response bodies and stacks: build logs are not a vault.
    console.error(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)
      ?error.message:'ROUTING_PROVISION_FAILED');process.exitCode=1;
  });
}
