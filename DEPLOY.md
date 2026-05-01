# SpellCast – Railway Deployment Guide

## First Deploy

1. Go to **railway.app** → New Project → Deploy from GitHub repo → select `fil756/spellcast`
2. Railway will auto-detect the Dockerfile and deploy

## ⚠️ IMPORTANT: Add a Persistent Volume (do this before first use!)

Without a volume, the SQLite database is wiped on every redeploy.

1. In your Railway project, click the **SpellCast service**
2. Go to **Settings → Volumes**
3. Click **Add Volume**
4. Set mount path to: `/data`
5. Click **Add** — Railway will redeploy automatically

That's it. All word lists, grades, and settings will now persist across deploys.

## Environment Variables (optional)

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Port (Railway sets this automatically) |
| `DATA_DIR` | `/data` | Where the SQLite DB is stored |
| `SESSION_SECRET` | (built-in) | Set a custom secret for extra security |

## Updating the App

Just push to GitHub — Railway auto-redeploys. Data on `/data` volume is preserved.
