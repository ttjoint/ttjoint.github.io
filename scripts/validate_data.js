#!/usr/bin/env node
const fs=require('fs'); const path=require('path');
const root=path.join(__dirname,'..'); let errors=0;
for(const type of ['persons','organizations','events']){
 const f=path.join(root,'data',type,'index.json'); let a;
 try{a=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){console.error(f,e.message);errors++;continue}
 const ids=new Set(); for(const x of a){if(!x.id||ids.has(x.id)){console.error(`${f}: duplicate or missing id`,x.id);errors++} ids.add(x.id); if(x.type!==({persons:'person',organizations:'organization',events:'event'}[type])){console.error(`${f}: invalid type`,x.id);errors++}}
 console.log(`${type}: ${a.length} records`)
}
process.exitCode=errors?1:0;
