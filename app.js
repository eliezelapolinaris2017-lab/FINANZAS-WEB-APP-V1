/* =========================================================
Nexus Finance — app.js (VERSION ACTUALIZADA)
Incluye:
- Estado con retenciones (408 / SS)
- Ingresos por empleado semanal
- Nómina que crea retenciones y permite "pagar" 408/SS
- KPI: retenciones pendientes se cuentan como ingreso; al pagar se mueven a gastos
- Exportar PDF con filtros fecha/empleado
- Mantiene la mayoría de funciones originales y compatibilidad con HTML anterior
========================================================= */

/* ===================== Firebase (opcional) ===================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp, enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseConfig = {
apiKey: "AIzaSyC66vv3-yaap1mV2n1GXRUopLqccobWqRE",
authDomain: "finanzas-web-f4e05.firebaseapp.com",
projectId: "finanzas-web-f4e05",
storageBucket: "finanzas-web-f4e05.firebasestorage.app",
messagingSenderId: "1047152523619",
appId: "1:1047152523619:web:7d8f7d1f7a5ccc6090bb56"
};
let fbApp=null, auth=null, db=null;
try{
fbApp = initializeApp(firebaseConfig);
auth = getAuth(fbApp);
db = getFirestore(fbApp);
enableIndexedDbPersistence(db).catch(()=>{});
}catch(e){ console.warn('Firebase init failed', e); }

/* ===================== Estado / Utils ===================== */
const STORAGE_KEY = 'finanzas-state-v10';
const LOCK_KEY = 'finanzas-lock-v3';

const DEFAULT_STATE = {
settings: {
businessName: 'Mi Negocio',
logoBase64: '',
theme: { primary: '#0B0D10', accent: '#C7A24B', text: '#F2F3F5' },
pinHash: '',
currency: 'USD'
},
expensesDaily: [],
incomesDaily: [], // ingresos generales (incluye entradas por empleado si aplica)
incomesWeekly: [], // entradas semanales por empleado (registro opcional)
payments: [], // pagos (nómina)
ordinary: [],
budgets: [],
personal: [],
invoices: [],
quotes: [],
reconciliations: [],
retenciones: [], // array de {id, type:'408'|'SS', date, employee, amount, paid:boolean, paidDate:null, paymentId|null}
_cloud: { updatedAt: 0 }
};

const $ = (s, r=document)=> r.querySelector(s);
const $$ = (s, r=document)=> Array.from(r.querySelectorAll(s));
const clone = o => JSON.parse(JSON.stringify(o));
const todayStr = ()=> new Date().toISOString().slice(0,10);
const nowMs = ()=> Date.now();

function load(){
const raw = localStorage.getItem(STORAGE_KEY);
if(!raw){ localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_STATE)); return clone(DEFAULT_STATE); }
try{
const st = JSON.parse(raw);
for (const k of Object.keys(DEFAULT_STATE)) if(!(k in st)) st[k]=clone(DEFAULT_STATE[k]);
return st;
}catch{ return clone(DEFAULT_STATE); }
}
let state = load();

function save({skipCloud=false} = {}){
// guarda estado en localStorage
localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
applyTheme(); refreshAll();
// autosync cloud si aplica
if(!skipCloud && cloud.autosync && cloud.user){ cloudPushDebounced(); }
}

function fmt(n){
const cur = state.settings.currency || 'USD';
const val = Number(n||0);
try{ return new Intl.NumberFormat('es-PR',{style:'currency',currency:cur}).format(val); }
catch{ return `${cur} ${val.toFixed(2)}`; }
}
function toast(msg){
const c = $('#toastContainer');
if(!c){ console.log('[Toast]', msg); return; }
const t = document.createElement('div');
t.className='toast'; t.textContent=msg; c.appendChild(t);
setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(), 300); }, 2400);
}
const uid = ()=> Math.random().toString(36).slice(2,9)+Date.now().toString(36);
const toDate = s=> new Date(s);
function inRange(d, from, to){ if(!d) return false; const t=+toDate(d||'1970-01-01'); if(from && t<+toDate(from)) return false; if(to && t>(+toDate(to)+86400000-1)) return false; return true; }
const byDateDesc = (a,b)=> (+toDate(b.date||'1970-01-01')) - (+toDate(a.date||'1970-01-01'));
function ask(curr,label){ const v=prompt(label, curr??''); if(v===null) return {cancelled:true,value:curr}; return {cancelled:false,value:v}; }
function askNumber(curr,label){ const a=ask(String(curr??''),label); if(a.cancelled) return a; const n=parseFloat(String(a.value).replace(',','.')); if(Number.isNaN(n)) return {cancelled:true,value:curr}; return {cancelled:false,value:n}; }

/* ===================== Catálogos ===================== */
const EXPENSE_CATEGORIES = [
"Gasolina","Comida","Transporte","Mantenimiento","Renta/Alquiler",
"Servicios (Luz/Agua/Internet)","Insumos","Nómina","Impuestos","Herramientas",
"Publicidad/Marketing","Viajes","Papelería","Licencias y Software","Seguros",
"Equipos","Materiales","Otros"
];
const PAYMENT_METHODS = ["Efectivo","Tarjeta","Cheque","ATH Móvil","Transferencia","Salón ingreso","Otras"];

function upsertOptions(selectEl, items){
if(!selectEl) return;
const existing = new Set(Array.from(selectEl.options).map(o => (o.value||'').trim()));
items.forEach(txt=>{
if(!existing.has(txt)){
const opt = document.createElement('option');
opt.value = txt; opt.textContent = txt;
selectEl.appendChild(opt);
}
});
}
function initCatalogs(){
upsertOptions($('#expCategory'), EXPENSE_CATEGORIES);
upsertOptions($('#expMethod'), PAYMENT_METHODS);
upsertOptions($('#incMethod'), PAYMENT_METHODS);
upsertOptions($('#invMethod'), PAYMENT_METHODS);
upsertOptions($('#quoMethod'), PAYMENT_METHODS);
}

/* ===================== Tema / Router ===================== */
function applyTheme(){
const r = document.documentElement;
r.style.setProperty('--primary', state.settings.theme.primary);
r.style.setProperty('--accent', state.settings.theme.accent);
r.style.setProperty('--text', state.settings.theme.text);
$('#brandName') && ($('#brandName').textContent = state.settings.businessName || 'Mi Negocio');
const FALLBACK_LOGO = 'assets/logo.png';
['brandLogo','logoPreview'].forEach(id=>{ const el=$('#'+id); if(el) el.src = state.settings.logoBase64 || FALLBACK_LOGO; });
}
function showView(id){
$$('.view').forEach(v=>{ if(v.id!=='login') v.classList.remove('visible'); });
const t = $('#'+id) || $('#home'); if(t && t.id!=='login') t.classList.add('visible');
$$('.nav-btn').forEach(b=> b.classList.toggle('active', b.dataset.target===id));
window.scrollTo({top:0, behavior:'smooth'});
}

/* ===================== Login robusto (refresh/bfcache) ===================== */
const MAX_ATTEMPTS = 5;
const attempts = () => Number(localStorage.getItem(LOCK_KEY)||0);
const setAttempts = n => localStorage.setItem(LOCK_KEY, String(n));
const attemptsLeft = () => Math.max(0, MAX_ATTEMPTS - attempts());

