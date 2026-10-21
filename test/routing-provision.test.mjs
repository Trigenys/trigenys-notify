import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureRoutingDatabase} from '../backend/scripts/prepare-routing.mjs';

const config=()=>({account_id:'00000000000000000000000000000000',d1_databases:[
  {binding:'NOTIFY_DB',database_name:'trigenys-notify-routing-staging'}]});
const uuid='00000000-0000-4000-8000-000000000000';
const success=()=>Response.json({success:true,result:{uuid,name:'trigenys-notify-routing-staging'}});
test('provisioning reuses the exact named D1 database; no creation on API permission failure',async()=>{
  let calls=0;
  const updated=await ensureRoutingDatabase(config(),{token:'test-token',http:async(_url,init)=>{
    calls++;assert.equal(init.method,undefined);return success();}});
  assert.equal(updated.d1_databases[0].database_id,uuid);assert.equal(calls,1);
  calls=0;
  await assert.rejects(ensureRoutingDatabase(config(),{token:'test-token',http:async()=>{
    calls++;return new Response('private',{status:403});}}),/ROUTING_D1_API_HTTP_403/);
  assert.equal(calls,1);
});
test('provisioning creates once on absence and reuses a concurrent creation',async()=>{
  const calls=[];
  const updated=await ensureRoutingDatabase(config(),{token:'test-token',http:async(_url,init)=>{
    calls.push(init.method??'GET');return calls.length===1?new Response('',{status:404}):success();}});
  assert.deepEqual(calls,['GET','POST']);assert.equal(updated.d1_databases[0].database_id,uuid);
  let index=0;
  await ensureRoutingDatabase(config(),{token:'test-token',http:async()=>{
    index++;return index===1?new Response('',{status:404}):index===2?new Response('',{status:409}):success();}});
  assert.equal(index,3);
});
