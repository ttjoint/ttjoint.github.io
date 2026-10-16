#!/usr/bin/env node
/** Migrate legacy name keys to stable, type-scoped IDs and emit sharded read data. */
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=path.join(__dirname,'..'), data=path.join(root,'data');
const types={persons:'person',organizations:'organization',events:'event'};
const maps={};
function stable(type, legacy){return `${type}:${crypto.createHash('sha256').update(`${type}\0${legacy}`).digest('hex').slice(0,20)}`}
function deepReplace(v,map, preserveKey) { if(typeof v==='string'){ if(!preserveKey && map.has(v)) return map.get(v); return v.replace(/【([^】|]+)(\|[^】]+)?】/g,(m,id,t)=>map.has(id)?`【${map.get(id)}${t||''}】`:m); } if(Array.isArray(v)) return v.map(x=>deepReplace(x,map)); if(v&&typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,deepReplace(x,map,k==='name'||k==='legacyId'))); return v; }
for(const [folder,type] of Object.entries(types)){const file=path.join(data,folder,'index.json');const rows=JSON.parse(fs.readFileSync(file)); maps[type]=new Map(rows.map(x=>[x.id,stable(type,x.id)]));}
const all=new Map(); for(const m of Object.values(maps)) for(const [a,b] of m) all.set(a,b);
for(const [folder,type] of Object.entries(types)){const file=path.join(data,folder,'index.json');const rows=JSON.parse(fs.readFileSync(file)); const out=rows.map(x=>{const y=deepReplace(x,all); y.id=maps[type].get(x.id); y.legacyId=x.id; y.type=type; return y;}); fs.writeFileSync(file,JSON.stringify(out,null,2)+'\n'); console.log(folder,out.length);}
console.log('migrated',all.size,'IDs');
