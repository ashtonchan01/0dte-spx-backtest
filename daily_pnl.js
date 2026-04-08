// Daily P&L breakdown for baseline: Put δ0.15 · 10w · 9:30 · TG 1.5h · 2×/1×
const fs = require('fs');
const histSrc = fs.readFileSync(__dirname + '/hist_data.js', 'utf8');
const HIST_DATA = eval('(' + histSrc.replace(/^const HIST_DATA\s*=\s*/, '').replace(/;\s*$/, '') + ')');

// BSM
function normCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x > 0 ? 1 - p : p;
}
function bsm(S, K, T, rf, sigma, type) {
  if (T <= 0.00001) return { price: Math.max(0, type === 'put' ? K - S : S - K), delta: 0 };
  const d1 = (Math.log(S / K) + (rf + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const price = type === 'put'
    ? K * Math.exp(-rf * T) * normCDF(-d2) - S * normCDF(-d1)
    : S * normCDF(d1) - K * Math.exp(-rf * T) * normCDF(d2);
  const delta = type === 'put' ? normCDF(d1) - 1 : normCDF(d1);
  return { price, delta };
}
function findStrike(S, iv, T, targetDelta, type) {
  let lo = S * 0.5, hi = S * 1.5;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const d = Math.abs(bsm(S, mid, T, 0.045, iv, type).delta);
    if (d > targetDelta) { type === 'put' ? (hi = mid) : (lo = mid); }
    else { type === 'put' ? (lo = mid) : (hi = mid); }
  }
  return Math.round(((lo + hi) / 2) / 5) * 5;
}

// Config: baseline optimal
const delta = 0.15, width = 10, hoursToExpiry = 6.5, minCredit = 0.80;
const tgHours = 1.5, tgEarlyMult = 2, tgLateMult = 1;
const SLIPPAGE = 0.05;
const startCap = 10000;

function getPhaseForCap(cap) {
  if (cap >= 300000) return { perK: 12000 };
  if (cap >= 75000) return { perK: 8000 };
  if (cap >= 25000) return { perK: 6000 };
  return { perK: 0 };
}

let capital = startCap;
let maxEquity = capital;
const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const trades = [];
let monthTotals = {};

for (let i = 0; i < HIST_DATA.length; i++) {
  const [date, open, high, low, close, vix] = HIST_DATA[i];
  const dow = new Date(date).getDay();
  if (dow === 0 || dow === 6) continue;

  const iv = vix / 100;
  const T = (hoursToExpiry / 24) / 365;
  const r = 0.045;

  // Contracts (phase-based)
  const estCredit = Math.min(width * 0.08, 1.50);
  const marginPerCt = (width - estCredit) * 100;
  const ph = getPhaseForCap(capital);
  const baseMargin = 1400;
  const marginRatio = marginPerCt / baseMargin;
  const adjPerK = ph.perK > 0 ? ph.perK * marginRatio : 0;
  const cts = adjPerK > 0 ? Math.max(1, Math.floor(capital / adjPerK)) : 2;

  // Strikes & credit
  const sP = findStrike(open, iv, T, delta, 'put'), lP = sP - width;
  const credit = Math.max(bsm(open, sP, T, r, iv, 'put').price - bsm(open, lP, T, r, iv, 'put').price - SLIPPAGE, 0);
  if (credit < minCredit) continue;

  // Breach detection
  const dailyRange = high - low;
  const arvoFraction = hoursToExpiry / 6.5;
  const arvoRange = dailyRange * arvoFraction;
  const arvoLow = Math.min(close, open) - arvoRange * 0.3;
  const putBuffer = open - sP;
  const proximity = 0.25;
  const putStopLevel = sP + putBuffer * proximity;
  let putBreached = arvoLow <= putStopLevel;

  const earlyStopPrice = credit * tgEarlyMult;
  const lateStopPrice = credit * tgLateMult;

  const closePos = (high !== low) ? (close - low) / (high - low) : 0.5;
  const earlyFrac = tgHours / 6.5;

  // Estimate if breach was early or late window
  const putEarlyNoise = putBreached && closePos > (1 - earlyFrac);
  let result, pnl, reason = '';
  let activelyClosed = false;

  if (putBreached) {
    result = 'LOSS';
    activelyClosed = true;
    const sp = putEarlyNoise ? earlyStopPrice : lateStopPrice;
    reason = putEarlyNoise ? tgEarlyMult + '× early stop' : tgLateMult + '× late stop';
    pnl = -(sp - credit) * cts * 100;
  } else {
    result = 'WIN';
    reason = 'Expired OTM';
    pnl = credit * cts * 100;
  }

  // Fees: $3/spread to open (always) + $3/spread to close (only if stopped)
  const fees = (3 + (activelyClosed ? 3 : 0)) * cts;
  pnl -= fees;
  if (pnl < 0 && result === 'WIN') { result = 'LOSS'; reason = 'Fees exceeded profit'; }

  capital += pnl;
  if (capital < 0) capital = 0;

  if (capital > maxEquity) maxEquity = capital;
  const dd = maxEquity > 0 ? ((maxEquity - capital) / maxEquity * 100).toFixed(1) : '0.0';

  const month = date.slice(0, 7);
  if (!monthTotals[month]) monthTotals[month] = 0;
  monthTotals[month] += pnl;

  trades.push({
    date,
    day: dayNames[dow],
    vix: vix.toFixed(1),
    strike: sP,
    credit: credit.toFixed(2),
    cts,
    result,
    pnl: Math.round(pnl),
    capital: Math.round(capital),
    dd
  });
}

// Print header
console.log('═'.repeat(120));
console.log('  DAILY P&L — Put δ0.15 · 10w · 9:30AM · TG 1.5h · 2×/1× · Min credit $0.80');
console.log('  Start: $10,000 · Phase-based scaling · 25% proximity');
console.log('═'.repeat(120));
console.log('');
console.log('  #    DATE         DAY   VIX    STRIKE   CREDIT   CTS   RESULT     P&L        CAPITAL      DD');
console.log('─'.repeat(120));

let prevMonth = '';
let monthIdx = 0;
trades.forEach((t, idx) => {
  const m = t.date.slice(0, 7);
  if (m !== prevMonth && prevMonth !== '') {
    const mPnl = monthTotals[prevMonth];
    console.log(`  ${'─'.repeat(116)}`);
    console.log(`  ${prevMonth} TOTAL: ${mPnl >= 0 ? '+' : ''}$${Math.round(mPnl).toLocaleString()}`);
    console.log('');
    prevMonth = m;
  }
  if (prevMonth === '') prevMonth = m;

  const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toLocaleString();
  const capStr = '$' + t.capital.toLocaleString();
  const resultColor = t.result === 'WIN' ? '  WIN' : ' LOSS';
  console.log(
    `  ${String(idx + 1).padStart(3)}  ${t.date}   ${t.day}   ${t.vix.padStart(5)}   ${String(t.strike).padStart(6)}   $${t.credit}    ${String(t.cts).padStart(3)}   ${resultColor}   ${pnlStr.padStart(10)}   ${capStr.padStart(12)}   ${t.dd}%`
  );
});

// Final month
if (prevMonth && monthTotals[prevMonth] !== undefined) {
  const mPnl = monthTotals[prevMonth];
  console.log(`  ${'─'.repeat(116)}`);
  console.log(`  ${prevMonth} TOTAL: ${mPnl >= 0 ? '+' : ''}$${Math.round(mPnl).toLocaleString()}`);
}

console.log('');
console.log('═'.repeat(120));
const wins = trades.filter(t => t.result === 'WIN').length;
const losses = trades.filter(t => t.result === 'LOSS').length;
const total = trades.length;
const avgWin = wins > 0 ? Math.round(trades.filter(t => t.result === 'WIN').reduce((s, t) => s + t.pnl, 0) / wins) : 0;
const avgLoss = losses > 0 ? Math.round(trades.filter(t => t.result === 'LOSS').reduce((s, t) => s + t.pnl, 0) / losses) : 0;
const roi = ((capital - startCap) / startCap * 100).toFixed(1);
const maxDD = Math.max(...trades.map(t => parseFloat(t.dd)));
console.log(`  SUMMARY: ${total} trades · ${wins}W ${losses}L · ${(wins/total*100).toFixed(1)}% win rate · ROI ${roi}% · Max DD ${maxDD}% · Final $${Math.round(capital).toLocaleString()}`);
console.log(`  Avg Win: +$${avgWin} · Avg Loss: $${avgLoss}`);
console.log('═'.repeat(120));
