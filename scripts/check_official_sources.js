#!/usr/bin/env node
const fs=require('fs'),path=require('path'),https=require('https'),http=require('http');
const root=path.join(__dirname,'..'),file=path.join(root,'data/sources/official.json'),out=path.join(root,'data/imports/official');const config=JSON.parse(fs.readFileSync(file));
function get(u){return new Promise((resolve,reject)=>{const l=u.startsWith('https')?https:http;l.get(u,{headers:{'User-Agent':'HumanMap official-source-discovery/1.0'}},r=>{let b=[];r.on('data',x=>b.push(x));r.on('end',()=>resolve({status:r.statusCode,url:r.headers.location||u,bytes:Buffer.concat(b).length}));}).on('error',reject)})}
(async()=>{const fetchedAt=new Date().toISOString(),results=[];for(const s of config.sources.filter(x=>x.enabled)){let r=null,err=null,usedFallback=false;try{r=await get(s.url)}catch(e){err=e}
// Some government hosts reject TLS handshakes at the WAF (e.g. SSL alert 40).
// When a plain-HTTP fallback is declared for the source, use it instead of reporting failure.
if(!r&&s.httpUrl){try{const f=await get(s.httpUrl);r=f;usedFallback=true}catch(e){err=e}}
if(r){results.push({...s,checkedAt:fetchedAt,status:r.status,bytes:r.bytes,finalUrl:r.url,viaHttpFallback:usedFallback});console.log(r.status,s.name,usedFallback?'(http fallback)':'')}else{results.push({...s,checkedAt:fetchedAt,status:0,error:err.message});console.error('FAIL',s.name,err.message)}}fs.mkdirSync(out,{recursive:true});const batch=fetchedAt.replace(/[:.]/g,'-');fs.writeFileSync(path.join(out,batch+'.json'),JSON.stringify({sourceConfig:file,fetchedAt,results},null,2)+'\n');fs.writeFileSync(path.join(out,'latest.json'),JSON.stringify({batch,file:batch+'.json',count:results.length},null,2)+'\n');})().catch(e=>{console.error(e);process.exit(1)})
