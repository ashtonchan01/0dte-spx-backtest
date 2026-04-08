// Intraday backtest optimizer using real 5-min SPX bars
// Determines EXACT stop timing (early vs late) from actual price path
const fs = require('fs');

// ── Load data ──
const histSrc = fs.readFileSync(__dirname + '/hist_data.js', 'utf8');
const HIST_DATA = eval('(' + histSrc.replace(/^const HIST_DATA\s*=\s*/, '').replace(/;\s*$/, '') + ')');

// Parse 5-min CSV
const csv = fs.readFileSync(__dirname + '/spx_5min.csv', 'utf8').trim().split('\n');
const bars5min = {};
for (let i = 1; i < csv.length; i++) {
  const parts = csv[i].split(',');
  const dateStr = parts[0]; // "2024-03-12 08:30:00-05:00"
  const day = dateStr.slice(0, 10);
  const timePart = dateStr.slice(11, 16); // "08:30"
  const [hh, mm] = timePart.split(':').map(Number);
  const minutesSinceOpen = (hh - 8) * 60 + mm - 30; // 0 = 9:30 AM ET (08:30 in -05:00)
  if (minutesSinceOpen < 0 || minutesSinceOpen > 390) continue;
  if (!bars5min[day]) bars5min[day] = [];
  bars5min[day].push({
    minute: minutesSinceOpen,
    open: parseFloat(parts[1]),
    high: parseFloat(parts[2]),
    low: parseFloat(parts[3]),
    close: parseFloat(parts[4])
  });
}

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
  return { price, delta: type === 'put' ? normCDF(d1) - 1 : normCDF(d1) };
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

function getPhaseForCap(cap) {
  if (cap >= 300000) return { perK: 12000 };
  if (cap >= 75000) return { perK: 8000 };
  if (cap >= 25000) return { perK: 6000 };
  return { perK: 0 };
}

