// Kim oshdi savdosi viktorinasi. Ishga tushirish: node server.js
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString('hex');

// ===== SOZLAMALAR =====
const START_SCORE = 100;   // hamma boshida oladigan ball
const MAX_BID = 25;        // maksimal tikish
const MAX_STEP = 3;        // bir marta oshirish: 1, 2 yoki 3
const FIRST_AUCTION_MS = 15000; // savdo boshlanganda kutish
const AFTER_BID_MS = 8000;      // har bir tikishdan keyin qolgan vaqt
const ANSWER_MS = 20000;        // g'olib javob berish vaqti

function newGame() {
  return { phase: 'setup', questions: [], players: {}, idx: -1, bid: 0, leader: null,
           deadline: 0, timer: null, result: null };
}
let G = newGame();
const clients = new Set();

// ===== TEST MATNINI O'QISH =====
function parseTest(text) {
  const lines = text.replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  const qs = []; const answers = {}; let cur = null; let inAns = false;
  const ansOnly = /^(\d+\s*[-.:)=]?\s*[A-Da-d][\s,;]*)+$/;
  const addAnswers = (line) => {
    const re = /(\d+)\s*[-.:)=]?\s*([A-Da-d])/g; let m;
    while ((m = re.exec(line))) answers[+m[1]] = m[2].toUpperCase();
  };
  for (const line of lines) {
    if (/^(javoblar|javob|kalitlar|to['‘’`]?g['‘’`]?ri javoblar|answers)\b/i.test(line)) { inAns = true; continue; }
    if (inAns) { addAnswers(line); continue; }
    if (cur && cur.options.length >= 2 && ansOnly.test(line)) { inAns = true; addAnswers(line); continue; }
    const opt = line.match(/^([A-Da-d])\s*[.)\-:]\s*(.+)$/);
    if (cur && opt) { cur.options.push({ k: opt[1].toUpperCase(), t: opt[2] }); continue; }
    const qm = line.match(/^(\d+)\s*[.)\-:]\s*(.+)$/);
    if (qm) { cur = { num: +qm[1], text: qm[2], options: [], answer: null }; qs.push(cur); continue; }
    if (cur) {
      if (cur.options.length) cur.options[cur.options.length - 1].t += ' ' + line;
      else cur.text += ' ' + line;
    }
  }
  const errors = [];
  if (!qs.length) errors.push('Birorta ham savol topilmadi.');
  for (const q of qs) {
    q.answer = answers[q.num] || null;
    if (q.options.length < 2) errors.push(q.num + '-savolda kamida 2 ta variant bo\'lishi kerak.');
    if (!q.answer) errors.push(q.num + '-savolning to\'g\'ri javobi topilmadi.');
    else if (!q.options.some(o => o.k === q.answer)) errors.push(q.num + '-savol: "' + q.answer + '" varianti yo\'q.');
  }
  return { qs, errors };
}

// ===== HOLATNI KO'RSATISH =====
function view(c) {
  const q = G.questions[G.idx];
  const s = {
    phase: G.phase, total: G.questions.length, idx: G.idx, bid: G.bid,
    maxBid: MAX_BID, leaderId: G.leader,
    leader: G.leader && G.players[G.leader] ? G.players[G.leader].name : null,
    remaining: Math.max(0, G.deadline - Date.now()),
    players: Object.values(G.players).map(p => ({ id: p.id, name: p.name, score: p.score, online: p.online }))
      .sort((a, b) => b.score - a.score),
    me: c.pid && G.players[c.pid] ? { id: c.pid, name: G.players[c.pid].name, score: G.players[c.pid].score } : null,
    result: G.result
  };
  if (G.phase === 'question' && q && (c.host || c.pid === G.leader)) s.q = { text: q.text, options: q.options };
  return s;
}
function broadcast() {
  for (const c of clients) c.res.write('data: ' + JSON.stringify(view(c)) + '\n\n');
}
function setTimer(ms, fn) {
  clearTimeout(G.timer); G.deadline = Date.now() + ms; G.timer = setTimeout(fn, ms);
}

// ===== O'YIN OQIMI =====
function nextRound() {
  clearTimeout(G.timer);
  G.idx++; G.bid = 0; G.leader = null; G.result = null;
  if (G.idx >= G.questions.length) { G.phase = 'end'; G.deadline = 0; return broadcast(); }
  G.phase = 'auction';
  setTimer(FIRST_AUCTION_MS, endAuction);
  broadcast();
}
function endAuction() {
  if (G.phase !== 'auction') return;
  if (!G.leader) {
    G.phase = 'result'; G.deadline = 0; clearTimeout(G.timer);
    G.result = { skipped: true, num: G.questions[G.idx].num };
    return broadcast();
  }
  G.phase = 'question';
  setTimer(ANSWER_MS, () => resolveAnswer(null));
  broadcast();
}
function resolveAnswer(choice) {
  if (G.phase !== 'question') return;
  clearTimeout(G.timer); G.deadline = 0;
  const q = G.questions[G.idx]; const p = G.players[G.leader];
  const right = choice === q.answer;
  const delta = right ? Math.ceil(G.bid / 2) : -G.bid;
  p.score += delta;
  G.phase = 'result';
  G.result = { name: p.name, bet: G.bid, choice, right, delta, num: q.num, text: q.text,
               options: q.options, correct: q.answer };
  broadcast();
}

// ===== HTTP =====
function readBody(req) {
  return new Promise(res => {
    let d = ''; req.on('data', x => { d += x; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { res({}); } });
  });
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
function json(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'GET') {
    if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PLAY_HTML); }
    if (path === '/host') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HOST_HTML); }
    if (path === '/api/info') return json(res, { url: 'http://' + lanIp() + ':' + PORT + '/' });
    if (path === '/events') {
      const host = url.searchParams.get('host') === '1';
      if (host && url.searchParams.get('key') !== HOST_KEY) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const pid = url.searchParams.get('id') || null;
      const c = { res, host, pid };
      clients.add(c);
      if (pid && G.players[pid]) G.players[pid].online = true;
      res.write('data: ' + JSON.stringify(view(c)) + '\n\n');
      broadcast();
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping); clients.delete(c);
        if (pid && G.players[pid] && ![...clients].some(x => x.pid === pid)) { G.players[pid].online = false; broadcast(); }
      });
      return;
    }
    res.writeHead(404); return res.end('Topilmadi');
  }

  if (req.method === 'POST') {
    const b = await readBody(req);
    const isHost = req.headers['x-key'] === HOST_KEY;

    if (path === '/api/join') {
      if (G.phase !== 'lobby') return json(res, { error: 'Hozir qo\'shilib bo\'lmaydi' });
      const name = String(b.name || '').trim().slice(0, 16);
      if (!name) return json(res, { error: 'Nik kiriting' });
      if (Object.values(G.players).some(p => p.name.toLowerCase() === name.toLowerCase()))
        return json(res, { error: 'Bu nik band, boshqasini tanlang' });
      const id = crypto.randomBytes(8).toString('hex');
      G.players[id] = { id, name, score: START_SCORE, online: true };
      broadcast(); return json(res, { id });
    }
    if (path === '/api/bid') {
      const p = G.players[b.id]; const inc = +b.inc;
      if (G.phase !== 'auction' || !p) return json(res, { error: 'Savdo yo\'q' });
      if (![1, 2, 3].includes(inc)) return json(res, { error: 'Faqat 1, 2 yoki 3' });
      if (G.leader === p.id) return json(res, { error: 'Siz allaqachon yetakchisiz' });
      const amount = G.bid + inc;
      if (amount > MAX_BID) return json(res, { error: 'Maksimal tikish ' + MAX_BID });
      if (amount > p.score) return json(res, { error: 'Ballingiz yetmaydi' });
      G.bid = amount; G.leader = p.id;
      if (amount >= MAX_BID) endAuction(); else { setTimer(AFTER_BID_MS, endAuction); broadcast(); }
      return json(res, { ok: true });
    }
    if (path === '/api/answer') {
      if (G.phase !== 'question' || b.id !== G.leader) return json(res, { error: 'Navbat sizda emas' });
      resolveAnswer(String(b.choice).toUpperCase()); return json(res, { ok: true });
    }

    if (!isHost) return json(res, { error: 'Ruxsat yo\'q' }, 403);
    if (path === '/api/host/load') {
      const { qs, errors } = parseTest(String(b.text || ''));
      if (errors.length) return json(res, { errors });
      clearTimeout(G.timer); G = newGame(); G.questions = qs; G.phase = 'lobby';
      broadcast(); return json(res, { ok: true, count: qs.length });
    }
    if (path === '/api/host/start') {
      if (G.phase !== 'lobby' || !Object.keys(G.players).length) return json(res, { error: 'Ishtirokchi yo\'q' });
      nextRound(); return json(res, { ok: true });
    }
    if (path === '/api/host/next') { if (G.phase === 'result') nextRound(); return json(res, { ok: true }); }
    if (path === '/api/host/reset') { clearTimeout(G.timer); G = newGame(); broadcast(); return json(res, { ok: true }); }
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log('\nServer ishga tushdi!');
  console.log('Boshqaruv (host) sahifasi: http://' + lanIp() + ':' + PORT + '/host?key=' + HOST_KEY);
  console.log('Ishtirokchilar sahifasi:   http://' + lanIp() + ':' + PORT + '/\n');
});

// ===== SAHIFALAR =====
const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Arial,sans-serif;background:#0f172a;color:#f1f5f9}
button{font:inherit;cursor:pointer;border:0;border-radius:12px;padding:14px 20px;background:#6366f1;color:#fff;font-weight:700}
button:disabled{opacity:.35;cursor:not-allowed}button.alt{background:#334155}
input,textarea{font:inherit;width:100%;padding:14px;border-radius:12px;border:2px solid #334155;background:#1e293b;color:#fff}
.card{background:#1e293b;border-radius:16px;padding:20px;margin:12px 0}
.big{font-size:2.4rem;font-weight:800}.muted{color:#94a3b8}.center{text-align:center}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #334155}
.ok{color:#4ade80}.bad{color:#f87171}.off{opacity:.45}
`;

const HOST_HTML = `<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kim oshdi - Host</title><style>${CSS}
#app{max-width:1100px;margin:0 auto;padding:24px}
.opt{font-size:1.8rem;padding:18px 22px;margin:10px 0;background:#334155;border-radius:14px}
.grid{display:grid;grid-template-columns:2fr 1fr;gap:20px}@media(max-width:800px){.grid{grid-template-columns:1fr}}
#qr{background:#fff;padding:14px;display:inline-block;border-radius:14px}
</style></head><body><div id="app"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
const key=new URLSearchParams(location.search).get('key')||'';
let S=null,deadline=0,joinUrl='',errs=[];
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json','x-key':key},body:JSON.stringify(b||{})});return r.json();}
async function init(){
  const i=await (await fetch('/api/info')).json();
  joinUrl=(['localhost','127.0.0.1'].includes(location.hostname))?i.url:location.origin+'/';
  const es=new EventSource('/events?host=1&key='+key);
  es.onmessage=e=>{S=JSON.parse(e.data);deadline=Date.now()+S.remaining;render();};
}
function board(){return '<div class="card"><b>Reyting</b>'+S.players.map((p,i)=>'<div class="row '+(p.online?'':'off')+'"><span>'+(i+1)+'. '+esc(p.name)+'</span><b>'+p.score+'</b></div>').join('')+'</div>';}
async function load(){
  const r=await post('/api/host/load',{text:$('txt').value});
  if(r.errors){errs=r.errors;render();} else errs=[];
}
function render(){
  const a=$('app');let h='';
  if(!key){a.innerHTML='<div class="card">Host havolasi bilan oching (server konsolida chiqadi: /host?key=...)</div>';return;}
  if(S.phase==='setup'){
    h='<h1>Testni yuklang</h1><div class="card"><textarea id="txt" rows="16" placeholder="1. Savol matni\\nA) variant\\nB) variant\\nC) variant\\nD) variant\\n\\n2. Ikkinchi savol\\nA) ...\\nB) ...\\n\\nJavoblar:\\n1-B\\n2-A"></textarea></div>';
    if(errs.length)h+='<div class="card bad">'+errs.map(esc).join('<br>')+'</div>';
    h+='<button onclick="load()">Yuklash</button>';
    const old=$('txt')?$('txt').value:'';a.innerHTML=h;if(old)$('txt').value=old;return;
  }
  if(S.phase==='lobby'){
    h='<div class="grid"><div class="card center"><h1>Qo\\'shiling!</h1><div id="qr"></div><p class="big" style="font-size:1.3rem;word-break:break-all">'+esc(joinUrl)+'</p><p class="muted">Savollar soni: '+S.total+'</p><button onclick="post(\\'/api/host/start\\')" '+(S.players.length?'':'disabled')+'>O\\'yinni boshlash</button> <button class="alt" onclick="post(\\'/api/host/reset\\')">Bekor qilish</button></div>'+board()+'</div>';
    a.innerHTML=h;new QRCode($('qr'),{text:joinUrl,width:300,height:300});return;
  }
  if(S.phase==='auction'){
    h='<div class="grid"><div><div class="card center"><div class="muted">Savol '+(S.idx+1)+' / '+S.total+' &mdash; KIM OSHDI SAVDOSI</div><div class="big" style="font-size:5rem">'+S.bid+' ball</div><div class="big">'+(S.leader?esc(S.leader)+' yetakchi':'Hali tikilmagan')+'</div><div class="big muted" id="tm"></div><p class="muted">Telefonlarda +1, +2 yoki +3 bosing. Maksimum '+S.maxBid+'.</p></div></div>'+board()+'</div>';
  }
  if(S.phase==='question'){
    h='<div class="grid"><div><div class="card"><div class="muted">'+esc(S.leader)+' '+S.bid+' ball tikdi &middot; telefonda javob bermoqda</div><div class="big" id="tm"></div><div class="big" style="font-size:2rem;margin:14px 0">'+esc(S.q.text)+'</div>'+S.q.options.map(o=>'<div class="opt"><b>'+o.k+')</b> '+esc(o.t)+'</div>').join('')+'</div></div>'+board()+'</div>';
  }
  if(S.phase==='result'){
    const r=S.result;
    if(r.skipped)h='<div class="card center big">Hech kim tikmadi, savol o\\'tkazib yuborildi</div>';
    else h='<div class="grid"><div><div class="card"><div class="big" style="font-size:2rem">'+esc(r.text)+'</div>'+r.options.map(o=>'<div class="opt" style="'+(o.k===r.correct?'background:#166534':(o.k===r.choice?'background:#991b1b':''))+'"><b>'+o.k+')</b> '+esc(o.t)+'</div>').join('')+'</div><div class="card center big '+(r.right?'ok':'bad')+'">'+esc(r.name)+': '+(r.choice?(r.right?'To\\'g\\'ri!':'Noto\\'g\\'ri!'):'Vaqt tugadi!')+' '+(r.delta>0?'+':'')+r.delta+' ball</div></div>'+board()+'</div>';
    h+='<p class="center"><button onclick="post(\\'/api/host/next\\')">'+(S.idx+1>=S.total?'Natijalar':'Keyingi savol')+'</button></p>';
  }
  if(S.phase==='end'){
    h='<h1 class="center">Yakuniy natijalar</h1><div class="card">'+S.players.map((p,i)=>'<div class="row"><span class="big" style="font-size:'+(i<3?'2.2':'1.4')+'rem">'+(['🥇','🥈','🥉'][i]||(i+1)+'.')+' '+esc(p.name)+'</span><b class="big" style="font-size:1.6rem">'+p.score+'</b></div>').join('')+'</div><button class="alt" onclick="post(\\'/api/host/reset\\')">Yangi o\\'yin</button>';
  }
  a.innerHTML=h;
}
setInterval(()=>{const t=$('tm');if(t)t.textContent=Math.max(0,Math.ceil((deadline-Date.now())/1000))+' s';},250);
init();
</script></body></html>`;

const PLAY_HTML = `<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kim oshdi</title><style>${CSS}
#app{max-width:480px;margin:0 auto;padding:16px}
.bidbtn{font-size:1.8rem;width:31%;padding:22px 0}
.ans{display:block;width:100%;font-size:2rem;padding:26px;margin:10px 0}
</style></head><body><div id="app"></div>
<script>
let id=localStorage.getItem('pid'),S=null,deadline=0,last='',msg='';
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json();}
function connect(){
  const es=new EventSource('/events'+(id?'?id='+id:''));
  es.onmessage=e=>{S=JSON.parse(e.data);deadline=Date.now()+S.remaining;render();};
}
async function join(){
  const r=await post('/api/join',{name:$('nick').value});
  if(r.error){$('err').textContent=r.error;return;}
  id=r.id;localStorage.setItem('pid',id);location.reload();
}
async function bid(n){const r=await post('/api/bid',{id,inc:n});if(r.error){msg=r.error;render();setTimeout(()=>{msg='';render();},1500);}}
async function answer(k){await post('/api/answer',{id,choice:k});}
function rank(){return S.players.map((p,i)=>'<div class="row '+(p.id===id?'ok':'')+'"><span>'+(i+1)+'. '+esc(p.name)+'</span><b>'+p.score+'</b></div>').join('');}
function render(){
  let h='';const me=S.me;
  if(!me){
    if(S.phase==='lobby')h='<h1>Nik tanlang</h1><input id="nick" maxlength="16" placeholder="Nikingiz"><p id="err" class="bad"></p><button style="width:100%" onclick="join()">Kirish</button>';
    else h='<div class="card center">'+(S.phase==='setup'?'Test hali yuklanmagan, kuting...':'O\\'yin allaqachon boshlangan')+'</div>';
  } else {
    h='<div class="card center"><div class="muted">'+esc(me.name)+'</div><div class="big">'+me.score+' ball</div></div>';
    if(S.phase==='lobby')h+='<div class="card center">Hammasi kirishini kuting...<br><span class="muted">Qatnashchilar: '+S.players.length+'</span></div>';
    if(S.phase==='auction'){
      h+='<div class="card center"><div class="muted">Savol '+(S.idx+1)+'/'+S.total+' savdosi</div><div class="big">'+S.bid+' ball</div><div>'+(S.leader?esc(S.leader)+' yetakchi':'Hali tikilmagan')+'</div><div class="big muted" id="tm"></div></div><div style="display:flex;justify-content:space-between">';
      for(const n of [1,2,3]){const dis=S.leaderId===id||S.bid+n>S.maxBid||S.bid+n>me.score;h+='<button class="bidbtn" '+(dis?'disabled':'')+' onclick="bid('+n+')">+'+n+'</button>';}
      h+='</div><p class="center bad">'+esc(msg)+'</p>';
    }
    if(S.phase==='question'){
      if(S.q){h+='<div class="card center"><div class="muted">Siz '+S.bid+' ball tikdingiz &middot; ekrandagi savolga javob bering</div><div class="big" id="tm"></div></div>';
        for(const o of S.q.options)h+='<button class="ans" onclick="answer(\\''+o.k+'\\')">'+o.k+'</button>';}
      else h+='<div class="card center"><b>'+esc(S.leader)+'</b> savolga javob bermoqda...<div class="big muted" id="tm"></div></div>';
    }
    if(S.phase==='result'){
      const r=S.result;
      h+=r.skipped?'<div class="card center">Hech kim tikmadi</div>':'<div class="card center big '+(r.right?'ok':'bad')+'">'+esc(r.name)+'<br>'+(r.delta>0?'+':'')+r.delta+'</div>';
    }
    if(S.phase==='end')h+='<h2 class="center">Yakuniy natija</h2>';
    h+='<div class="card">'+rank()+'</div>';
  }
  if(h!==last){$('app').innerHTML=h;last=h;}
}
setInterval(()=>{const t=$('tm');if(t)t.textContent=Math.max(0,Math.ceil((deadline-Date.now())/1000))+' s';},250);
connect();
</script></body></html>`;
