// Intraday daily P&L using real 5-min bars
// Config: Put δ0.12 · 15w · 11:00 AM · TG 1h · 2×/1× · mc$0.80
const fs = require('fs');

const histSrc = fs.readFileSync(__dirname + '/hist_data.js', 'utf8');
const HIST_DATA = eval('(' + histSrc.replace(/^const HIST_DATA\s*=\s*/, '').replace(/;\s*$/, '') + ')');

// Parse 5-min CSV
const csv = fs.readFileSync(__dirname + '/spx_5min.csv', 'utf8').trim().split('\n');
const bars5min = {};
for (let i = 1; i < csv.length; i++) {
  const parts = csv[i].split(',');
  const day = parts[0].slice(0, 10);
  const timePart = parts[0].slice(11, 16);
  const [hh, mm] = timePart.split(':').map(Number);
  const minutesSinceOpen = (hh - 8) * 60 + mm - 30;
  if (minutesSinceOpen < 0 || minutesSinceOpen > 390) continue;
  if (!bars5min[day]) bars5min[day] = [];
  bars5min[day].push({ minute: minutesSinceOpen, open: +parts[1], high: +parts[2], low: +parts[3], close: +parts[4] });
}

// BSM
function normCDF(x) { const t=1/(1+0.2316419*Math.abs(x)); const d=0.3989422820*Math.exp(-0.5*x*x); const p=d*t*(0.3193815+t*(-0.3565638+t*(1.7814779+t*(-1.8212560+t*1.3302744)))); return x>0?1-p:p; }
function bsm(S,K,T,rf,sigma,type) { if(T<=0.00001)return{price:Math.max(0,type==='put'?K-S:S-K),delta:0}; const d1=(Math.log(S/K)+(rf+0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T)); const d2=d1-sigma*Math.sqrt(T); const price=type==='put'?K*Math.exp(-rf*T)*normCDF(-d2)-S*normCDF(-d1):S*normCDF(d1)-K*Math.exp(-rf*T)*normCDF(d2); return{price,delta:type==='put'?normCDF(d1)-1:normCDF(d1)}; }
function findStrike(S,iv,T,targetDelta,type) { let lo=S*0.5,hi=S*1.5; for(let i=0;i<80;i++){const mid=(lo+hi)/2;const d=Math.abs(bsm(S,mid,T,0.045,iv,type).delta);if(d>targetDelta){type==='put'?(hi=mid):(lo=mid)}else{type==='put'?(lo=mid):(hi=mid)}} return Math.round(((lo+hi)/2)/5)*5; }
function getPhaseForCap(cap) { if(cap>=300000)return{perK:12000};if(cap>=75000)return{perK:8000};if(cap>=25000)return{perK:6000};return{perK:0}; }

// Config
const delta = 0.12, width = 15, entryMinute = 90, minCredit = 0.80; // 90min = 11:00 AM
const tgHours = 1, tgEarlyMult = 2, tgLateMult = 1, tgMinutes = tgHours * 60;
const SLIPPAGE = 0.05, FEE_OPEN = 3, FEE_CLOSE = 3;
const startCap = 10000;
const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

let capital = startCap, maxEquity = startCap;
const trades = [];
let monthTotals = {};

for (let i = 0; i < HIST_DATA.length; i++) {
  const [date, open, high, low, close, vix] = HIST_DATA[i];
  const dow = new Date(date).getDay();
  if (dow === 0 || dow === 6) continue;
  if (!bars5min[date]) continue;

  const dayBars = bars5min[date];
  const iv = vix / 100;
  const hoursToExpiry = (390 - entryMinute) / 60;
  const T = (hoursToExpiry / 24) / 365;
  const r = 0.045;

  const entryBar = dayBars.find(b => b.minute >= entryMinute);
  if (!entryBar) continue;
  const entryPrice = entryBar.open;

  // Contracts
  const estCredit = Math.min(width * 0.08, 1.50);
  const marginPerCt = (width - estCredit) * 100;
  const ph = getPhaseForCap(capital);
  const adjPerK = ph.perK > 0 ? ph.perK * (marginPerCt / 1400) : 0;
  const cts = adjPerK > 0 ? Math.max(1, Math.floor(capital / adjPerK)) : 2;

  // Strikes & credit
  const sP = findStrike(entryPrice, iv, T, delta, 'put'), lP = sP - width;
  const credit = Math.max(bsm(entryPrice, sP, T, r, iv, 'put').price - bsm(entryPrice, lP, T, r, iv, 'put').price - SLIPPAGE, 0);
  if (credit < minCredit) continue;

  // Walk 5-min bars for stop detection
  const earlyStopPrice = credit * tgEarlyMult;
  const lateStopPrice = credit * tgLateMult;
  const proximity = 0.25;
  const stopLevel = sP + (entryPrice - sP) * proximity;
  let result, pnl, reason = '', activelyClosed = false;
  let stopMinute = null;

  let stopped = false;
  for (let j = 0; j < dayBars.length; j++) {
    const bar = dayBars[j];
    if (bar.minute < entryMinute) continue;
    const minSinceEntry = bar.minute - entryMinute;
    if (bar.low <= stopLevel) {
      stopped = true; activelyClosed = true; stopMinute = bar.minute;
      const isEarly = minSinceEntry < tgMinutes;
      if (isEarly) {
        reason = tgEarlyMult + '× early stop (' + minSinceEntry + 'min)';
        pnl = -(earlyStopPrice - credit) * cts * 100;
      } else {
        reason = tgLateMult + '× late stop (' + minSinceEntry + 'min)';
        pnl = -(lateStopPrice - credit) * cts * 100;
      }
      result = 'LOSS';
      break;
    }
  }
  if (!stopped) {
    result = 'WIN'; reason = 'Expired OTM';
    pnl = credit * cts * 100;
  }

  const fees = (FEE_OPEN + (activelyClosed ? FEE_CLOSE : 0)) * cts;
  pnl -= fees;
  if (pnl < 0 && result === 'WIN') { result = 'LOSS'; reason = 'Fees exceeded profit'; }

  capital += pnl;
  if (capital < 0) capital = 0;
  if (capital > maxEquity) maxEquity = capital;
  const dd = maxEquity > 0 ? ((maxEquity - capital) / maxEquity * 100).toFixed(1) : '0.0';

  const month = date.slice(0, 7);
  if (!monthTotals[month]) monthTotals[month] = 0;
  monthTotals[month] += pnl;

  // Convert stopMinute to time string
  const entryTimeStr = '11:00';
  let stopTimeStr = '—';
  if (stopMinute !== null) {
    const h = Math.floor((stopMinute + 570) / 60); // 570 = 9:30 in minutes from midnight
    const m = (stopMinute + 570) % 60;
    stopTimeStr = `${h}:${String(m).padStart(2,'0')}`;
  }

  trades.push({ date, day: dayNames[dow], vix: vix.toFixed(1), strike: sP, credit: credit.toFixed(2), cts, result, pnl: Math.round(pnl), capital: Math.round(capital), dd, reason, close: close.toFixed(2), stopTime: stopTimeStr });
}