async function sha256(msg){
const enc = new TextEncoder().encode(msg);
const buf = await crypto.subtle.digest('SHA-256', enc);
return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function hardHideOverlays(){
document.body.classList.remove('modal-open','locked','dimmed');
['#scrim','.overlay','.backdrop'].forEach(sel=>{
const el = document.querySelector(sel);
if(el){ el.remove(); }
});
}
function forceShowLogin(){
$$('.view.visible').forEach(v=> v.classList.remove('visible'));
const box = $('#login'); if(!box) return;
box.style.display='block'; box.classList.add('visible'); box.removeAttribute('aria-hidden');
document.body.classList.add('modal-open'); hardHideOverlays();
}
function closeLogin(){
const box = $('#login'); if(!box) return;
box.classList.remove('visible'); box.style.display='none'; box.setAttribute('aria-hidden','true');
hardHideOverlays();
}

async function handleLogin(ev){
if(ev) ev.preventDefault();
const createMode = !state.settings.pinHash;
const pinEl = $('#loginPIN');
const pin2El = $('#loginPIN2');
const pin = (pinEl?.value || '').trim();
const pin2 = (pin2El?.value || '').trim();
if(!pin){ toast('Introduce tu PIN'); pinEl?.focus(); return; }

if(createMode){
if(pin.length<4 || pin.length>8){ toast('El PIN debe tener entre 4 y 8 dígitos'); return; }
if(pin!==pin2){ toast('Los PIN no coinciden'); return; }
state.settings.pinHash = await sha256(pin);
save();
toast('PIN creado correctamente'); closeLogin(); showView('home'); return;
}

if(attempts()>=MAX_ATTEMPTS){ toast('Has alcanzado el máximo de intentos'); return; }
const ok = (await sha256(pin)) === state.settings.pinHash;
if(ok){ setAttempts(0); toast('Bienvenido'); closeLogin(); showView('home'); }
else { setAttempts(attempts()+1); updateLoginUI(); toast(`PIN incorrecto. Intentos restantes: ${attemptsLeft()}`); }
}

function updateLoginUI(){
const createMode = !state.settings.pinHash;
$('#loginTitle') && ($('#loginTitle').textContent = createMode ? 'Crear PIN' : 'Ingresar PIN');
$('#loginHint') && ($('#loginHint').textContent = createMode ? 'Crea un PIN de 4–8 dígitos.' : 'Introduce tu PIN.');
const pin2Wrap = $('#loginPIN2Wrap') || $('#loginPIN2')?.parentElement;
if(pin2Wrap && pin2Wrap instanceof HTMLElement) pin2Wrap.style.display = createMode ? 'block' : 'none';
const left = attemptsLeft();
$('#loginAttempts') && ($('#loginAttempts').textContent = createMode ? '' : `Intentos restantes: ${left}`);
if($('#loginBtn') && !$('#loginBtn')._bound){ $('#loginBtn').addEventListener('click', handleLogin); $('#loginBtn')._bound=true; }
if($('#loginForm') && !$('#loginForm')._bound){ $('#loginForm').addEventListener('submit', handleLogin); $('#loginForm')._bound=true; }
const pinEl = $('#loginPIN');
if(pinEl && !pinEl._bound){ pinEl.addEventListener('keydown', e=>{ if(e.key==='Enter') handleLogin(e); }); pinEl._bound = true; }
if(pinEl){ pinEl.value=''; pinEl.focus(); }
requestAnimationFrame(()=>{ forceShowLogin(); });
}
window.resetPIN = async function(){
if(confirm('¿Borrar el PIN guardado y crear uno nuevo?')){
state.settings.pinHash = ''; localStorage.removeItem(LOCK_KEY); save(); toast('PIN eliminado. Crea uno nuevo.'); updateLoginUI();
}
};

/* ===================== Gastos Diarios ===================== */
function renderExpenses(){
const tbody = $('#expensesTable tbody'); if(!tbody) return; tbody.innerHTML='';
const from = $('#fExpFrom')?.value, to = $('#fExpTo')?.value; let total=0; const cats={};
state.expensesDaily.filter(e=>inRange(e.date, from, to)).sort(byDateDesc).forEach(e=>{
const tr=document.createElement('tr');
tr.innerHTML = `
<td>${e.date||''}</td><td>${e.category||''}</td><td>${e.desc||''}</td>
<td>${e.method||''}</td><td>${e.ref||''}</td><td>${fmt(e.amount)}</td><td>${e.note||''}</td>
<td class="row-actions">
<button class="btn-outline" data-edit="${e.id}">Editar</button>
<button class="btn-outline" data-del="${e.id}">Eliminar</button>
</td>`;
tbody.appendChild(tr);
total+=Number(e.amount||0);
cats[e.category]=(cats[e.category]||0)+Number(e.amount||0);
});
$('#expSumTotal') && ($('#expSumTotal').textContent = fmt(total));
const pills = $('#expSumPills');
if(pills){ pills.innerHTML=''; Object.entries(cats).forEach(([k,v])=>{ const s=document.createElement('span'); s.textContent=`${k}: ${fmt(v)}`; pills.appendChild(s); }); }
$$('#expensesTable [data-del]').forEach(b=> b.onclick=()=>{ state.expensesDaily = state.expensesDaily.filter(x=>x.id!==b.dataset.del); save(); toast('Gasto eliminado'); });
$$('#expensesTable [data-edit]').forEach(b=> b.onclick=()=> editExpense(b.dataset.edit));
}
function editExpense(id){
const i=state.expensesDaily.findIndex(x=>x.id===id); if(i<0) return;
const e=state.expensesDaily[i];
let r=ask(e.date,'Fecha (YYYY-MM-DD)'); if(r.cancelled) return; e.date=r.value||e.date;
r=ask(e.category,'Categoría'); if(r.cancelled) return; e.category=r.value||e.category;
r=ask(e.desc,'Descripción'); if(r.cancelled) return; e.desc=r.value||e.desc;
r=ask(e.method,'Método'); if(r.cancelled) return; e.method=r.value||e.method;
r=askNumber(e.amount,'Monto'); if(r.cancelled) return; e.amount=r.value;
r=ask(e.note,'Nota'); if(r.cancelled) return; e.note=r.value||e.note;
save(); toast('Gasto actualizado');
}
function wireExpenses(){
$('#expenseForm')?.addEventListener('submit',(ev)=>{
ev.preventDefault();
const rec={ id:uid(), date:$('#expDate')?.value, category:$('#expCategory')?.value, desc:$('#expDesc')?.value, amount:Number($('#expAmount')?.value||0), method:$('#expMethod')?.value||'', note:$('#expNote')?.value, ref:$('#expRef')?.value||'' };
if(!rec.date) return toast('Fecha requerida');
state.expensesDaily.push(rec); save(); toast('Gasto guardado'); ev.target.reset();
});
$('#fExpApply')?.addEventListener('click', renderExpenses);
$('#addExpense')?.addEventListener('click', ()=>{ if($('#expDate')) $('#expDate').value=todayStr(); $('#expAmount')?.focus(); });
}

/* ===================== Ingresos ===================== */
function renderIncomes(){
const tbody=$('#incomesTable tbody'); if(!tbody) return; tbody.innerHTML='';
const from=$('#fIncFrom')?.value, to=$('#fIncTo')?.value; const filterEmp = ($('#fIncEmployee')?.value||'').toLowerCase();
let total=0;
const totalsByMethod = { 'Efectivo':0,'Tarjeta':0,'Cheque':0,'ATH Móvil':0,'Transferencia':0,'Salón ingreso':0,'Otras':0 };

state.incomesDaily.filter(r=>inRange(r.date, from, to) && (!filterEmp || (r.client||'').toLowerCase().includes(filterEmp))).sort(byDateDesc).forEach(r=>{
const tr=document.createElement('tr');
tr.innerHTML = `
<td>${r.date||''}</td><td>${r.client||''}</td><td>${r.method||''}</td><td>${r.ref||''}</td>
<td>${fmt(r.amount)}</td>
<td class="row-actions">
<button class="btn-outline" data-edit="${r.id}">Editar</button>
<button class="btn-outline" data-del="${r.id}">Eliminar</button>
</td>`;
tbody.appendChild(tr); total+=Number(r.amount||0);
if (totalsByMethod[r.method] !== undefined) totalsByMethod[r.method]+=Number(r.amount||0);
});
$('#incSumTotal') && ($('#incSumTotal').textContent = fmt(total));
const methodWrap = $('#incSumMethods');
if (methodWrap){
methodWrap.innerHTML='';
Object.entries(totalsByMethod).forEach(([method, value])=>{
const div=document.createElement('span'); div.className='pill'; div.textContent=`${method}: ${fmt(value)}`; methodWrap.appendChild(div);
});
}
$$('#incomesTable [data-del]').forEach(b=> b.onclick=()=>{ state.incomesDaily = state.incomesDaily.filter(x=>x.id!==b.dataset.del); save(); toast('Ingreso eliminado'); });
$$('#incomesTable [data-edit]').forEach(b=> b.onclick=()=> editIncome(b.dataset.edit));
}
function editIncome(id){
const i=state.incomesDaily.findIndex(x=>x.id===id); if(i<0) return;
const r0=state.incomesDaily[i];
let r=ask(r0.date,'Fecha (YYYY-MM-DD)'); if(r.cancelled) return; r0.date=r.value||r0.date;
r=ask(r0.client,'Cliente/Origen'); if(r.cancelled) return; r0.client=r.value||r0.client;
r=ask(r0.method,'Método'); if(r.cancelled) return; r0.method=r.value||r0.method;
r=askNumber(r0.amount,'Monto'); if(r.cancelled) return; r0.amount=r.value;
save(); toast('Ingreso actualizado');
}
function wireIncomes(){
$('#incomeForm')?.addEventListener('submit',(ev)=>{
ev.preventDefault();
const rec={ id:uid(), date:$('#incDate')?.value, client:$('#incEmployee')?.value||$('#incClient')?.value, method:$('#incMethod')?.value, amount:Number($('#incAmount')?.value||0), ref:$('#incRef')?.value||'' };
if(!rec.date) return toast('Fecha requerida');
// Guardar entrada semanal/income
state.incomesDaily.push(rec);
// También opcional: mantener registro weekly
state.incomesWeekly.push({ id:uid(), date:rec.date, employee:rec.client, gross:rec.amount });
save(); toast('Ingreso guardado'); ev.target.reset();
});
$('#fIncApply')?.addEventListener('click', renderIncomes);
$('#addIncome')?.addEventListener('click', ()=>{ if($('#incDate')) $('#incDate').value=todayStr(); $('#incAmount')?.focus(); });
}

/* ===================== Nómina / Retenciones ===================== */
function payrollComputeNet() {
const g = parseFloat($('#payGross')?.value || '0') || 0;
const isr= parseFloat($('#payRetISR')?.value || '0') || 0;
const ss = parseFloat($('#payRetSS')?.value || '0') || 0;
const ot = parseFloat($('#payRetOther')?.value || '0') || 0;
const net = g - (isr + ss + ot);
if ($('#payAmount')) $('#payAmount').value = (net >= 0 ? net : 0).toFixed(2);
return net >= 0 ? net : 0;
}
function payrollBindRetentionInputs() {
['payGross','payRetISR','payRetSS','payRetOther'].forEach(id => {
const el = $('#'+id);
if (el && !el._retBound) {
el.addEventListener('input', payrollComputeNet);
el._retBound = true;
}
});
payrollComputeNet();
}

function createRetention(type, date, employee, amount, paymentId=null){
if(!amount || Number(amount)===0) return null;
const rec = { id: uid(), type: type, date: date||todayStr(), employee: employee||'', amount: Number(amount||0), paid:false, paidDate:null, paymentId: paymentId||null };
state.retenciones.push(rec);
return rec;
}

function renderPayments(){
const tbody=$('#paymentsTable tbody'); if(!tbody) return; tbody.innerHTML='';
const totals={Pendiente:0,Pagado:0};
state.payments.slice().sort(byDateDesc).forEach(p=>{
const breakdown = [
(p.gross!=null ? `Bruto: ${fmt(p.gross)}` : null),
(p.retISR!=null ? `ISR: ${fmt(p.retISR)}` : null),
(p.retSS!=null ? `SS: ${fmt(p.retSS)}` : null),
(p.retOther!=null ? `Otras: ${fmt(p.retOther)}` : null),
(p.amount!=null ? `Neto: ${fmt(p.amount)}` : null),
].filter(Boolean).join(' · ');
const tr=document.createElement('tr');
tr.innerHTML = `
<td>${p.date||''}</td>
<td>${p.to||''}</td>
<td>${p.category||''}</td>
<td title="${breakdown}">${fmt(p.amount)}</td>
<td>${p.status}</td>
<td class="row-actions">
<button class="btn-outline" data-edit="${p.id}">Editar</button>
<button class="btn-outline" data-del="${p.id}">Eliminar</button>
</td>`;
tbody.appendChild(tr);
totals[p.status]=(totals[p.status]||0)+Number(p.amount||0);
});
$('#payrollTotal') && ($('#payrollTotal').textContent = fmt(state.payments.reduce((a,p)=>a+Number(p.amount||0),0)));
$('#payrollPaid') && ($('#payrollPaid').textContent = fmt(state.payments.filter(p=>p.status==='Pagado').reduce((a,p)=>a+Number(p.amount||0),0)));
$('#payrollPending') && ($('#payrollPending').textContent = fmt(state.payments.filter(p=>p.status!=='Pagado').reduce((a,p)=>a+Number(p.amount||0),0)));
$$('#paymentsTable [data-del]').forEach(b=> b.onclick=()=>{ state.payments = state.payments.filter(x=>x.id!==b.dataset.del); save(); toast('Pago eliminado'); });
$$('#paymentsTable [data-edit]').forEach(b=> b.onclick=()=> editPayment(b.dataset.edit));
}
function editPayment(id){
const i=state.payments.findIndex(x=>x.id===id); if(i<0) return;
const p=state.payments[i];
let r=ask(p.date,'Fecha (YYYY-MM-DD)'); if(r.cancelled) return; p.date=r.value||p.date;
r=ask(p.to,'Empleado/Beneficiario'); if(r.cancelled) return; p.to=r.value||p.to;
r=ask(p.category,'Categoría'); if(r.cancelled) return; p.category=r.value||p.category;
r=askNumber(p.gross ?? p.amount,'Monto bruto'); if(r.cancelled) return; p.gross=r.value;
r=askNumber(p.retISR ?? 0,'ISR'); if(r.cancelled) return; p.retISR=r.value;
r=askNumber(p.retSS ?? 0,'Seguro Social'); if(r.cancelled) return; p.retSS=r.value;
r=askNumber(p.retOther ?? 0,'Otras deducciones'); if(r.cancelled) return; p.retOther=r.value;
const net = (Number(p.gross||0) - Number(p.retISR||0) - Number(p.retSS||0) - Number(p.retOther||0));
p.amount = (net>=0?net:0);
r=ask(p.status,'Estado (Pendiente/Pagado)'); if(r.cancelled) return; p.status=r.value||p.status;
save(); toast('Pago actualizado');
}
function wirePayments(){
payrollBindRetentionInputs();
$('#paymentForm')?.addEventListener('submit',(ev)=>{
ev.preventDefault();
const net = payrollComputeNet();
const rec={
id:uid(),
date: $('#payDate')?.value,
to: $('#payTo')?.value,
category: $('#payCategory')?.value,
gross: parseFloat($('#payGross')?.value||'0')||0,
retISR: parseFloat($('#payRetISR')?.value||'0')||0,
retSS: parseFloat($('#payRetSS')?.value||'0')||0,
retOther: parseFloat($('#payRetOther')?.value||'0')||0,
amount: net,
status: $('#payStatus')?.value || 'Pendiente'
};
if(!rec.date) return toast('Fecha requerida');
// 1) Guardar pago
state.payments.push(rec);
// 2) Registrar retenciones asociadas (si > 0)
const r1 = createRetention('408', rec.date, rec.to, rec.retISR, rec.id);
const r2 = createRetention('SS', rec.date, rec.to, rec.retSS, rec.id);
// 3) Opcional: según tu regla, el bruto se suma como ingreso — guardamos un ingreso con método "Salón ingreso"
if(rec.gross && rec.gross>0){
const inc = { id: uid(), date: rec.date, client: rec.to, method: 'Salón ingreso', amount: Number(rec.gross||0), ref: `pago:${rec.id}` };
state.incomesDaily.push(inc);
}
// 4) Salva y limpia form
save(); toast('Pago guardado (y retenciones registradas)'); ev.target.reset(); payrollBindRetentionInputs();
});
$('#addPayment')?.addEventListener('click', ()=>{ if($('#payDate')) $('#payDate').value=todayStr(); payrollComputeNet(); });

// Delegación: botones "Pagar 408" / "Pagar SS" en la lista de retenciones (se definen en renderRetenciones)
}

/* ===================== Retenciones (render / acciones) ===================== */
function renderRetenciones(){
const tbody=$('#retencionesTable tbody'); if(!tbody) return; tbody.innerHTML='';
const from=$('#fRetFrom')?.value, to=$('#fRetTo')?.value, emp = ($('#fRetEmployee')?.value||'').toLowerCase();
state.retenciones.slice().sort(byDateDesc).filter(r=>inRange(r.date, from, to) && (!emp || (r.employee||'').toLowerCase().includes(emp))).forEach(r=>{
// Buscamos el pago asociado para mostrar bruto/Salon45 y neto si existe
const pay = r.paymentId ? state.payments.find(p=>p.id===r.paymentId) : null;
const bruto = pay ? (pay.gross||0) : 0;
const salon45 = bruto * 0.45;
const ret408 = r.type==='408' ? r.amount : 0;
const retSS = r.type==='SS' ? r.amount : 0;
const neto = pay ? (pay.amount||0) : 0;
// Encontrar si hay otra retención gemela (ej. 408/SS del mismo pago) para mostrar columnas
const tr = document.createElement('tr');
tr.innerHTML = `
<td>${r.date}</td>
<td>${r.employee||''}</td>
<td>${fmt(bruto)}</td>
<td>${fmt(salon45)}</td>
<td>${r.type==='408'?fmt(r.amount):'—'}</td>
<td>${r.type==='408'? (r.paid?fmt(r.amount):'—') : '—'}</td>
<td>${r.type==='SS'?fmt(r.amount):'—'}</td>
<td>${r.type==='SS'? (r.paid?fmt(r.amount):'—') : '—'}</td>
<td>${fmt(neto)}</td>
<td class="row-actions">
${!r.paid ? `<button class="btn-outline" data-pay-ret="${r.id}">Pagar ${r.type}</button>` : `<button class="btn-outline" data-unpay-ret="${r.id}">Desmarcar</button>`}
</td>`;
tbody.appendChild(tr);
});
// Totales
const sumPending408 = state.retenciones.filter(r=>r.type==='408' && !r.paid).reduce((a,b)=>a+Number(b.amount||0),0);
const sumPaid408 = state.retenciones.filter(r=>r.type==='408' && r.paid).reduce((a,b)=>a+Number(b.amount||0),0);
const sumPendingSS = state.retenciones.filter(r=>r.type==='SS' && !r.paid).reduce((a,b)=>a+Number(b.amount||0),0);
const sumPaidSS = state.retenciones.filter(r=>r.type==='SS' && r.paid).reduce((a,b)=>a+Number(b.amount||0),0);
$('#ret408Pending') && ($('#ret408Pending').textContent = fmt(sumPending408));
$('#ret408Paid') && ($('#ret408Paid').textContent = fmt(sumPaid408));
$('#retSSPending') && ($('#retSSPending').textContent = fmt(sumPendingSS));
$('#retSSPaid') && ($('#retSSPaid').textContent = fmt(sumPaidSS));

// Delegación de pago de retención
$$('#retencionesTable [data-pay-ret]').forEach(b=> b.onclick=()=> { markRetentionPaid(b.dataset.payRet); });
$$('#retencionesTable [data-unpay-ret]').forEach(b=> b.onclick=()=> { markRetentionUnpaid(b.dataset.unpayRet); });
}

function markRetentionPaid(id){
const i = state.retenciones.findIndex(r=>r.id===id); if(i<0) return; state.retenciones[i].paid = true; state.retenciones[i].paidDate = todayStr();
// cuando se paga una retención, la consideramos gasto: si existe paymentId, podríamos reflejarlo
save(); toast(`Retención ${state.retenciones[i].type} marcada como PAGADA`); renderRetenciones(); refreshAll();
}
function markRetentionUnpaid(id){
const i = state.retenciones.findIndex(r=>r.id===id); if(i<0) return; state.retenciones[i].paid = false; state.retenciones[i].paidDate = null;
save(); toast(`Retención ${state.retenciones[i].type} desmarcada`); renderRetenciones(); refreshAll();
}

/* ===================== Ordinarios / Presupuestos / Personales ===================== */
/* (mantengo similares a tu versión previa; no las toco salvo que me pidas) */
function renderOrdinary(){
const tb=$('#ordinaryTable tbody'); if(!tb) return; tb.innerHTML='';
state.ordinary.forEach(o=>{
const tr=document.createElement('tr');
tr.innerHTML=`
<td>${o.name}</td>
<td>${fmt(o.amount)}</td>
<td>${o.freq}</td>
<td>${o.next}</td>
<td class="row-actions">
<button class="btn-outline" data-edit="${o.id}">Editar</button>
<button class="btn-outline" data-del="${o.id}">Eliminar</button>
</td>`;
tb.appendChild(tr);
});
$('#ordSumCount')&&($('#ordSumCount').textContent=state.ordinary.length.toString());
const next=state.ordinary.map(o=>o.next).filter(Boolean).sort()[0]||'—';
$('#ordSumNext')&&($('#ordSumNext').textContent=next);
$$('#ordinaryTable [data-del]').forEach(b=> b.onclick=()=>{ state.ordinary=state.ordinary.filter(x=>x.id!==b.dataset.del); save(); toast('Recurrente eliminado'); });
$$('#ordinaryTable [data-edit]').forEach(b=> b.onclick=()=> editOrdinary(b.dataset.edit));
}
function editOrdinary(id){
const i=state.ordinary.findIndex(x=>x.id===id); if(i<0) return;
const o=state.ordinary[i];
let r=ask(o.name,'Nombre'); if(r.cancelled) return; o.name=r.value||o.name;
r=askNumber(o.amount,'Monto'); if(r.cancelled) return; o.amount=r.value;
r=ask(o.freq,'Frecuencia'); if(r.cancelled) return; o.freq=r.value||o.freq;
r=ask(o.next,'Próxima fecha'); if(r.cancelled) return; o.next=r.value||o.next;
save(); toast('Recurrente actualizado');
}
function wireOrdinary(){
$('#ordinaryForm')?.addEventListener('submit',(ev)=>{
ev.preventDefault();
const rec={ id:uid(), name:$('#ordName')?.value, amount:Number($('#ordAmount')?.value||0), freq:$('#ordFreq')?.value, next:$('#ordNext')?.value };
if(!rec.next) return toast('Próxima fecha requerida');
state.ordinary.push(rec); save(); toast('Recurrente guardado'); ev.target.reset();
});
$('#addOrd')?.addEventListener('click', ()=>{ if($('#ordNext')) $('#ordNext').value=todayStr(); $('#ordAmount')?.focus(); });
}

function spendByCategory(cat){ return state.expensesDaily.filter(e=>e.category===cat).reduce((a,b)=>a+Number(b.amount||0),0); }
function renderBudgets(){
const wrap=$('#budgetBars'); if(!wrap) return; wrap.innerHTML='';
state.budgets.forEach(b=>{
const used=spendByCategory(b.category);
const pct=b.limit>0?Math.min(100,Math.round(100*used/b.limit)):0;
const div=document.createElement('div');
div.className='budget-bar'+(used>b.limit?' over':'');
div.innerHTML=`
<div class="label"><strong>${b.category}</strong> <span>${fmt(used)} / ${fmt(b.limit)} (${pct}%)</span></div>
<div class="bar"><span style="width:${pct}%"></span></div>
<div class="row g" style="margin-top:6px;">
<button class="btn-outline" data-edit="${b.id}">Editar</button>
<button class="btn-outline" data-del="${b.id}">Eliminar</button>
</div>`;
wrap.appendChild(div);
});
$$('#budgetBars [data-del]').forEach(b=> b.onclick=()=>{ state.budgets=state.budgets.filter(x=>x.id!==b.dataset.del); save(); toast('Presupuesto eliminado'); });
$$('#budgetBars [data-edit]').forEach(b=> b.onclick=()=> editBudget(b.dataset.edit));
}
function editBudget(id){
const i=state.budgets.findIndex(x=>x.id===id); if(i<0) return;
const b=state.budgets[i];
let r=ask(b.category,'Categoría'); if(r.cancelled) return; b.category=r.value||b.category;
r=askNumber(b.limit,'Límite'); if(r.cancelled) return; b.limit=r.value;
save(); toast('Presupuesto actualizado');
}
function wireBudgets(){
$('#budgetForm')?.addEventListener('submit',(ev)=>{
ev.preventDefault();
const rec={ id:uid(), category:$('#budCategory')?.value, limit:Number($('#budLimit')?.value||0) };
state.budgets.push(rec); save(); toast('Presupuesto guardado'); ev.target.reset();
});
$('#addBudget')?.addEventListener('click', (e)=>{ e.preventDefault(); $('#budCategory')?.focus(); });
}

function renderPersonal(){
const tb=$('#personalTable tbody'); if(!tb) return; tb.innerHTML='';
let total=0;
state.personal.slice().sort(byDateDesc).forEach(p=>{
const tr=document.createElement('tr');
tr.innerHTML=`
<td>${p.date||''}</td>
<td>${p.category||''}</td>
<td>${p.desc||''}</td>
<td>${fmt(p.amount)}</td>
<td class="row-actions">
<button class="btn-outline" data-edit="${p.id}">Editar</button>
<button class="btn-outline" data-del="${p.id}">Eliminar</button>
</td>`;
tb.appendChild(tr); total+=Number(p.amount||0);
});
$('#perSumTotal')&&($('#perSumTotal').textContent=fmt(total));
$$('#personalTable [data-del]').forEach(b=> b.onclick=()=>{ state.personal=state.personal.filter(x=>x.id!==b.dataset.del); save(); toast('Gasto personal eliminado'); });
$$('#personalTable [data-edit]').forEach(b=> b.onclick=()=> editPersonal(b.dataset.edit));
}
function editPersonal(id){
const i=state.personal.findIndex(x=>x.id===id); if(i<0) return;
const p=state.personal[i];
let r=ask(p.date,'Fecha'); if(r.cancelled) return; p.date=r.value||p.date;
r=ask(p.category,'Categoría'); if(r.cancelled) return; p.category=r.value||p.category;
r=ask(p.desc,'Descripción'); if(r.cancelled) return; p.desc=r.value||p.desc;
r=askNumber(p.amount,'Monto'); if(r.cancelled) return; p.amount=r.value;
save(); toast('Gasto personal actualizado');
}
function wirePersonal(){
$('#personalForm')?.addEventListener('submit',(ev)=>{
ev.preventDefault();
const rec={ id:uid(), date:$('#perDate')?.value, category:$('#perCategory')?.value, desc:$('#perDesc')?.value, amount:Number($('#perAmount')?.value||0) };
if(!rec.date) return toast('Fecha requerida');
state.personal.push(rec); save(); toast('Gasto personal guardado'); ev.target.reset();
});
$('#addPersonal')?.addEventListener('click', ()=>{ if($('#perDate')) $('#perDate').value=todayStr(); $('#perAmount')?.focus(); });
}

/* ===================== Facturación / Cotizaciones / Historial ===================== */
/* (mantengo funciones principales; no las altero en este cambio salvo que indiques) */

function uidItem(){ return Math.random().toString(36).slice(2,7); }
function addItemRow(tbody){
const tr=document.createElement('tr');
tr.innerHTML = `
<td><input type="text" placeholder="Descripción"></td>
<td><input type="number" step="0.01" value="1"></td>
<td><input type="number" step="0.01" value="0"></td>
<td><input type="number" step="0.01" value="0"></td>
<td class="amount-cell">0.00</td>
<td><button type="button" class="btn-outline btnDelRow">✕</button></td>`;
tbody.appendChild(tr);
tr.querySelector('.btnDelRow').onclick=()=> tr.remove();
}
function readItemsFromTable(tbody){
const items=[];
tbody.querySelectorAll('tr').forEach(tr=>{
const [desc, qty, price, tax] = Array.from(tr.querySelectorAll('input')).map(i=>i.value);
const q=parseFloat(qty||'0')||0, p=parseFloat(price||'0')||0, t=parseFloat(tax||'0')||0;
items.push({ id:uidItem(), desc:(desc||'').trim(), qty:q, price:p, tax:t });
});
return items;
}
function calcTotals(items){
let subtotal=0,taxTotal=0;
items.forEach(it=>{
const base=(it.qty||0)*(it.price||0);
const tax=base*((it.tax||0)/100);
subtotal+=base; taxTotal+=tax;
});
return { subtotal, taxTotal, total: subtotal+taxTotal };
}
function paintRowAmounts(tbody){
tbody.querySelectorAll('tr').forEach(tr=>{
const [desc, qty, price, tax] = Array.from(tr.querySelectorAll('input')).map(i=>i.value);
const q=parseFloat(qty||'0')||0, p=parseFloat(price||'0')||0, t=parseFloat(tax||'0')||0;
const base=q*p, taxAmt=base*(t/100), amt=base+taxAmt;
tr.querySelector('.amount-cell').textContent = amt.toFixed(2);
});
}

/* ===================== Reportes / Home (KPIs) ===================== */
function sumRange(list, from, to){ if(!Array.isArray(list)) return 0; return list.filter(r=>inRange(r.date, from, to)).reduce((a,b)=>a+Number(b.amount||0),0); }
function sumExpensesDailySplit(from, to){
let recurrent=0, nonRec=0;
const isRec=e=>(e.method==='Automático'||(e.desc||'').toLowerCase().startsWith('recurrente'));
state.expensesDaily.filter(e=>inRange(e.date, from, to)).forEach(e=>{
const amt=Number(e.amount||0); if(isRec(e)) recurrent+=amt; else nonRec+=amt;
});
return { total: recurrent + nonRec, recurrent, nonRecurrent: nonRec };
}
function sumPaymentsRange(from, to){ return state.payments.filter(p=>inRange(p.date,from,to)).reduce((a,b)=>a+Number(b.amount||0),0); }
function sumPersonalRange(from, to){ return state.personal.filter(p=>inRange(p.date,from,to)).reduce((a,b)=>a+Number(b.amount||0),0); }

function sumRetencionesPending(from,to){
return state.retenciones.filter(r=>!r.paid && inRange(r.date, from, to)).reduce((a,b)=>a+Number(b.amount||0),0);
}
function sumRetencionesPaid(from,to){
return state.retenciones.filter(r=>r.paid && inRange(r.paidDate||r.date, from, to)).reduce((a,b)=>a+Number(b.amount||0),0);
}

function renderReports(){
const now=new Date(); const today=now.toISOString().slice(0,10);
const monthStart=new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
const yearStart=new Date(now.getFullYear(), 0, 1).toISOString().slice(0,10);
const weekStart=(()=>{ const x=new Date(now); const day=x.getDay()||7; x.setDate(x.getDate()-day+1); x.setHours(0,0,0,0); return x.toISOString().slice(0,10); })();

const incToday=sumRange(state.incomesDaily, today, today) + sumRetencionesPending(today,today);
const incWeek=sumRange(state.incomesDaily, weekStart, today) + sumRetencionesPending(weekStart,today);
const incMonth=sumRange(state.incomesDaily, monthStart, today) + sumRetencionesPending(monthStart,today);
const incYear=sumRange(state.incomesDaily, yearStart, today) + sumRetencionesPending(yearStart,today);

const expToday=sumExpensesDailySplit(today,today).total + sumPersonalRange(today,today) + sumPaymentsRange(today,today) + sumRetencionesPaid(today,today);
const expWeek=sumExpensesDailySplit(weekStart,today).total + sumPersonalRange(weekStart,today) + sumPaymentsRange(weekStart,today) + sumRetencionesPaid(weekStart,today);
const expMonth=sumExpensesDailySplit(monthStart,today).total + sumPersonalRange(monthStart,today) + sumPaymentsRange(monthStart,today) + sumRetencionesPaid(monthStart,today);
const expYear=sumExpensesDailySplit(yearStart,today).total + sumPersonalRange(yearStart,today) + sumPaymentsRange(yearStart,today) + sumRetencionesPaid(yearStart,today);

$('#rToday') && ($('#rToday').textContent = `${fmt(incToday)} / ${fmt(expToday)}`);
$('#rWeek') && ($('#rWeek').textContent = `${fmt(incWeek)} / ${fmt(expWeek)}`);
$('#rMonth') && ($('#rMonth').textContent = `${fmt(incMonth)} / ${fmt(expMonth)}`);
$('#rYear') && ($('#rYear').textContent = `${fmt(incYear)} / ${fmt(expYear)}`);
}

function renderHome(){
const now=new Date();
const monthStart=new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
const today=now.toISOString().slice(0,10);
const incMonth=sumRange(state.incomesDaily, monthStart, today) + sumRetencionesPending(monthStart,today);
const expSplit=sumExpensesDailySplit(monthStart, today);
const perMonth=sumPersonalRange(monthStart,today);
const payMonth=sumPaymentsRange(monthStart,today);
const retPaid = sumRetencionesPaid(monthStart,today);
const totalExp=expSplit.total+perMonth+payMonth+retPaid;
const balance=incMonth-totalExp;
$('#kpiIncomesMonth') && ($('#kpiIncomesMonth').textContent=fmt(incMonth));
$('#kpiExpensesMonth') && ($('#kpiExpensesMonth').textContent=fmt(totalExp));
$('#kpiBalanceMonth') && ($('#kpiBalanceMonth').textContent=fmt(balance));

const c=$('#chart12'); if(!c) return; const ctx=c.getContext('2d');
c.width=c.clientWidth; c.height=180; ctx.clearRect(0,0,c.width,c.height);
const months=[], inc=[], exp=[];
for(let i=11;i>=0;i--){
const d=new Date(now.getFullYear(),now.getMonth()-i,1);
const from=new Date(d.getFullYear(),d.getMonth(),1).toISOString().slice(0,10);
const to=new Date(d.getFullYear(),d.getMonth()+1,0).toISOString().slice(0,10);
months.push(d.toLocaleDateString('es-ES',{month:'short'}));
const incM=sumRange(state.incomesDaily, from, to) + sumRetencionesPending(from,to);
const expSplitM=sumExpensesDailySplit(from, to);
const perM=sumPersonalRange(from,to), payM=sumPaymentsRange(from,to);
exp.push(expSplitM.total+perM+payM+sumRetencionesPaid(from,to)); inc.push(incM);
}
const max=Math.max(...inc,...exp,1); const barW=Math.floor((c.width-40)/(months.length*2));
months.forEach((m,idx)=>{
const x=idx*(barW*2)+20;
const hI=Math.round((inc[idx]/max)*(c.height-30));
const hE=Math.round((exp[idx]/max)*(c.height-30));
ctx.fillStyle=state.settings.theme.accent || '#C7A24B'; ctx.fillRect(x,c.height-10-hI,barW,hI);
ctx.fillStyle='#555'; ctx.fillRect(x+barW+4,c.height-10-hE,barW,hE);
ctx.fillStyle='#aaa'; ctx.font='12px system-ui'; ctx.fillText(m,x,c.height-2);
});
}

/* ===================== Exportar/Importar JSON ===================== */
function exportJSON(){
const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='finanzas-backup.json'; a.click(); URL.revokeObjectURL(a.href);
toast('JSON exportado');
}
function importJSON(file){
const reader=new FileReader();
reader.onload=()=>{
try{
const incoming=JSON.parse(reader.result);
if(confirm('¿Reemplazar TODO con el archivo? (Cancelar = fusionar)')){
state=incoming; save(); toast('Datos reemplazados'); location.reload();
}else{
state.settings=Object.assign({},state.settings,incoming.settings||{});
['expensesDaily','incomesDaily','payments','ordinary','budgets','personal','invoices','quotes','reconciliations','retenciones'].forEach(k=>{
if(Array.isArray(incoming[k])) state[k]=state[k].concat(incoming[k]);
});
save(); toast('Datos fusionados'); location.reload();
}
}catch{ toast('Archivo inválido'); }
};
reader.readAsText(file);
}

/* ===================== PDF (jsPDF B/N) con filtros ===================== */
let jsPDFReady=false;
async function ensureJsPDF(){
if(jsPDFReady) return;
await new Promise((res,rej)=>{
const s=document.createElement('script');
s.src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
s.onload=res; s.onerror=rej; document.head.appendChild(s);
});
jsPDFReady=true;
}
async function generatePDF(view="expenses", options = null){
await ensureJsPDF(); const { jsPDF }=window.jspdf; const doc=new jsPDF({unit:"mm",format:"a4"});

const opts = options || {};
const from = opts.from || '';
const to = opts.to || '';
const employee = (opts.employee || '').toLowerCase();

const business=state.settings.businessName||"Mi Negocio";
const logo=state.settings.logoBase64;

function header(title){
try{ if(logo && logo.startsWith('data:')) doc.addImage(logo,'PNG',14,10,24,24);}catch{}
doc.setFont("helvetica","bold"); doc.setTextColor(0); doc.setFontSize(16); doc.text(business,42,18);
doc.setFontSize(12); doc.text(title,42,26); doc.line(14,36,200,36);
}
function table(headers, rows, startY=42){ let y=startY; const colW=180/headers.length;
doc.setFont("helvetica","bold"); doc.setFontSize(10); headers.forEach((h,i)=>doc.text(String(h),14+i*colW,y));
y+=6; doc.line(14,y,200,y); y+=6; doc.setFont("helvetica","normal");
rows.forEach(r=>{ r.forEach((c,i)=>doc.text(String(c??'').slice(0,32),14+i*colW,y)); y+=6; if(y>280){doc.addPage(); y=20;} });
return y;
}

// Helper para filtrar por date/employee
function filterByOptions(itemDate, itemEmployee){
if(from || to){
if(!inRange(itemDate, from, to)) return false;
}
if(employee){
if(!itemEmployee || !String(itemEmployee).toLowerCase().includes(employee)) return false;
}
return true;
}

if(view==='invoices' && opts.id){
const inv=state.invoices.find(x=>x.id===opts.id); if(!inv) return toast('Factura no encontrada');
// draw invoice (simplificado)
header('FACTURA'); doc.setFontSize(10); doc.text(`Factura #${inv.number || ''}`, 14, 44);
const rows = (inv.items||[]).map(it=>[it.desc, it.qty, it.price.toFixed(2), it.tax, ((it.qty||0)*(it.price||0)*(1+(it.tax||0)/100)).toFixed(2)]);
table(['Descripción','Cant.','Precio','Imp %','Importe'], rows, 54);
doc.save(`${(business||'Negocio').replace(/\s+/g,'_')}_Factura_${inv.number||''}.pdf`); return;
}

// Map view -> headers/rows with filtering
let headers=[], rows=[], total=null;
if(view==="expenses"){ headers=["Fecha","Categoría","Descripción","Método","Monto"]; rows=state.expensesDaily.filter(e=>filterByOptions(e.date, e.category)).map(e=>[e.date,e.category,e.desc||'',e.method,Number(e.amount||0).toFixed(2)]); total=rows.reduce((a,r)=>a+parseFloat(r[4]||0),0); }
else if(view==="incomes"){ headers=["Fecha","Empleado/Cliente","Método","Ref","Monto"]; rows=state.incomesDaily.filter(i=>filterByOptions(i.date, i.client)).map(i=>[i.date,i.client,i.method,i.ref||'',Number(i.amount||0).toFixed(2)]); total=rows.reduce((a,r)=>a+parseFloat(r[4]||0),0); }
else if(view==="payments"){ headers=["Fecha","Empleado/Benef.","Categoría","Neto","Estado"]; rows=state.payments.filter(p=>filterByOptions(p.date, p.to)).map(p=>[p.date,p.to,p.category,Number(p.amount||0).toFixed(2),p.status]); total=rows.reduce((a,r)=>a+parseFloat(r[3]||0),0); }
else if(view==="retenciones"){ headers=["Fecha","Empleado","Tipo","Monto","Pagada"]; rows=state.retenciones.filter(r=>filterByOptions(r.date, r.employee)).map(r=>[r.date,r.employee,r.type,Number(r.amount||0).toFixed(2), r.paid ? 'Sí' : 'No' ]); total=state.retenciones.filter(r=>!r.paid).reduce((a,b)=>a+Number(b.amount||0),0); }
else if(view==="personal"){ headers=["Fecha","Categoría","Descripción","Monto"]; rows=state.personal.filter(p=>filterByOptions(p.date, p.category)).map(p=>[p.date,p.category,p.desc,Number(p.amount||0).toFixed(2)]); total=rows.reduce((a,r)=>a+parseFloat(r[3]||0),0); }
else if(view==="invoices"){ headers=["Fecha","# Factura","Cliente","Total","Método"]; rows=state.invoices.filter(f=>filterByOptions(f.date,f.client?.name)).map(f=>[f.date,f.number,f.client?.name||"",Number(f.total||0).toFixed(2),f.method||""]); total=rows.reduce((a,f)=>a+Number(f[3]||0),0); }
else if(view==="quotes"){ headers=["Fecha","# Cotización","Cliente","Total","Método"]; rows=state.quotes.filter(q=>filterByOptions(q.date,q.client?.name)).map(q=>[q.date,q.number,q.client?.name||"",Number(q.total||0).toFixed(2),q.method||""]); total=rows.reduce((a,q)=>a+Number(q[3]||0),0); }
else if(view==="reconciliations"){ headers=["Fecha","Saldo Banco","Balance App","Diferencia","Nota"]; rows=state.reconciliations.filter(r=>filterByOptions(r.date,'')).map(r=>[r.date,Number(r.bank||0).toFixed(2),Number(r.app||0).toFixed(2),Number(r.diff||0).toFixed(2),(r.note||'').slice(0,24)]); }

header((view||'REPORTE').toUpperCase());
let y=table(headers, rows, 42);
if(total!==null){ if(y+10>290){doc.addPage(); y=20;} doc.line(14,y,200,y); y+=7; doc.setFont("helvetica","bold"); doc.text("TOTAL",154,y); doc.text(fmt(total),200,y,{align:'right'}); }
doc.save(`${(business||'Negocio').replace(/\s+/g,'_')}_${view}.pdf`);
}

/* ===================== Wire Exports (botones para PDF con filtros) ===================== */
function wireExports(){
$$('[data-print-view]').forEach(b=>{
b.addEventListener('click', ()=>{
const from = $('#expFrom')?.value || '';
const to = $('#expTo')?.value || '';
const employee = $('#expEmployee')?.value || '';
generatePDF(b.dataset.printView, { from, to, employee });
});
});
$('#printBtn')?.addEventListener('click', ()=>{
const current=document.querySelector('.view.visible')?.id||'home';
const from = $('#expFrom')?.value || '';
const to = $('#expTo')?.value || '';
const employee = $('#expEmployee')?.value || '';
generatePDF(current, { from, to, employee });
});
}

/* ===================== Configuración / Datos / PIN ===================== */
function wireSettings(){
$('#saveSettings')?.addEventListener('click', ()=>{
state.settings.businessName=$('#setName')?.value||'Mi Negocio';
state.settings.currency=$('#setCurrency')?.value||'USD';
state.settings.theme.primary=$('#colorPrimary')?.value||state.settings.theme.primary;
state.settings.theme.accent=$('#colorAccent')?.value||state.settings.theme.accent;
state.settings.theme.text=$('#colorText')?.value||state.settings.theme.text;
save(); toast('Configuración guardada');
});
$('#setLogo')?.addEventListener('change', async (ev)=>{
const f=ev.target.files[0]; if(!f) return;
const base64=await new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(f); });
state.settings.logoBase64=base64; save(); toast('Logo actualizado');
});
$('#delLogo')?.addEventListener('click', ()=>{ state.settings.logoBase64=''; save(); toast('Logo eliminado'); });
$('#exportJSON')?.addEventListener('click', exportJSON);
$('#importJSON')?.addEventListener('change', (ev)=>{ const f=ev.target.files[0]; if(f) importJSON(f); });
$('#changePIN')?.addEventListener('click', async ()=>{
const old=$('#pinOld')?.value; const n1=$('#pinNew')?.value; const n2=$('#pinNew2')?.value;
if(!state.settings.pinHash) return toast('Primero crea un PIN');
const hashOld=await sha256(old||''); if(hashOld!==state.settings.pinHash) return toast('PIN actual incorrecto');
if(n1!==n2 || (n1||'').length<4 || (n1||'').length>8) return toast('Nuevo PIN inválido');
state.settings.pinHash=await sha256(n1); save(); toast('PIN actualizado'); ['pinOld','pinNew','pinNew2'].forEach(id=>{ const el=$('#'+id); if(el) el.value=''; });
});
}

