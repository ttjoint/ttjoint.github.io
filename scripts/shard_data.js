#!/usr/bin/env node
/** Split monolithic entity indexes into summary index + one JSON file per entity. */
const fs=require('fs'),path=require('path'); const root=path.join(__dirname,'..'),data=path.join(root,'data');
const cfg={persons:'person',organizations:'organization',events:'event'};
function summary(x,type){return {id:x.id,name:x.name||x.legacyId||x.id,type,aliases:x.aliases||[],tags:x.tags||[],summary:(x.props?.简介||x.props?.描述||'').slice(0,240),external:x.external||null,detail:`entities/${encodeURIComponent(x.id)}.json`};}

for(const [folder,type] of Object.entries(cfg)){const dir=path.join(data,folder), detail=path.join(dir,'entities');fs.mkdirSync(detail,{recursive:true});const rows=JSON.parse(fs.readFileSync(path.join(dir,'index.json')));const index=rows.map(x=>summary(x,type));for(const x of rows)fs.writeFileSync(path.join(detail,encodeURIComponent(x.id)+'.json'),JSON.stringify(x,null,2)+'\n');fs.writeFileSync(path.join(dir,'index.json'),JSON.stringify(index,null,2)+'\n');fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({version:1,type,count:index.length,generatedAt:new Date().toISOString(),index:'index.json',detailDir:'entities/'},null,2)+'\n');console.log(folder,index.length);}
