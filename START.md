# IMARA LINKS — How to Run

## Two ways to run

| Mode | Command | Use for |
|------|---------|---------|
| **Electron app** | `npm run electron-dev` | Normal daily use — opens a desktop window |
| **Backend only** | `cd backend && npm start` | API-only / headless / testing |

---

## Prerequisites

- **Node.js 18+** — download from https://nodejs.org (LTS version)
- **Windows** — the Electron desktop app targets Windows; backend-only works on any OS

Check your version:
```
node --version    # should print v18.x.x or higher
npm --version
```

---

## First-time setup

```bash
# 1. Enter the project folder
cd imara-fixed          # (or wherever you unzipped it)

# 2. Install all dependencies (takes ~1 min, only needed once)
cd backend
npm install
cd ..

# 3. Start the Electron desktop app
cd backend
npm run electron-dev
```

That's it. On first launch the app will:
- Create the database file at `C:\Users\<you>\.imara\imara.db`
- Create all tables automatically
- Seed one default owner account

**Default login credentials:**
```
Username:  owner
Password:  owner1234
```
Change this password immediately after first login (top-right menu → Change Password).

---

## Running backend-only (no desktop window)

Useful if you want to access the app from a browser or test API calls:

```bash
cd backend
npm start
```

Then open your browser at: **http://localhost:3001**

Health check: http://localhost:3001/health should return `{"status":"ok"}`

---

## Electron mode — what's happening under the hood

When you run `npm run electron-dev`, the Electron process:
1. Loads `.env` from the project root
2. Initialises the SQLite database (`~/.imara/imara.db`)
3. Starts an embedded Express server on **port 9000**
4. Opens a desktop window pointing to `http://localhost:9000`

All API calls go to `http://localhost:9000/api/...`

---

## Port reference

| Mode | Frontend | API |
|------|----------|-----|
| Electron | http://localhost:9000 | http://localhost:9000/api |
| Backend-only | http://localhost:3001 | http://localhost:3001/api |

---

## Environment variables (`.env`)

The `.env` file lives in the project root. Key settings:

| Variable | Default | Notes |
|----------|---------|-------|
| `DATABASE_TYPE` | `local` | `local` = SQLite, `neon` = PostgreSQL |
| `JWT_SECRET` | (see file) | Change this before sharing with anyone |
| `NODE_ENV` | `development` | Set to `production` for release builds |

---

## Build a Windows installer

```bash
cd backend
npm run build
```

Output: `backend/dist/IMARA-LINKS-Setup-2.0.0.exe`

Share this `.exe` with users. They double-click it to install — no Node.js needed on their machine.

---

## Releasing a new version (GitHub auto-build)

```bash
git add .
git commit -m "release: v2.0.1 - description"
git tag v2.0.1
git push origin main --tags
```

GitHub Actions will automatically build the Windows installer and attach it to a GitHub Release. Users with the app installed will see an auto-update prompt.

---

## Troubleshooting

**"JWT_SECRET environment variable is required"**
→ The `.env` file is missing or not being loaded. Make sure `.env` exists in the project root (not inside `backend/`).

**"Cannot find module 'sqlite3'"**
→ Run `cd backend && npm install`

**White screen / blank window**
→ The backend didn't start in time. Wait 3 seconds and press `Ctrl+R` in the app window to reload, or check the terminal for error messages.

**Port 9000 already in use**
→ Another process is using port 9000. Kill it or restart your machine.

**Database errors on first run**
→ Delete `C:\Users\<you>\.imara\imara.db` and restart — it will be recreated fresh.

**App opens but login fails with "Internal server error"**
→ Check the terminal — look for a SQL error. If you see `no such column` or `syntax error`, the database migration may need to run. Delete the `.imara` folder and restart.

---

## File locations

```
Project root       — wherever you unzipped imara-fixed/
Database file      — C:\Users\<you>\.imara\imara.db
Logs               — printed to terminal during dev
Build output       — backend/dist/
```
