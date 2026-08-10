// Generated from extensions/adminbot/content/deadlines/deadlines-board.html by
// scripts/adminbot-deadline-web-ui-gen.py. Do not hand-edit; regenerate instead.
// Renders the self-contained live deadline countdown board (Output 0).

const TEMPLATE = `<title>Jinesis Deadlines — Countdown</title>
<style>
  :root{
    --bg:#0b0f1a; --surface:#141b2b; --surface-2:#1b2437; --raised:#202b41;
    --border:#26324a; --border-soft:#1e2740;
    --ink:#e8edf7; --ink-2:#9fb0cc; --muted:#66799a;
    --accent:#8ea2ff; --accent-strong:#6f86ff;
    --calm:#34d3a6; --warn:#eab54a; --serious:#f5883e; --crit:#f2606a;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace;
    --radius:14px; --gap:16px;
  }
  *{box-sizing:border-box}
  body{margin:0}
  .wrap{background:var(--bg);color:var(--ink);font-family:var(--sans);
    min-height:100vh;padding:28px clamp(14px,4vw,40px) 64px;line-height:1.5;
    -webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}
  a:hover{color:var(--accent-strong)}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
  .container{max-width:1200px;margin:0 auto}

  /* header */
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;
    color:var(--muted);margin:0 0 8px}
  h1{font-size:clamp(24px,4vw,34px);margin:0;letter-spacing:-.02em;text-wrap:balance;font-weight:650}
  .sub{color:var(--ink-2);margin:8px 0 0;max-width:62ch;font-size:14.5px}
  .sub b{color:var(--ink);font-weight:600}

  /* hero + stats grid */
  .top{display:grid;grid-template-columns:1.3fr .9fr;gap:var(--gap);margin:26px 0}
  @media(max-width:760px){.top{grid-template-columns:1fr}}
  .hero{background:linear-gradient(160deg,var(--surface-2),var(--surface));
    border:1px solid var(--border);border-radius:var(--radius);padding:22px 24px;position:relative;overflow:hidden}
  .hero::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--h-color,var(--accent))}
  .hero .lbl{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  .hero .hname{font-size:18px;font-weight:600;margin:10px 0 2px;letter-spacing:-.01em;line-height:1.3}
  .hero .hmeta{color:var(--ink-2);font-size:13px;margin-bottom:16px}
  .cd{font-family:var(--mono);font-variant-numeric:tabular-nums;display:flex;gap:14px;align-items:flex-end}
  .cd .unit{display:flex;flex-direction:column;align-items:center;gap:4px}
  .cd .num{font-size:clamp(26px,5vw,40px);font-weight:600;line-height:1;color:var(--ink)}
  .cd .cap{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .cd .sep{font-size:26px;color:var(--border);align-self:center;padding-bottom:14px}

  .stats{display:grid;grid-template-rows:repeat(3,1fr);gap:var(--gap)}
  .stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
    padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px}
  .stat .k{color:var(--ink-2);font-size:13px}
  .stat .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:24px;font-weight:600}

  /* controls */
  .controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0 18px}
  .search{flex:1 1 220px;min-width:180px;background:var(--surface);border:1px solid var(--border);
    color:var(--ink);border-radius:10px;padding:10px 13px;font-size:14px;font-family:var(--sans)}
  .search::placeholder{color:var(--muted)}
  .chips{display:flex;gap:8px;flex-wrap:wrap}
  .chip{background:var(--surface);border:1px solid var(--border);color:var(--ink-2);
    padding:8px 13px;border-radius:999px;font-size:13px;cursor:pointer;font-family:var(--sans);
    display:inline-flex;gap:7px;align-items:center;transition:background .15s,color .15s,border-color .15s}
  .chip:hover{border-color:var(--accent)}
  .chip[aria-pressed=true]{background:color-mix(in srgb,var(--accent) 20%,transparent);
    border-color:var(--accent);color:var(--ink)}
  .chip .ct{font-family:var(--mono);font-size:11px;color:var(--muted)}
  .chip[aria-pressed=true] .ct{color:var(--accent)}
  .toggle{display:flex;border:1px solid var(--border);border-radius:10px;overflow:hidden}
  .toggle button{background:var(--surface);border:0;color:var(--ink-2);padding:8px 14px;font-size:13px;
    cursor:pointer;font-family:var(--sans)}
  .toggle button[aria-pressed=true]{background:var(--raised);color:var(--ink)}

  /* cards */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:var(--gap)}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
    padding:16px 16px 15px 19px;position:relative;overflow:hidden;display:flex;flex-direction:column;gap:9px}
  .card::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--u)}
  .card .row1{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .badge{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--ink-2);border:1px solid var(--border);border-radius:6px;padding:3px 7px;white-space:nowrap}
  .pill{font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap;
    background:color-mix(in srgb,var(--u) 18%,transparent);color:var(--u)}
  .cname{font-size:15px;font-weight:600;line-height:1.3;letter-spacing:-.01em;margin:1px 0}
  .cgroup{font-size:12px;color:var(--muted)}
  .cdl{font-family:var(--mono);font-size:12.5px;color:var(--ink-2);font-variant-numeric:tabular-nums}
  .cdl .aoe{color:var(--muted)}
  .ccd{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:19px;font-weight:600;
    color:var(--ink);letter-spacing:.01em}
  .cnote{font-size:11.5px;color:var(--muted)}
  .clink{margin-top:auto;font-size:12.5px;font-family:var(--mono)}

  /* table */
  .tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
  table{border-collapse:collapse;width:100%;font-size:13px;min-width:640px}
  th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border-soft);white-space:nowrap}
  th{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);
    position:sticky;top:0;background:var(--surface-2)}
  td.name{white-space:normal;min-width:260px}
  td .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--u);margin-right:8px;vertical-align:middle}
  .tcd{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--ink)}
  tr:last-child td{border-bottom:0}
  .hidden{display:none!important}
  .empty{color:var(--muted);text-align:center;padding:40px;font-size:14px}
  .foot{margin-top:26px;color:var(--muted);font-size:12px;font-family:var(--mono)}
  @media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap"><div class="container">
  <p class="eyebrow">Jinesis Lab · Submission Deadlines</p>
  <h1>Deadline Countdown</h1>
  <p class="sub">Upcoming conference &amp; workshop deadlines. Times are <b>AoE (UTC‑12)</b>; countdowns update live. NeurIPS 2026 workshops use the official unified deadline (submission <b>Aug 29</b>, hard accept/reject <b>Sep 29</b>).</p>

  <div class="top">
    <div class="hero" id="hero"></div>
    <div class="stats">
      <div class="stat"><span class="k">Tracked deadlines</span><span class="v" id="s-total">–</span></div>
      <div class="stat"><span class="k">Due within 7 days</span><span class="v" id="s-7" style="color:var(--serious)">–</span></div>
      <div class="stat"><span class="k">Due within 30 days</span><span class="v" id="s-30" style="color:var(--warn)">–</span></div>
    </div>
  </div>

  <div class="controls">
    <input class="search" id="search" type="search" placeholder="Search workshops & venues…" aria-label="Search deadlines">
    <div class="chips" id="chips" role="group" aria-label="Filter by venue"></div>
    <div class="toggle" role="group" aria-label="View">
      <button id="v-cards" aria-pressed="true">Cards</button>
      <button id="v-table" aria-pressed="false">Table</button>
    </div>
  </div>

  <div class="grid" id="grid"></div>
  <div class="tablewrap hidden" id="tablewrap">
    <table><thead><tr><th>Deadline (AoE)</th><th>Countdown</th><th>Item</th><th>Type</th><th>Venue</th><th></th></tr></thead>
    <tbody id="tbody"></tbody></table>
  </div>
  <div class="empty hidden" id="empty">No deadlines match your filter.</div>

  <p class="foot" id="foot"></p>
</div></div>

<script>
const DATA = __ITEMS_JSON__;
// AoE (UTC-12): wall-clock T corresponds to UTC instant T + 12h
function aoeToUTC(s){
  const m=s.match(/(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})/);
  if(!m) return null;
  const [_,y,mo,d,h,mi,se]=m.map(Number);
  return Date.UTC(y,mo-1,d,h,mi,se)+12*3600*1000;
}
DATA.forEach(x=>{x._sub=aoeToUTC(x.deadline_aoe); x._notif=x.notification_aoe?aoeToUTC(x.notification_aoe):null;});
DATA.sort((a,b)=>a._sub-b._sub);

const MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(ms){const d=new Date(ms);return \`\${MONTHS[d.getUTCMonth()]} \${d.getUTCDate()}, \${d.getUTCFullYear()}\`;}
function fmtAoe(x){const m=(x||"").match(/(\\d{4})-(\\d{2})-(\\d{2})/);if(!m)return "";return \`\${MONTHS[+m[2]-1]} \${+m[3]}, \${m[1]}\`;}
function urgencyVar(days){return days<=3?'var(--crit)':days<=7?'var(--serious)':days<=30?'var(--warn)':'var(--calm)';}
function urgencyLabel(ms,now){
  const diff=ms-now; if(diff<=0) return {txt:'passed',cvar:'var(--muted)'};
  const days=diff/86400000;
  const d=Math.floor(days);
  const cvar=urgencyVar(days);
  return {txt:d===0?'today':(d+' day'+(d===1?'':'s')+' left'),cvar};
}
function parts(diff){
  if(diff<0) diff=0;
  const d=Math.floor(diff/86400000);
  const h=Math.floor(diff/3600000)%24;
  const m=Math.floor(diff/60000)%60;
  const s=Math.floor(diff/1000)%60;
  return {d,h,m,s};
}
const pad=n=>String(n).padStart(2,'0');

// groups / chips
const groups=[...new Set(DATA.map(x=>x.venue_group))];
const groupOrder=(g)=>DATA.filter(x=>x.venue_group===g)[0]._sub;
groups.sort((a,b)=>groupOrder(a)-groupOrder(b));
let activeGroup='All', view='cards', query='';
const chips=document.getElementById('chips');
function chip(label,val,count){
  const b=document.createElement('button');b.className='chip';b.setAttribute('aria-pressed',val===activeGroup);
  b.innerHTML=\`\${label} <span class="ct">\${count}</span>\`;
  b.onclick=()=>{activeGroup=val;[...chips.children].forEach(c=>c.setAttribute('aria-pressed','false'));b.setAttribute('aria-pressed','true');render();};
  chips.appendChild(b);
}
chip('All','All',DATA.length);
groups.forEach(g=>chip(g,g,DATA.filter(x=>x.venue_group===g).length));

document.getElementById('search').addEventListener('input',e=>{query=e.target.value.toLowerCase().trim();render();});
function setView(v){view=v;document.getElementById('v-cards').setAttribute('aria-pressed',v==='cards');
  document.getElementById('v-table').setAttribute('aria-pressed',v==='table');
  document.getElementById('grid').classList.toggle('hidden',v!=='cards');
  document.getElementById('tablewrap').classList.toggle('hidden',v!=='table');render();}
document.getElementById('v-cards').onclick=()=>setView('cards');
document.getElementById('v-table').onclick=()=>setView('table');

function filtered(){
  return DATA.filter(x=>(activeGroup==='All'||x.venue_group===activeGroup)
    && (!query || (x.name+' '+x.venue_group+' '+x.track).toLowerCase().includes(query)));
}
const grid=document.getElementById('grid'),tbody=document.getElementById('tbody'),
  empty=document.getElementById('empty'),hero=document.getElementById('hero');

function render(){
  const now=Date.now();
  const list=filtered();
  empty.classList.toggle('hidden',list.length>0);
  // stats (over full dataset, not filtered)
  const up=DATA.filter(x=>x._sub>now);
  document.getElementById('s-total').textContent=up.length;
  document.getElementById('s-7').textContent=up.filter(x=>(x._sub-now)<=7*86400000).length;
  document.getElementById('s-30').textContent=up.filter(x=>(x._sub-now)<=30*86400000).length;

  // hero = soonest upcoming (respect current filter)
  const next=list.find(x=>x._sub>now)||list[0];
  if(next){
    const u=urgencyLabel(next._sub,now);hero.style.setProperty('--h-color',u.cvar);
    const p=parts(next._sub-now);
    hero.innerHTML=\`<div class="lbl">Next deadline · \${next.venue_group}</div>
      <div class="hname">\${esc(next.name)}</div>
      <div class="hmeta">\${cap(next.deadline_label)} · \${fmtAoe(next.deadline_aoe)} — 23:59 AoE · <span style="color:\${u.cvar}">\${u.txt}</span></div>
      <div class="cd" data-t="\${next._sub}">
        \${unit(p.d,'days')}<span class="sep">:</span>\${unit(pad(p.h),'hrs')}<span class="sep">:</span>\${unit(pad(p.m),'min')}<span class="sep">:</span>\${unit(pad(p.s),'sec')}
      </div>\`;
  } else hero.innerHTML='<div class="lbl">Next deadline</div><div class="hname">Nothing upcoming</div>';

  if(view==='cards') renderCards(list,now); else renderTable(list,now);
}
function unit(v,c){return \`<div class="unit"><span class="num">\${v}</span><span class="cap">\${c}</span></div>\`;}
function cap(s){return s.charAt(0).toUpperCase()+s.slice(1);}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

function renderCards(list,now){
  grid.innerHTML=list.map(x=>{
    const u=urgencyLabel(x._sub,now);const p=parts(x._sub-now);
    const type=x.venue_type==='workshop'?'Workshop':(x.venue_type==='rebuttal'?'Rebuttal':'Conference');
    const link=x.link?\`<a class="clink" href="\${esc(x.link)}" target="_blank" rel="noopener">Open call ↗</a>\`:'';
    const notif=x._notif?\`<div class="cnote">Accept/reject: \${fmtAoe(x.notification_aoe)} AoE</div>\`:'';
    return \`<div class="card" style="--u:\${u.cvar}">
      <div class="row1"><span class="badge">\${type}</span><span class="pill">\${u.txt}</span></div>
      <div class="cname">\${esc(x.name)}</div>
      <div class="cgroup">\${esc(x.venue_group)} · \${esc(cap(x.deadline_label))}</div>
      <div class="cdl">\${fmtAoe(x.deadline_aoe)} <span class="aoe">· 23:59 AoE</span></div>
      <div class="ccd" data-t="\${x._sub}">\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}</div>
      \${notif}\${link}
    </div>\`;}).join('');
}
function renderTable(list,now){
  tbody.innerHTML=list.map(x=>{
    const u=urgencyLabel(x._sub,now);const p=parts(x._sub-now);
    const type=x.venue_type==='workshop'?'Workshop':(x.venue_type==='rebuttal'?'Rebuttal':'Conf');
    const link=x.link?\`<a href="\${esc(x.link)}" target="_blank" rel="noopener">↗</a>\`:'';
    return \`<tr><td class="tcd">\${fmtAoe(x.deadline_aoe)}</td>
      <td class="tcd" data-t="\${x._sub}">\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}</td>
      <td class="name"><span class="dot" style="--u:\${u.cvar}"></span>\${esc(x.name)}</td>
      <td>\${type}</td><td>\${esc(x.venue_group)}</td><td>\${link}</td></tr>\`;}).join('');
}
// live tick: update only the countdown numbers, cheaply
function tick(){
  const now=Date.now();
  document.querySelectorAll('[data-t]').forEach(el=>{
    const p=parts(Number(el.dataset.t)-now);
    if(el.classList.contains('cd')){
      const nums=el.querySelectorAll('.num');
      if(nums.length===4){nums[0].textContent=p.d;nums[1].textContent=pad(p.h);nums[2].textContent=pad(p.m);nums[3].textContent=pad(p.s);}
    } else {el.textContent=\`\${p.d}d \${pad(p.h)}:\${pad(p.m)}:\${pad(p.s)}\`;}
  });
}
document.getElementById('foot').textContent=\`\${DATA.length} deadlines · source: aideadlines.org + OpenReview (NeurIPS.cc/2026/Workshop) · generated 2026-07-25\`;
render();
setInterval(tick,1000);
</script>`;

export function renderDeadlinesWebUi(items: readonly unknown[]): string {
  return TEMPLATE.replace("__ITEMS_JSON__", JSON.stringify(items));
}
