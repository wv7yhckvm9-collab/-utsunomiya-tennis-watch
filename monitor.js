import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FACILITIES = [
  { name: '屋板テニスコート', id: '1030' },
  { name: '宮原テニスコート', id: '1032' }
];
const BASE = 'https://yoyacool.e-harp.jp/utsunomiya/FacilityAvailability/Index/092011';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 10 * 60 * 1000);
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD || 60);
const STATE_FILE = process.env.STATE_FILE || './state.json';
const START_HOUR = 8;
const END_HOUR = 12;

const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const weekend = d => d.getDay() === 0 || d.getDay() === 6;
const targetDates = () => { const a=[]; const now=new Date(); for(let i=0;i<DAYS_AHEAD;i++){const d=new Date(now);d.setHours(0,0,0,0);d.setDate(d.getDate()+i);if(weekend(d))a.push(d)} return a; };

async function loadState(){ try{return JSON.parse(await fs.readFile(STATE_FILE,'utf8'));}catch{return {}} }
async function saveState(s){ await fs.writeFile(STATE_FILE, JSON.stringify(s,null,2)); }

function normalize(s){ return s.replace(/\s+/g,' ').trim(); }
function extractAvailability(text, facility, date, url){
  const lines=text.split('\n').map(normalize).filter(Boolean);
  const results=[];
  // The site exposes the availability table as text. Capture rows containing a time range
  // and mark only rows that contain the site's "利用可能" state.
  for (let i=0;i<lines.length;i++) {
    const line=lines[i];
    if (!/利用可能/.test(line)) continue;
    const timeMatch=line.match(/(\d{1,2}:\d{2})[^\d]*(?:から|〜|-)(?:\s*)(\d{1,2}:\d{2})/);
    if (timeMatch) {
      const h=Number(timeMatch[1].split(':')[0]);
      if(h>=START_HOUR && h<END_HOUR) results.push({facility,date,time:`${timeMatch[1]}-${timeMatch[2]}`,raw:line,url});
      continue;
    }
    const around=lines.slice(Math.max(0,i-2),Math.min(lines.length,i+3)).join(' ');
    const tm=around.match(/(\d{1,2})時(?:から|〜|-)(\d{1,2})時/);
    if(tm && Number(tm[1])>=START_HOUR && Number(tm[1])<END_HOUR) results.push({facility,date,time:`${tm[1]}:00-${tm[2]}:00`,raw:around,url});
  }
  return results;
}

async function scan(page, facility, date){
  const ds=ymd(date);
  const url=`${BASE}/${facility.id}?d=${ds}&ptn=2&rc=101`;
  await page.goto(url,{waitUntil:'networkidle',timeout:45000});
  await page.waitForTimeout(1200);
  const text=await page.locator('body').innerText();
  return extractAvailability(text,facility.name,ds,url);
}

async function notify(items){
  if(!items.length)return;
  const msg=items.map(x=>`🎾 ${x.facility}\n${x.date} ${x.time}`).join('\n\n');
  console.log('\n=== NEW AVAILABLE SLOTS ===\n'+msg+'\n===========================\n');
  if(process.env.DISCORD_WEBHOOK_URL){
    await fetch(process.env.DISCORD_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:msg})});
  }
  if(process.env.LINE_NOTIFY_TOKEN){
    console.warn('LINE Notify is no longer supported by LINE. Use a LINE Messaging API webhook/provider instead.');
  }
}

async function runOnce(){
  const state=await loadState();
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({locale:'ja-JP',timezoneId:'Asia/Tokyo'});
  const current=[];
  try{
    for(const f of FACILITIES){
      for(const d of targetDates()){
        try{ current.push(...await scan(page,f,d)); }
        catch(e){ console.error(`[ERROR] ${f.name} ${ymd(d)} ${e.message}`); }
      }
    }
  } finally { await browser.close(); }
  const key=x=>`${x.facility}|${x.date}|${x.time}`;
  const old=new Set(state.available||[]);
  const now=new Set(current.map(key));
  const fresh=current.filter(x=>!old.has(key(x)));
  await saveState({available:[...now],updatedAt:new Date().toISOString()});
  await notify(fresh);
  console.log(new Date().toLocaleString('ja-JP'),`checked=${current.length} new=${fresh.length}`);
}

async function main(){
  await runOnce();
  if(process.env.ONCE === '1') return;
  setInterval(()=>runOnce().catch(e=>console.error(e)),INTERVAL_MS);
}
main().catch(e=>{console.error(e);process.exit(1)});