// ── Run single backtest config ──
function runBacktest(config) {
  const { delta, width, entryMinute, tgHours, tgEarly, tgLate, minCredit, stopMode } = config;
  const SLIPPAGE = 0.05;
  const FEE_OPEN = 3, FEE_CLOSE = 3;
  const startCap = 10000;
  let capital = startCap;
  let maxEquity = startCap;
  let maxDrawdown = 0;
  let wins = 0, losses = 0;
  let totalWinPnl = 0, totalLossPnl = 0;
  let maxLoseStreak = 0, curStreak = 0;
  const tgMinutes = tgHours * 60; // early window in minutes from entry

  for (let i = 0; i < HIST_DATA.length; i++) {
    const [date, open, high, low, close, vix] = HIST_DATA[i];
    const dow = new Date(date).getDay();
    if (dow === 0 || dow === 6) continue;
    if (!bars5min[date]) continue;

    const dayBars = bars5min[date];
    const iv = vix / 100;
    const hoursToExpiry = (390 - entryMinute) / 60; // minutes remaining / 60
    const T = (hoursToExpiry / 24) / 365;
    const r = 0.045;

    // Find entry bar (first bar at or after entryMinute)
    const entryBar = dayBars.find(b => b.minute >= entryMinute);
    if (!entryBar) continue;
    const entryPrice = entryBar.open;

    // Contracts (phase-based)
    const estCredit = Math.min(width * 0.08, 1.50);
    const marginPerCt = (width - estCredit) * 100;
    const ph = getPhaseForCap(capital);
    const baseMargin = 1400;
    const marginRatio = marginPerCt / baseMargin;
    const adjPerK = ph.perK > 0 ? ph.perK * marginRatio : 0;
    const cts = adjPerK > 0 ? Math.max(1, Math.floor(capital / adjPerK)) : 2;

    // Find strikes
    const sP = findStrike(entryPrice, iv, T, delta, 'put'), lP = sP - width;
    const sC = findStrike(entryPrice, iv, T, delta, 'call'), lC = sC + width;
    const putCredit = Math.max(bsm(entryPrice, sP, T, r, iv, 'put').price - bsm(entryPrice, lP, T, r, iv, 'put').price - SLIPPAGE, 0);

    if (putCredit < minCredit) continue;

    let result, pnl, reason = '', activelyClosed = false;

    if (stopMode === 'none') {
      // No stop — hold to expiry, partial loss
      const lastBar = dayBars[dayBars.length - 1];
      const closePrice = lastBar.close;
      if (closePrice > sP) {
        result = 'WIN'; pnl = putCredit * cts * 100; reason = 'Expired OTM';
      } else {
        const intrinsic = Math.min(sP - closePrice, width);
        const netLoss = intrinsic - putCredit;
        if (netLoss <= 0) { result = 'WIN'; pnl = Math.abs(netLoss) * cts * 100; reason = 'Expired ITM (credit > intrinsic)'; }
        else { result = 'LOSS'; pnl = -netLoss * cts * 100; reason = 'Expired ITM (' + (sP - closePrice).toFixed(0) + 'pts)'; }
      }
    } else {
      // Time-gated stop — walk through 5-min bars
      const earlyStopPrice = putCredit * tgEarly;
      const lateStopPrice = putCredit * tgLate;
      const proximity = 0.25;
      const stopLevel = sP + (entryPrice - sP) * proximity;
      let stopped = false;

      for (let j = 0; j < dayBars.length; j++) {
        const bar = dayBars[j];
        if (bar.minute < entryMinute) continue; // before entry
        const minutesSinceEntry = bar.minute - entryMinute;
        const isEarly = minutesSinceEntry < tgMinutes;

        // Check if SPX low breached the stop level
        if (bar.low <= stopLevel) {
          stopped = true;
          activelyClosed = true;
          if (isEarly) {
            reason = tgEarly + '× early stop (' + minutesSinceEntry + 'min)';
            pnl = -(earlyStopPrice - putCredit) * cts * 100;
          } else {
            reason = tgLate + '× late stop (' + minutesSinceEntry + 'min)';
            pnl = -(lateStopPrice - putCredit) * cts * 100;
          }
          result = 'LOSS';
          break;
        }
      }

      if (!stopped) {
        result = 'WIN';
        pnl = putCredit * cts * 100;
        reason = 'Expired OTM';
      }
    }

    // Fees
    const fees = (FEE_OPEN + (activelyClosed ? FEE_CLOSE : 0)) * cts;
    pnl -= fees;
    if (pnl < 0 && result === 'WIN') { result = 'LOSS'; reason = 'Fees exceeded profit'; }

    capital += pnl;
    if (capital < 0) capital = 0;

    if (result === 'WIN') { wins++; totalWinPnl += pnl; curStreak = 0; }
    else { losses++; totalLossPnl += pnl; curStreak++; maxLoseStreak = Math.max(maxLoseStreak, curStreak); }

    if (capital > maxEquity) maxEquity = capital;
    const dd = maxEquity > 0 ? (maxEquity - capital) / maxEquity : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const total = wins + losses;
  const roi = ((capital - startCap) / startCap * 100);
  const avgWin = wins > 0 ? Math.round(totalWinPnl / wins) : 0;
  const avgLoss = losses > 0 ? Math.round(totalLossPnl / losses) : 0;
  const pf = totalLossPnl !== 0 ? (totalWinPnl / Math.abs(totalLossPnl)) : Infinity;

  return { total, wins, losses, winRate: total > 0 ? (wins / total * 100) : 0, roi, pf, maxDrawdown: maxDrawdown * 100, maxLoseStreak, avgWin, avgLoss, final: Math.round(capital) };
}

// ── Parameter sweep ──
console.log('═'.repeat(130));
console.log('  INTRADAY BACKTEST OPTIMIZER — Real 5-min SPX bars');
console.log('  Data: ' + Object.keys(bars5min).length + ' trading days with 5-min bars');
console.log('═'.repeat(130));

const configs = [];

// Sweep parameters
const deltas = [0.10, 0.12, 0.15, 0.18, 0.20];
const widths = [5, 10, 15, 20];
const entryMinutes = [0, 30, 60, 90]; // 0=9:30, 30=10:00, 60=10:30, 90=11:00
const entryLabels = { 0: '9:30', 30: '10:00', 60: '10:30', 90: '11:00' };
const tgHoursArr = [1, 1.5, 2, 3];
const tgEarlyArr = [2, 3];
const tgLateArr = [1, 1.5];
const minCredits = [0.60, 0.80, 1.00];

// Time-gated combinations
for (const delta of deltas) {
  for (const width of widths) {
    for (const entry of entryMinutes) {
      for (const tgH of tgHoursArr) {
        for (const tgE of tgEarlyArr) {
          for (const tgL of tgLateArr) {
            for (const mc of minCredits) {
              configs.push({
                delta, width, entryMinute: entry, tgHours: tgH,
                tgEarly: tgE, tgLate: tgL, minCredit: mc, stopMode: 'timegated',
                label: `Put δ${delta} · ${width}w · ${entryLabels[entry]} · TG ${tgH}h · ${tgE}×/${tgL}× · mc$${mc}`
              });
            }
          }
        }
      }
    }
  }
}

// No-stop combinations (fewer params)
for (const delta of deltas) {
  for (const width of widths) {
    for (const entry of entryMinutes) {
      for (const mc of minCredits) {
        configs.push({
          delta, width, entryMinute: entry, tgHours: 0, tgEarly: 0, tgLate: 0,
          minCredit: mc, stopMode: 'none',
          label: `Put δ${delta} · ${width}w · ${entryLabels[entry]} · NO STOP · mc$${mc}`
        });
      }
    }
  }
}

console.log(`  Running ${configs.length} configurations...\n`);

const results = [];
let done = 0;
for (const cfg of configs) {
  const r = runBacktest(cfg);
  results.push({ ...cfg, ...r });
  done++;
  if (done % 100 === 0) process.stderr.write(`  ${done}/${configs.length}...\r`);
}
process.stderr.write(`  ${done}/${configs.length} done.\n\n`);

// Sort by ROI
results.sort((a, b) => b.roi - a.roi);

// Print top 30
console.log('  TOP 30 BY ROI (profitable only):');
console.log('─'.repeat(130));
console.log('  #   CONFIG                                                          TRADES  WIN%    ROI        PF     DD      STREAK  AVG W/L            FINAL');
console.log('─'.repeat(130));

let rank = 0;
for (const r of results) {
  if (r.roi <= 0) continue;
  rank++;
  if (rank > 30) break;
  const pfStr = r.pf === Infinity ? '∞' : r.pf.toFixed(2);
  console.log(
    `  ${String(rank).padStart(2)}  ${r.label.padEnd(65)} ${String(r.total).padStart(5)}  ${r.winRate.toFixed(1).padStart(5)}%  ${('+' + r.roi.toFixed(0) + '%').padStart(8)}  ${pfStr.padStart(6)}  ${r.maxDrawdown.toFixed(1).padStart(5)}%  ${String(r.maxLoseStreak).padStart(4)}    $${r.avgWin}/$${r.avgLoss}`.padEnd(18) + `  $${r.final.toLocaleString()}`
  );
}

// Also show top 10 by profit factor (min 50 trades)
console.log('\n');
console.log('  TOP 10 BY PROFIT FACTOR (min 50 trades):');
console.log('─'.repeat(130));
const byPF = results.filter(r => r.total >= 50 && r.pf !== Infinity).sort((a, b) => b.pf - a.pf);
rank = 0;
for (const r of byPF) {
  rank++;
  if (rank > 10) break;
  console.log(
    `  ${String(rank).padStart(2)}  ${r.label.padEnd(65)} ${String(r.total).padStart(5)}  ${r.winRate.toFixed(1).padStart(5)}%  ${('+' + r.roi.toFixed(0) + '%').padStart(8)}  ${r.pf.toFixed(2).padStart(6)}  ${r.maxDrawdown.toFixed(1).padStart(5)}%  ${String(r.maxLoseStreak).padStart(4)}    $${r.avgWin}/$${r.avgLoss}`.padEnd(18) + `  $${r.final.toLocaleString()}`
  );
}

// Top 10 by lowest drawdown (profitable, min 50 trades)
console.log('\n');
console.log('  TOP 10 BY LOWEST DRAWDOWN (profitable, min 50 trades):');
console.log('─'.repeat(130));
const byDD = results.filter(r => r.total >= 50 && r.roi > 0).sort((a, b) => a.maxDrawdown - b.maxDrawdown);
rank = 0;
for (const r of byDD) {
  rank++;
  if (rank > 10) break;
  console.log(
    `  ${String(rank).padStart(2)}  ${r.label.padEnd(65)} ${String(r.total).padStart(5)}  ${r.winRate.toFixed(1).padStart(5)}%  ${('+' + r.roi.toFixed(0) + '%').padStart(8)}  ${r.pf.toFixed(2).padStart(6)}  ${r.maxDrawdown.toFixed(1).padStart(5)}%  ${String(r.maxLoseStreak).padStart(4)}    $${r.avgWin}/$${r.avgLoss}`.padEnd(18) + `  $${r.final.toLocaleString()}`
  );
}

// Show your current setup specifically
console.log('\n');
console.log('  YOUR PREVIOUS BASELINE (δ0.15 · 10w · 9:30 · TG 1.5h · 2×/1× · mc$0.80):');
console.log('─'.repeat(130));
const baseline = results.find(r => r.delta === 0.15 && r.width === 10 && r.entryMinute === 0 && r.tgHours === 1.5 && r.tgEarly === 2 && r.tgLate === 1 && r.minCredit === 0.80 && r.stopMode === 'timegated');
if (baseline) {
  console.log(`      ${baseline.label.padEnd(65)} ${String(baseline.total).padStart(5)}  ${baseline.winRate.toFixed(1).padStart(5)}%  ${('+' + baseline.roi.toFixed(0) + '%').padStart(8)}  ${baseline.pf.toFixed(2).padStart(6)}  ${baseline.maxDrawdown.toFixed(1).padStart(5)}%  ${String(baseline.maxLoseStreak).padStart(4)}    $${baseline.avgWin}/$${baseline.avgLoss}  $${baseline.final.toLocaleString()}`);
}

// Your no-stop setup
console.log('\n  YOUR CURRENT LIVE SETUP (δ0.15 · 5w · 10:30 · NO STOP · mc$0.80):');
console.log('─'.repeat(130));
const noStop = results.find(r => r.delta === 0.15 && r.width === 5 && r.entryMinute === 60 && r.stopMode === 'none' && r.minCredit === 0.80);
if (noStop) {
  console.log(`      ${noStop.label.padEnd(65)} ${String(noStop.total).padStart(5)}  ${noStop.winRate.toFixed(1).padStart(5)}%  ${('+' + noStop.roi.toFixed(0) + '%').padStart(8)}  ${(noStop.pf === Infinity ? '∞' : noStop.pf.toFixed(2)).padStart(6)}  ${noStop.maxDrawdown.toFixed(1).padStart(5)}%  ${String(noStop.maxLoseStreak).padStart(4)}    $${noStop.avgWin}/$${noStop.avgLoss}  $${noStop.final.toLocaleString()}`);
} else {
  console.log('  (no trades matched — mc$0.80 may be too high for δ0.15 · 5w)');
}

console.log('\n' + '═'.repeat(130));
