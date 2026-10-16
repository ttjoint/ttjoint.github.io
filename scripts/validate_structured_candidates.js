#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const dir=path.join(__dirname,'..','data/imports/official');
const f=fs.readdirSync(dir).filter(x=>x.startsWith('structured-')).sort().at(-1);
if(!f)throw Error('run extract:structured first');
const x=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')),errors=[],ids=new Set();
const arrays=['currentPositions','career'];
for(const r of x.records){
  if(!/^person:[0-9a-f]{20}$/.test(r.id))errors.push('invalid id '+r.id);
  if(ids.has(r.id))errors.push('duplicate id '+r.id);
  ids.add(r.id);
  if(!r.evidence?.sourceUrl)errors.push('missing evidence url '+r.id);
  if(!r.evidence?.excerpt)errors.push('missing evidence excerpt '+r.id);
  if(!['pending','approved','rejected'].includes(r.status))errors.push('invalid status '+r.id);
  if(!r.candidate?.name)errors.push('missing name '+r.id);
  if(!r.provenance?.method)errors.push('missing provenance '+r.id);
  const c=r.candidate||{};
  // A batch is only valid if the LLM step actually succeeded.
  if(c.llmError)errors.push('llm failed for '+r.id+': '+c.llmError);
  for(const k of arrays)if(c[k]!==undefined&&!Array.isArray(c[k]))errors.push(k+' must be array '+r.id);
  for(const k of ['name','birthDate','nativePlace','ethnicity','education','summary']){
    if(typeof c[k]==='string'&&c[k].includes('undefined'))errors.push(k+' contains "undefined" '+r.id);
  }
  // reject mojibake evidence
  if(r.evidence?.excerpt&&/鐭|閲|鍏|鐜|鐨|銆/.test(r.evidence.excerpt))errors.push('mojibake evidence '+r.id);
}
console.log(JSON.stringify({file:f,count:x.count,actual:x.records.length,uniqueIds:ids.size,errors},null,2));
process.exitCode=errors.length||x.count!==x.records.length?1:0;