/* ===================== Conciliación Bancaria ===================== */
function calcBalanceApp(){
const inc=state.incomesDaily.reduce((a,b)=>a+Number(b.amount||0),0);
const exp=state.expensesDaily.reduce((a,b)=>a+Number(b.amount||0),0);
const pay=state.payments.reduce((a,b)=>a+Number(b.amount||0),0);
const per=state.personal.reduce((a,b)=>a+Number(b.amount||0),0);
return inc - (exp + pay + per);
}
function renderReconciliations(){
const tbody=$('#reconTable tbody'); if(!tbody)return; tbody.innerHTML="";
state.reconciliations.slice().sort(byDateDesc).forEach(r=>{
const tr=document.createElement("tr");
tr.innerHTML=`
<td>${r.date}</td><td>${fmt(r.bank)}</td><td>${fmt(r.app)}</td>
<td>${fmt(r.diff)}</td><td>${r.note||""}</td>
<td class="row-actions">
<button class="btn-outline" data-edit="${r.id}">Editar</button>
<button class="btn-outline" data-del="${r.id}">Eliminar</button>
</td>`;
tbody.appendChild(tr);
});
$$('#reconTable [data-del]').forEach(b=>b.onclick=()=>{ state.reconciliations=state.reconciliations.filter(x=>x.id!==b.dataset.del); save(); toast("Eliminado"); });
$$('#reconTable [data-edit]').forEach(b=>b.onclick=()=>editReconciliation(b.dataset.edit));
}
function editReconciliation(id){
const i=state.reconciliations.findIndex(x=>x.id===id); if(i<0)return;
const r=state.reconciliations[i];
let q=ask(r.date,"Fecha (YYYY-MM-DD)"); if(q.cancelled)return; r.date=q.value;
q=askNumber(r.bank,"Saldo banco"); if(q.cancelled)return; r.bank=q.value;
q=ask(r.note,"Nota"); if(q.cancelled)return; r.note=q.value;
r.app=calcBalanceApp(); r.diff=(r.bank||0)-(r.app||0); save(); toast("Conciliación actualizada");
}
function wireReconciliation(){
$('#reconForm')?.addEventListener('submit',(ev)=>{
ev.preventDefault();
const rec={ id:uid(), date:$('#reconDate').value, bank:Number($('#reconBank').value||0),
app:calcBalanceApp(), diff:0, note:$('#reconNote').value };
rec.diff=rec.bank-rec.app; state.reconciliations.push(rec); save(); toast("Conciliación guardada"); ev.target.reset();
});
$('#reconExport')?.addEventListener('click',()=>generatePDF("reconciliations"));
}

