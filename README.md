# StockSense Daily Alerts

Automatische tägliche Aktienanalyse per Mail – läuft kostenlos via GitHub Actions.

## Setup (einmalig, ~10 Minuten)

### 1. GitHub Repository erstellen
- github.com → "New repository" → Name: `stocksense-alerts`
- Alle Dateien hochladen (diesen Ordner)

### 2. Secrets hinterlegen
GitHub → dein Repo → Settings → Secrets and variables → Actions → New repository secret

| Secret Name | Wert |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` (von console.anthropic.com) |
| `EMAIL_USER` | `coolthegangster@hotmail.de` |
| `EMAIL_PASS` | App-Passwort von Outlook (siehe unten) |
| `EMAIL_TO` | `krukrukakawe@proton.me` |

### 3. Outlook App-Passwort erstellen
- account.microsoft.com → Sicherheit → Erweiterte Sicherheitsoptionen
- "App-Kennwörter" → Neues App-Kennwort erstellen
- Dieses Passwort (nicht dein normales!) als EMAIL_PASS eintragen

### 4. Watchlist anpassen
Datei `watchlist.txt` bearbeiten – eine Aktie pro Zeile:
```
AAPL
NVDA
SAP.DE
```

### 5. Testen
GitHub → Actions → "StockSense Daily Alert" → "Run workflow"
→ Du solltest eine Mail bekommen!

## Automatischer Ablauf
- Läuft Mo–Fr um 08:30 Uhr (Berlin)
- Analysiert alle Aktien in watchlist.txt
- Sendet Mail mit allen Signalen
- Kostet ca. $0.01–0.03 pro Tag (Anthropic API)
