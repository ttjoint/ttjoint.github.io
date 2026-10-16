#!/usr/bin/env node
/**
 * 抓取人民网“中国共产党历届中央领导集体”专题的人物资料。
 * 仅在离线导入时运行，不在浏览器端直接抓取（避免 CORS、不可复现和源站压力）。
 * 用法：node scripts/import_cpc.js [--dry-run] [--limit=20]
 * 注意：抓取结果必须人工复核；source 保存原文 URL、抓取时间和原始摘要。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const ROOT = path.join(__dirname, '..');
const BATCH = new Date().toISOString().replace(/[:.]/g, '-');
const BATCH_DIR = path.join(ROOT, 'data', 'imports', 'cpc', BATCH);
const FILE = path.join(ROOT, 'data/persons/index.json');
const INDEX = 'https://cpc.people.com.cn/GB/64162/394696/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(url) { return new Promise((resolve, reject) => { const lib=url.startsWith('https')?https:http; lib.get(url,{headers:{'User-Agent':'HumanMap offline importer/1.0'}},res=>{let b=[];res.on('data',x=>b.push(x));res.on('end',()=>res.statusCode>=400?reject(Error('HTTP '+res.statusCode)):resolve(Buffer.concat(b).toString('utf8')))}).on('error',reject); }); }
function entityId(name) { return 'person:' + require('crypto').createHash('sha256').update(`person\0${name}`).digest('hex').slice(0,20); }
function text(html) { return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&#\d+;/g,' ').replace(/\s+/g,' ').trim(); }
function links(html) { const out=[]; const re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m; while((m=re.exec(html))) { const name=text(m[2]); const url=abs(m[1]); if(name && /cpc\.people\.com\.cn/.test(url) && /n1\//.test(url)) out.push({name,url}); } return [...new Map(out.map(x=>[x.url,x])).values()]; }
function field(html, label) { const re=new RegExp(label+'[：:]?\\s*([^<]{1,120})','i'); const m=html.match(re); return m ? text(m[1]) : ''; }
(async()=>{ const args=process.argv.slice(2); const limit=+(args.find(x=>x.startsWith('--limit='))||'--limit=999').split('=')[1]; const indexHtml=await get(INDEX); const people=links(indexHtml).slice(0,limit); const now=new Date().toISOString(); const records=[];
 for (const p of people) { try { const html=await get(p.url); const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]; const body=text(html).slice(0,1800); records.push({id:entityId(p.name),legacyId:p.name,name:p.name,type:'person',props:{简介:body,'来源栏目':'人民网：中国共产党历届中央领导集体'},aliases:[],tags:['中国共产党','人民网专题'],relations:{},sources:[{id:'cpc-'+Buffer.from(p.url).toString('base64url'),name:'人民网人物资料',url:p.url,accessedAt:now,note:'离线抓取摘要，需人工核验'}],external:{cpcUrl:p.url,title:text(title||'')}}); await sleep(250); } catch(e){ console.error('跳过',p.url,e.message); } }
 const old=JSON.parse(fs.readFileSync(FILE,'utf8')); const map=new Map(old.map(x=>[x.id,x])); records.forEach(x=>{ const prev=map.get(x.id) || old.find(y=>y.name===x.name); map.set(x.id,prev?{...prev,props:{...x.props,...prev.props},sources:[...(prev.sources||[]),...x.sources],external:{...(prev.external||{}),...x.external}}:x); });
 const manifest={source:INDEX, fetchedAt:now, parserVersion:'1.1.0', discovered:people.length, imported:records.length, links:people, records:records.map(x=>({id:x.id,url:x.external.cpcUrl}))};
 console.log(`发现 ${people.length} 个链接，得到 ${records.length} 条人物记录；合并后 ${map.size} 条`); if(!args.includes('--dry-run')) { fs.mkdirSync(BATCH_DIR,{recursive:true}); fs.writeFileSync(path.join(BATCH_DIR,'manifest.json'),JSON.stringify(manifest,null,2)+'\n'); fs.writeFileSync(FILE,JSON.stringify([...map.values()],null,2)+'\n'); }
})().catch(e=>{console.error(e);process.exit(1)});
