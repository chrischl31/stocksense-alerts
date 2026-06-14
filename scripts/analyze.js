// stocksense-alerts/scripts/analyze.js
// Läuft täglich via GitHub Actions – analysiert Watchlist und sendet Mails bei Signalen

import fetch from "node-fetch";
import { readFileSync } from "fs";
import { createTransport } from "nodemailer";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const EMAIL_USER     = process.env.EMAIL_USER;     // coolthegangster@hotmail.de
const EMAIL_PASS     = process.env.EMAIL_PASS;     // App-Passwort von Hotmail
const EMAIL_TO       = process.env.EMAIL_TO;       // krukrukakawe@proton.me
const MIN_CONFIDENCE = 70; // Nur Signale mit >= 70% Konfidenz mailen

// ── WATCHLIST LADEN ───────────────────────────────────────────────────────────
function loadWatchlist() {
  const raw = readFileSync("./watchlist.txt", "utf8");
  return raw
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));
}

// ── YAHOO FINANCE ─────────────────────────────────────────────────────────────
async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status} für ${symbol}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(`Kein Ergebnis für ${symbol}`);

  const meta = r.meta;
  const q    = r.indicators?.quote?.[0] || {};
  const closes = (q.close  || []).filter(Boolean);
  const highs  = (q.high   || []).filter(Boolean);
  const lows   = (q.low    || []).filter(Boolean);

  const price = meta.regularMarketPrice || closes[closes.length - 1];
  const prev  = meta.chartPreviousClose || closes[closes.length - 2];

  return {
    symbol: (meta.symbol || symbol).toUpperCase(),
    name:   meta.shortName || symbol,
    price,
    change: price - prev,
    pct:    ((price - prev) / prev * 100),
    currency: meta.currency || "USD",
    exchange: meta.exchangeName || "",
    closes, highs, lows,
    high52: meta.fiftyTwoWeekHigh,
    low52:  meta.fiftyTwoWeekLow,
  };
}

// ── TECHNISCHE ANALYSE ────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  return 100 - 100 / (1 + gains / (losses || 0.001));
}