// Print
console.log('═'.repeat(140));
console.log('  INTRADAY DAILY P&L — Put δ0.12 · 15w · 11:00 AM · TG 1h · 2×/1× · mc$0.80');
console.log('  Using REAL 5-min SPX bars · $3 open + $3 close fees · Phase-based scaling');
console.log('═'.repeat(140));
console.log('');
console.log('  #    DATE         DAY   VIX    STRIKE   CREDIT   CTS   RESULT     P&L        CAPITAL      DD     STOP TIME   REASON');
console.log('─'.repeat(140));

let prevMonth = '';
trades.forEach((t, idx) => {
  const m = t.date.slice(0, 7);
  if (m !== prevMonth && prevMonth !== '') {
    const mPnl = monthTotals[prevMonth];
    console.log(`  ${'─'.repeat(136)}`);
    console.log(`  ${prevMonth} TOTAL: ${mPnl >= 0 ? '+' : ''}$${Math.round(mPnl).toLocaleString()}`);
    console.log('');
  }
  prevMonth = m;

  const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toLocaleString();
  const capStr = '$' + t.capital.toLocaleString();
  const resultStr = t.result === 'WIN' ? '  WIN' : ' LOSS';
  console.log(
    `  ${String(idx+1).padStart(3)}  ${t.date}   ${t.day}   ${t.vix.padStart(5)}   ${String(t.strike).padStart(6)}   $${t.credit}    ${String(t.cts).padStart(3)}   ${resultStr}   ${pnlStr.padStart(10)}   ${capStr.padStart(12)}   ${t.dd.padStart(5)}%   ${t.stopTime.padStart(5)}       ${t.reason}`
  );
});

// Final month
if (prevMonth && monthTotals[prevMonth] !== undefined) {
  console.log(`  ${'─'.repeat(136)}`);
  console.log(`  ${prevMonth} TOTAL: ${monthTotals[prevMonth] >= 0 ? '+' : ''}$${Math.round(monthTotals[prevMonth]).toLocaleString()}`);
}

console.log('\n' + '═'.repeat(140));
const wins = trades.filter(t => t.result === 'WIN').length;
const losses = trades.filter(t => t.result === 'LOSS').length;
const total = trades.length;
const avgWin = wins > 0 ? Math.round(trades.filter(t => t.result === 'WIN').reduce((s,t) => s + t.pnl, 0) / wins) : 0;
const avgLoss = losses > 0 ? Math.round(trades.filter(t => t.result === 'LOSS').reduce((s,t) => s + t.pnl, 0) / losses) : 0;
const totalWinPnl = trades.filter(t => t.result === 'WIN').reduce((s,t) => s + t.pnl, 0);
const totalLossPnl = trades.filter(t => t.result === 'LOSS').reduce((s,t) => s + t.pnl, 0);
const pf = totalLossPnl !== 0 ? (totalWinPnl / Math.abs(totalLossPnl)).toFixed(2) : '∞';
const roi = ((capital - startCap) / startCap * 100).toFixed(1);
const maxDD = Math.max(...trades.map(t => parseFloat(t.dd)));
console.log(`  SUMMARY: ${total} trades · ${wins}W ${losses}L · ${(wins/total*100).toFixed(1)}% win rate · ROI +${roi}% · PF ${pf} · Max DD ${maxDD}% · Final $${Math.round(capital).toLocaleString()}`);
console.log(`  Avg Win: +$${avgWin} · Avg Loss: $${avgLoss}`);

// Monthly summary
console.log('\n  MONTHLY SUMMARY:');
console.log('  ' + '─'.repeat(40));
for (const [m, pnl] of Object.entries(monthTotals)) {
  console.log(`  ${m}  ${pnl >= 0 ? '+' : ''}$${Math.round(pnl).toLocaleString().padStart(8)}`);
}
console.log('═'.repeat(140));
