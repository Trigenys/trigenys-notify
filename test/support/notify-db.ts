import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import type {NotifyDatabase,NotifyStatement} from '../../src/core/group-routing.js';

/** Run the real migration/query SQL rather than imitating it in a fake map. */
export function routingDb(through='0002'){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync('backend/migrations').sort()){
    if(name.endsWith('.sql')&&name.slice(0,4)<=through)
      sqlite.exec(readFileSync('backend/migrations/'+name,'utf8'));
  }
  const db:NotifyDatabase={
    prepare(sql){return {bind(...args){
      const statement=sqlite.prepare(sql.replace(/\?(\d+)/g,':p$1'));
      const values=Object.fromEntries(args.map((v,i)=>['p'+(i+1),v]));
      statement.setAllowUnknownNamedParameters(true);
      return {
        async run(){return statement.run(values);},
        async first<T>(){const row=statement.get(values);return row?{...row} as T:null;},
        async all<T>(){return {results:statement.all(values).map(row=>({...row})) as T[]};}
      };
    }};},
    async batch(statements:NotifyStatement[]){
      sqlite.exec('BEGIN');
      try{for(const statement of statements)await statement.run();sqlite.exec('COMMIT');}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    }
  };
  return {db,sqlite,close:()=>sqlite.close()};
}