function detectPattern(closes, highs, lows) {
  const n       = closes.length;
  const recent  = closes.slice(-20);
  const f10     = recent.slice(0, 10);
  const l10     = recent.slice(-10);
  const avg1    = f10.reduce((a, b) => a + b, 0) / 10;
  const avg2    = l10.reduce((a, b) => a + b, 0) / 10;
  const low1    = Math.min(...f10);
  const low2    = Math.min(...l10);
  const high1   = Math.max(...f10);
  const high2   = Math.max(...l10);
  const cur     = closes[n - 1];
  const sma20   = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const sma50   = closes.length >= 50 ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50 : null;
  const support    = Math.min(...lows.slice(-30))  * 1.002;
  const resistance = Math.max(...highs.slice(-30)) * 0.998;
  const atr        = closes.slice(-14).reduce((acc, c, i, arr) =>
    i === 0 ? acc : acc + Math.abs(c - arr[i - 1]), 0) / 13;
  const rsi = calcRSI(closes);

  let pattern = null;

  if (Math.abs(low1 - low2) / low1 < 0.03 && cur > low1 * 1.04)
    pattern = { name: "Double Bottom", signal: "BUY", strength: 84,
      horizon: "Mittelfristig", weeks: "4–8 Wochen",
      desc: "Zwei Tiefpunkte auf ähnlichem Niveau – klassisches Umkehrsignal." };
  else if (low1 < avg1 * 0.96 && cur > avg2 * 0.99 && avg2 > avg1)
    pattern = { name: "Cup & Handle", signal: "BUY", strength: 79,
      horizon: "Mittelfristig", weeks: "3–6 Wochen",
      desc: "Runder Boden mit anschließender Konsolidierung – Breakout wahrscheinlich." };
  else if (sma50 && sma20 > sma50 && closes[n - 5] < sma50 * 1.005)
    pattern = { name: "Golden Cross", signal: "BUY", strength: 88,
      horizon: "Langfristig", weeks: "8–16 Wochen",
      desc: "50-Tage-MA kreuzt 200-Tage-MA – starkes Trendfolgesignal." };
  else if (avg2 > avg1 * 1.05 && cur < Math.max(...recent) * 1.01 && cur > Math.max(...recent) * 0.96)
    pattern = { name: "Bull Flag", signal: "BUY", strength: 75,
      horizon: "Kurzfristig", weeks: "1–2 Wochen",
      desc: "Starker Anstieg mit kurzer Konsolidierung – Breakout erwartet." };
  else if (rsi < 32)
    pattern = { name: `Überverkauft (RSI ${rsi.toFixed(0)})`, signal: "BUY", strength: 70,
      horizon: "Kurzfristig", weeks: "1–3 Wochen",
      desc: `RSI bei ${rsi.toFixed(0)} – Gegenbewegung nach oben wahrscheinlich.` };
  else if (rsi > 72)
    pattern = { name: `Überkauft (RSI ${rsi.toFixed(0)})`, signal: "HOLD", strength: 65,
      horizon: "Abwarten", weeks: "1–2 Wochen warten",
      desc: `RSI bei ${rsi.toFixed(0)} – Aktie überhitzt, Rücksetzer möglich.` };
  else {
    const mid     = closes.slice(Math.floor(n / 2) - 3, Math.floor(n / 2) + 3);
    const midHigh = Math.max(...mid);
    if (midHigh > high1 * 1.03 && midHigh > high2 * 1.03 && cur < sma20)
      pattern = { name: "Head & Shoulders", signal: "SELL", strength: 77,
        horizon: "Kurzfristig", weeks: "1–3 Wochen",
        desc: "Drei Hochpunkte mit fallendem Mittelstück – Trendumkehr nach unten." };
    else
      pattern = { name: "Seitwärtsphase", signal: "HOLD", strength: 55,
        horizon: "Abwarten", weeks: "Kein klares Setup",
        desc: "Kein eindeutiges Muster – auf Signal warten." };
  }

  const target   = pattern.signal === "BUY" ? resistance * 1.04 : support * 0.96;
  const stopLoss = pattern.signal === "BUY"
    ? Math.max(support * 0.985, cur - atr * 2.5)
    : Math.min(resistance * 1.015, cur + atr * 2.5);
  const upside   = ((target - cur) / cur * 100).toFixed(1);
  const risk     = (Math.abs(cur - stopLoss) / cur * 100).toFixed(1);
  const rr       = (Math.abs(parseFloat(upside)) / Math.abs(parseFloat(risk))).toFixed(1);

  return { ...pattern, support, resistance, target, stopLoss, upside, risk, rr, rsi: rsi.toFixed(0) };
}