/* ===== Importación CSV para Conciliación (idéntico a versión previa) ===== */
let reconImportRows=[];
const DATE_TOL_DAYS=3;
function getReconYear(){ const y=parseInt($('#reconYear')?.value||String(new Date().getFullYear()),10); return (isNaN(y)?new Date().getFullYear():y); }
function detectDelimiter(headerLine){ if(headerLine.includes(';')) return ';'; if(headerLine.includes('\t')) return '\t'; return ','; }
function normalizeAmount(raw){
if(raw==null) return 0; let s=String(raw).trim(); const isParen=/^\(.*\)$/.test(s);
s=s.replace(/[()]/g,'').replace(/[$€£]/g,'').replace(/\s/g,'');
if(s.includes(',') && !s.includes('.')) s=s.replace(',','.');
let n=parseFloat(s); if(Number.isNaN(n)) n=0; if(isParen) n=-Math.abs(n); return n;
}
function normalizeDate(s){
if(!s) return ''; s=String(s).trim();
if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
if(/^\d{2}[-/]\d{2}$/.test(s)){ const [mm,dd]=s.split(/[-/]/); const y=getReconYear(); return `${y}-${mm}-${dd}`; }
const m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
if(m){ let M=parseInt(m[1],10), d=parseInt(m[2],10), y=parseInt(m[3],10); if(y<100) y+=2000; return `${y}-${String(M).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
const dt=new Date(s); if(!isNaN(+dt)) return dt.toISOString().slice(0,10); return '';
}
function daysBetween(a,b){ const A=new Date(a), B=new Date(b); return Math.round((B-A)/86400000); }
function parseCSV(text){
const lines=text.split(/\r?\n/).filter(l=>l.trim().length>0); if(lines.length===0) return [];
const delim=detectDelimiter(lines[0]);
const headers=lines[0].split(delim).map(h=>h.trim().toLowerCase());
const idxDate = headers.findIndex(h=>/date|fecha/.test(h));
const idxDesc = headers.findIndex(h=>/desc|concept|detalle|description|descripcion/.test(h));
const idxAmt = headers.findIndex(h=>/amount|monto|importe|valor|cantidad/.test(h));
const idxRef = headers.findIndex(h=>/ref|referencia|doc|num/i.test(h));
const rows=[];
for(let i=1;i<lines.length;i++){
const cols=lines[i].split(delim);
if(cols.length<2) continue;
const date=normalizeDate(cols[idxDate]?.trim());
const desc=(cols[idxDesc]||'').trim();
const amount=normalizeAmount(cols[idxAmt]);
const ref=(idxRef>=0?cols[idxRef]:'')?.trim();
if(!date || (!desc && amount===0)) continue;
rows.push({ date, desc, amount, ref });
}
return rows;
}
function tryMatchRow(row){
const inTol=(d1,d2)=> Math.abs(daysBetween(d1,d2))<=DATE_TOL_DAYS;
const pools=[
{ list: state.incomesDaily, type:'income', sign:+1 },
{ list: state.expensesDaily, type:'expense', sign:-1 },
{ list: state.payments, type:'payroll', sign:-1 },
{ list: state.personal, type:'personal', sign:-1 },
];
const sameSignLists = pools.filter(p=> (row.amount>=0 && p.sign>0) || (row.amount<0 && p.sign<0));
const absAmt=Math.abs(row.amount);
for(const p of sameSignLists){
for(const item of p.list){
const itAbs=Math.abs(Number(item.amount||0));
if(Math.abs(itAbs - absAmt) <= 0.01 && inTol(item.date,row.date)){
return { type:p.type, id:item.id, date:item.date, amount:item.amount };
}
}
}
return null;
}
function renderReconImportTable(){
const tb=$('#reconImportTable tbody'); if(!tb) return; tb.innerHTML='';
let total=0,matches=0,nomatch=0;
reconImportRows.forEach(r=>{
total+=Number(r.amount||0);
r.match?matches++:nomatch++;
const tr=document.createElement('tr');
tr.innerHTML=`
<td>${r.date}</td>
<td>${r.ref||''}</td>
<td>${r.desc||''}</td>
<td>${r.amount.toFixed(2)}</td>
<td>${r.match?'Coincide':'Sin coincidencia'}</td>
<td>${r.match ? (r.match.type+'#'+String(r.match.id).slice(0,6)+'…') : '—'}</td>`;
tb.appendChild(tr);
});
$('#reconImpTotal') && ($('#reconImpTotal').textContent = fmt(total));
$('#reconImpMatches')&& ($('#reconImpMatches').textContent = String(matches));
$('#reconImpNoMatch')&& ($('#reconImpNoMatch').textContent = String(nomatch));
}
function wireReconciliationImport(){
$('#reconImportPreview')?.addEventListener('click', async ()=>{
const f=$('#reconFile')?.files?.[0]; if(!f) return toast('Selecciona un CSV');
const text=await f.text(); const rows=parseCSV(text);
if(rows.length===0) return toast('CSV vacío o sin columnas detectables');
reconImportRows=rows.map(r=>({ ...r, match:null }));
reconImportRows.forEach(r=> r.match = tryMatchRow(r));
renderReconImportTable(); toast('Previsualización lista');
});
$('#reconImportMatch')?.addEventListener('click', ()=>{
if(reconImportRows.length===0) return toast('No hay datos importados');
reconImportRows.forEach(r=> r.match = tryMatchRow(r));
renderReconImportTable(); toast('Matching ejecutado');
});
}

/* ===================== Cloud (Firestore) ===================== */
const cloud={ user:null, autosync: JSON.parse(localStorage.getItem('autosync')||'false'), unsub:null };
function uiCloud(){
$('#cloudStatus') && ($('#cloudStatus').textContent = cloud.user ? `Conectado como ${cloud.user.displayName||cloud.user.email||cloud.user.uid}` : 'No conectado');
$('#btnSignIn') && ($('#btnSignIn').style.display = cloud.user ? 'none' : 'inline-block');
$('#btnSignOut') && ($('#btnSignOut').style.display = cloud.user ? 'inline-block' : 'none');
$('#cloudAuto') && ($('#cloudAuto').checked = !!cloud.autosync);
}
function setAutosync(v){ cloud.autosync=!!v; localStorage.setItem('autosync', JSON.stringify(cloud.autosync)); uiCloud(); }
function cloudDocRef(){ if(!cloud.user) return null; return doc(db,'users',cloud.user.uid,'state','app'); }
async function cloudPull(replace=true){
const ref=cloudDocRef(); if(!ref) return toast('Inicia sesión primero');
const snap=await getDoc(ref); if(!snap.exists()) return toast('No hay datos en la nube');
const remote=snap.data(), rU=remote?._cloud?.updatedAt||0, lU=state?._cloud?.updatedAt||0;
if(replace || rU>=lU){ state=remote; } else {
state.settings=Object.assign({}, state.settings, remote.settings||{});
['expensesDaily','incomesDaily','payments','ordinary','budgets','personal','invoices','quotes','reconciliations','retenciones'].forEach(k=>{
if(Array.isArray(remote[k])) state[k]=state[k].concat(remote[k]);
});
state._cloud.updatedAt=Math.max(lU,rU);
}
save({skipCloud:true}); toast('Datos cargados desde la nube'); refreshAll();
}
async function cloudPush(){
const ref=cloudDocRef(); if(!ref) return toast('Inicia sesión primero');
state._cloud.updatedAt=nowMs();
await setDoc(ref, { ...state, _serverUpdatedAt: serverTimestamp() }, { merge:true });
save({skipCloud:true}); toast('Datos guardados en la nube');
}
let pushTimer; function cloudPushDebounced(){ clearTimeout(pushTimer); pushTimer=setTimeout(cloudPush,600); }
function cloudSubscribe(){
if(!cloud.user) return; const ref=cloudDocRef(); cloud.unsub?.();
cloud.unsub = onSnapshot(ref,(snap)=>{
if(!snap.exists()) return;
const remote=snap.data();
if((remote?._cloud?.updatedAt||0)>(state?._cloud?.updatedAt||0)){
state=remote; save({skipCloud:true}); toast('Actualizado desde la nube'); refreshAll();
}
});
}
function wireCloudUI(){
if(!auth) return;
const provider=new GoogleAuthProvider();
$('#btnSignIn')?.addEventListener('click', async ()=>{
try{ await signInWithPopup(auth, provider); }catch(e){ await signInWithRedirect(auth, provider); }
});
$('#btnSignOut')?.addEventListener('click', async ()=>{ await signOut(auth); });
$('#cloudPull')?.addEventListener('click', ()=> cloudPull(true));
$('#cloudPush')?.addEventListener('click', ()=> cloudPush());
$('#cloudAuto')?.addEventListener('change', (e)=> setAutosync(e.target.checked));
uiCloud(); getRedirectResult(auth).catch(()=>{});
onAuthStateChanged(auth,(user)=>{ cloud.user=user||null; uiCloud(); if(user){ cloudSubscribe(); } else { cloud.unsub?.(); cloud.unsub=null; }});
}

/* ===================== Buscadores en historiales ===================== */
function wireHistorySearch(){
$('#invSearch')?.addEventListener('input', (e)=> renderInvoicesHistory(e.target.value));
$('#quoSearch')?.addEventListener('input', (e)=> renderQuotesHistory(e.target.value));
}

/* ===================== Refresh / Init ===================== */
function refreshAll(){
renderExpenses(); renderIncomes(); renderPayments();
renderOrdinary(); renderBudgets(); renderPersonal();
renderReports(); renderHome(); renderRetenciones();
renderInvoicesKPI && renderInvoicesKPI();
renderQuotesKPI && renderQuotesKPI();
renderInvoicesHistory && renderInvoicesHistory($('#invSearch')?.value||'');
renderQuotesHistory && renderQuotesHistory($('#quoSearch')?.value||'');
renderReconciliations();
}
function wireAll(){
const sidebar=$('#sidebar');
sidebar?.addEventListener('click',(ev)=>{
const btn=ev.target.closest?.('.nav-btn');
if(btn && btn.dataset.target){ showView(btn.dataset.target); sidebar.classList.remove('open'); }
});
$('#menuToggle')?.addEventListener('click', ()=> sidebar?.classList.toggle('open'));

wireExports(); wireSettings();
wireExpenses(); wireIncomes(); wirePayments(); wireOrdinary(); wireBudgets(); wirePersonal();
wireInvoicesCreate && wireInvoicesCreate();
wireQuotesCreate && wireQuotesCreate();
wireReconciliation(); wireCloudUI(); wireHistorySearch(); wireReconciliationImport();

initCatalogs(); applyTheme(); refreshAll();

// Login visible al arrancar (sin showView('login'))
updateLoginUI();

// Logout button: mostrar overlay login
const logoutBtn = $('#logoutBtn');
if(logoutBtn) logoutBtn.addEventListener('click', (e)=>{
e.preventDefault();
// "Cerrar sesión" local: limpiar session markers
try{ sessionStorage.clear(); localStorage.removeItem('pinVerified'); }catch(e){}
// Mostrar login overlay
forceShowLogin();
toast('Sesión cerrada (pantalla de PIN activa)');
});
}
window.addEventListener('pageshow', (e)=>{ if(e.persisted){ updateLoginUI(); }});
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible' && $('#login')?.classList.contains('visible')){ forceShowLogin(); }});

/* ===================== API consola (opcional) ===================== */
self.app = { state, generatePDF, cloudPull, cloudPush };

/* ===================== Arranque ===================== */
document.addEventListener('DOMContentLoaded', wireAll);