// ── KI ANALYSE ────────────────────────────────────────────────────────────────
async function getAIAnalysis(quote, pattern) {
  const prompt = `Du bist ein Aktienanalyst. Analysiere ${quote.name} (${quote.symbol}) auf Deutsch.

Daten:
- Kurs: ${quote.price.toFixed(2)} ${quote.currency}
- Tagesveränderung: ${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)} (${quote.pct.toFixed(2)}%)
- 52W: ${quote.low52?.toFixed(2)} – ${quote.high52?.toFixed(2)}
- Muster: ${pattern.name} (${pattern.desc})
- RSI: ${pattern.rsi}
- Signal: ${pattern.signal} | Konfidenz: ${pattern.strength}%
- Horizont: ${pattern.horizon} (${pattern.weeks})
- Preisziel: ${pattern.target.toFixed(2)} (${pattern.upside}%)
- Stop-Loss: ${pattern.stopLoss.toFixed(2)} (-${pattern.risk}%)
- Chance/Risiko: ${pattern.rr}:1

Schreibe eine kurze, präzise Analyse (max 200 Wörter) mit:
1. Warum ${pattern.signal === "BUY" ? "KAUF" : pattern.signal === "SELL" ? "VERKAUF" : "HALTEN"} jetzt? (1-2 Sätze, konkrete Zahlen)
2. Trade-Setup: Entry / Ziel / Stop in einer Zeile
3. Hauptrisiko: ein konkreter Punkt
Kein Marketing, direkte Sprache.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001", // günstigstes Modell für Batch-Analyse
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || "Analyse nicht verfügbar.";
}

// ── HTML MAIL BUILDER ─────────────────────────────────────────────────────────
function buildEmailHTML(signals, date) {
  const buySignals  = signals.filter(s => s.pattern.signal === "BUY");
  const sellSignals = signals.filter(s => s.pattern.signal === "SELL");
  const holdSignals = signals.filter(s => s.pattern.signal === "HOLD");

  const signalBlock = (s) => {
    const isBuy  = s.pattern.signal === "BUY";
    const isSell = s.pattern.signal === "SELL";
    const color  = isBuy ? "#00e676" : isSell ? "#ff4757" : "#ffc107";
    const bg     = isBuy ? "#071a0f" : isSell ? "#1a0a0a" : "#1a1400";
    const isUp   = s.quote.pct >= 0;

    return `
    <div style="background:${bg};border:1px solid ${color}33;border-left:3px solid ${color};
      border-radius:8px;padding:16px 20px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
        <div>
          <span style="font-family:monospace;font-size:18px;font-weight:700;color:#dce8f5;">${s.quote.symbol}</span>
          <span style="font-size:12px;color:#7a95b5;margin-left:8px;">${s.quote.name}</span>
        </div>
        <div style="text-align:right;">
          <div style="font-family:monospace;font-size:16px;font-weight:700;color:#dce8f5;">
            ${s.quote.price.toFixed(2)} ${s.quote.currency}
          </div>
          <div style="font-family:monospace;font-size:11px;color:${isUp ? "#00e676" : "#ff4757"};">
            ${isUp ? "▲" : "▼"} ${Math.abs(s.quote.pct).toFixed(2)}%
          </div>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <span style="background:${color}22;border:1px solid ${color};color:${color};
          font-family:monospace;font-size:12px;font-weight:700;padding:2px 10px;border-radius:4px;letter-spacing:2px;">
          ${s.pattern.signal}
        </span>
        <span style="background:#ffffff11;color:#7a95b5;font-family:monospace;
          font-size:11px;padding:2px 10px;border-radius:4px;">
          ${s.pattern.name}
        </span>
        <span style="background:#ffffff11;color:#7a95b5;font-family:monospace;
          font-size:11px;padding:2px 10px;border-radius:4px;">
          ${s.pattern.strength}% Konfidenz
        </span>
        <span style="background:#448aff22;color:#448aff;font-family:monospace;
          font-size:11px;padding:2px 10px;border-radius:4px;">
          ${s.pattern.horizon} · ${s.pattern.weeks}
        </span>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:12px;">
        <div style="background:#ffffff08;border-radius:5px;padding:8px 10px;">
          <div style="font-size:9px;color:#4a6080;letter-spacing:1px;margin-bottom:3px;">PREISZIEL</div>
          <div style="font-family:monospace;font-size:13px;font-weight:700;color:#00e676;">
            ${s.pattern.target.toFixed(2)}</div>
          <div style="font-family:monospace;font-size:10px;color:#4a6080;">+${s.pattern.upside}%</div>
        </div>
        <div style="background:#ffffff08;border-radius:5px;padding:8px 10px;">
          <div style="font-size:9px;color:#4a6080;letter-spacing:1px;margin-bottom:3px;">STOP-LOSS</div>
          <div style="font-family:monospace;font-size:13px;font-weight:700;color:#ff4757;">
            ${s.pattern.stopLoss.toFixed(2)}</div>
          <div style="font-family:monospace;font-size:10px;color:#4a6080;">-${s.pattern.risk}%</div>
        </div>
        <div style="background:#ffffff08;border-radius:5px;padding:8px 10px;">
          <div style="font-size:9px;color:#4a6080;letter-spacing:1px;margin-bottom:3px;">R/R RATIO</div>
          <div style="font-family:monospace;font-size:13px;font-weight:700;
            color:${parseFloat(s.pattern.rr) >= 2 ? "#00e676" : parseFloat(s.pattern.rr) >= 1.2 ? "#ffc107" : "#ff4757"};">
            ${s.pattern.rr}:1</div>
        </div>
        <div style="background:#ffffff08;border-radius:5px;padding:8px 10px;">
          <div style="font-size:9px;color:#4a6080;letter-spacing:1px;margin-bottom:3px;">RSI</div>
          <div style="font-family:monospace;font-size:13px;font-weight:700;
            color:${s.pattern.rsi > 70 ? "#ff4757" : s.pattern.rsi < 30 ? "#00e676" : "#dce8f5"};">
            ${s.pattern.rsi}</div>
        </div>
      </div>

      <div style="background:#ffffff06;border-radius:5px;padding:10px 12px;
        font-size:12px;color:#94afc8;line-height:1.7;font-family:'Helvetica Neue',Arial,sans-serif;">
        ${s.analysis.replace(/\n/g, "<br/>")}
      </div>
    </div>`;
  };

  const section = (title, color, items) => items.length === 0 ? "" : `
    <div style="margin-bottom:24px;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:3px;color:${color};
        border-bottom:1px solid ${color}44;padding-bottom:8px;margin-bottom:12px;">
        ${title} (${items.length})
      </div>
      ${items.map(signalBlock).join("")}
    </div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#07090d;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:620px;margin:0 auto;padding:24px 16px;">

  <!-- HEADER -->
  <div style="background:#0e1117;border:1px solid #1c2333;border-radius:10px 10px 0 0;
    padding:20px 24px;margin-bottom:1px;">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-family:monospace;font-size:18px;font-weight:700;color:#dce8f5;letter-spacing:2px;">
          ◈ STOCKSENSE
        </div>
        <div style="font-family:monospace;font-size:11px;color:#4a6080;margin-top:3px;letter-spacing:1px;">
          TÄGLICHER MARKT-REPORT
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-family:monospace;font-size:12px;color:#7a95b5;">${date}</div>
        <div style="font-family:monospace;font-size:10px;color:#4a6080;margin-top:2px;">08:30 Uhr Berlin</div>
      </div>
    </div>
  </div>

  <!-- SUMMARY BAR -->
  <div style="background:#0d1117;border:1px solid #1c2333;border-top:none;
    padding:14px 24px;margin-bottom:20px;display:flex;gap:20px;border-radius:0 0 10px 10px;">
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="width:8px;height:8px;border-radius:50%;background:#00e676;display:inline-block;"></span>
      <span style="font-family:monospace;font-size:13px;color:#00e676;font-weight:700;">${buySignals.length} KAUF</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="width:8px;height:8px;border-radius:50%;background:#ff4757;display:inline-block;"></span>
      <span style="font-family:monospace;font-size:13px;color:#ff4757;font-weight:700;">${sellSignals.length} VERKAUF</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="width:8px;height:8px;border-radius:50%;background:#ffc107;display:inline-block;"></span>
      <span style="font-family:monospace;font-size:13px;color:#ffc107;font-weight:700;">${holdSignals.length} HALTEN</span>
    </div>
    <div style="margin-left:auto;font-family:monospace;font-size:10px;color:#4a6080;">
      ${signals.length} Aktien analysiert
    </div>
  </div>

  <!-- SIGNALS -->
  ${section("🟢 KAUF-SIGNALE", "#00e676", buySignals)}
  ${section("🔴 VERKAUF-SIGNALE", "#ff4757", sellSignals)}
  ${section("🟡 HALTEN", "#ffc107", holdSignals)}

  <!-- DISCLAIMER -->
  <div style="background:#080a0e;border:1px solid #1c2333;border-radius:7px;
    padding:12px 16px;margin-top:8px;">
    <div style="font-family:monospace;font-size:10px;color:#3a4e64;line-height:1.7;">
      ⚠ KEINE ANLAGEBERATUNG – Dieser Report dient ausschließlich zu Informationszwecken.
      Investitionen in Aktien sind mit erheblichen Risiken verbunden.
      Kurse können 15-20 Min. verzögert sein. Vergangene Muster garantieren keine zukünftigen Ergebnisse.
    </div>
  </div>

  <div style="text-align:center;margin-top:14px;">
    <div style="font-family:monospace;font-size:10px;color:#2a3a50;letter-spacing:2px;">
      STOCKSENSE · KI-GESTÜTZTE MARKTANALYSE · AUTOMATISCHER REPORT
    </div>
  </div>
</div>
</body></html>`;
}

// ── MAIL SENDEN ───────────────────────────────────────────────────────────────
async function sendMail(html, signals, date) {
  const buyCount  = signals.filter(s => s.pattern.signal === "BUY").length;
  const sellCount = signals.filter(s => s.pattern.signal === "SELL").length;

  const subject = buyCount > 0 || sellCount > 0
    ? `🚨 StockSense ${date}: ${buyCount > 0 ? `${buyCount}x KAUF` : ""}${buyCount > 0 && sellCount > 0 ? " · " : ""}${sellCount > 0 ? `${sellCount}x VERKAUF` : ""} – Signale erkannt`
    : `📊 StockSense ${date}: Kein klares Signal heute`;

  // Nodemailer mit Hotmail/Outlook SMTP
  const transporter = createTransport({
    host: "smtp-mail.outlook.com",
    port: 587,
    secure: false,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: `"StockSense" <${EMAIL_USER}>`,
    to: EMAIL_TO,
    subject,
    html,
  });

  console.log(`✅ Mail gesendet: ${subject}`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 StockSense Daily Analysis gestartet...");

  const tickers = loadWatchlist();
  console.log(`📋 Watchlist: ${tickers.join(", ")}`);

  const date = new Date().toLocaleDateString("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit", month: "2-digit", year: "numeric"
  });

  const results = [];

  for (const ticker of tickers) {
    try {
      console.log(`  Analysiere ${ticker}...`);

      const quote   = await fetchQuote(ticker);
      const pattern = detectPattern(quote.closes, quote.highs, quote.lows);

      // Nur bei ausreichender Konfidenz und nicht HOLD mit niedriger Konfidenz
      if (pattern.strength < MIN_CONFIDENCE && pattern.signal === "HOLD") {
        console.log(`  ⏭ ${ticker}: HOLD mit ${pattern.strength}% – übersprungen`);
        continue;
      }

      console.log(`  📊 ${ticker}: ${pattern.signal} (${pattern.strength}%) – ${pattern.name}`);

      const analysis = await getAIAnalysis(quote, pattern);

      results.push({ quote, pattern, analysis });

      // Kurz warten um API-Limits zu respektieren
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`  ❌ ${ticker} Fehler: ${err.message}`);
    }
  }

  if (results.length === 0) {
    console.log("⚠ Keine Ergebnisse – Mail nicht gesendet");
    return;
  }

  console.log(`\n📧 Sende Mail mit ${results.length} Analysen...`);
  const html = buildEmailHTML(results, date);
  await sendMail(html, results, date);

  console.log("✅ Fertig!");
}

main().catch(err => {
  console.error("❌ Kritischer Fehler:", err);
  process.exit(1);
});
