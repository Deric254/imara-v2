# Auto-Updates & Backwards Compatibility Guide

## How Auto-Updates Work

When users have IMARA LINKS running, the app **automatically checks for updates every 4 hours** in the background.

### What Users See:
1. **Update available** → Notification appears (can be dismissed)
2. **User clicks "Install Update"** → Download starts silently
3. **Update ready** → Another notification
4. **User quits app** → Update installs automatically on next launch

---

## Publishing Updates

### Step 1: Make your code changes
```bash
# Edit code, test locally, commit to Git
git add .
git commit -m "Fix: bug description"
git push origin main
```

### Step 2: Update version number
Edit `package.json`:
```json
{
  "version": "2.0.1"
}
```

### Step 3: Create a GitHub Release
1. Go to your GitHub repo → **Releases**
2. Click **"Create a new release"**
3. Tag: `v2.0.1` (must match package.json)
4. Title: `Version 2.0.1 - Bug fixes`
5. Upload the `.exe` from `dist/` folder
6. Publish

### Step 4: Users get the update automatically
- On next check (max 4 hours), users download and install
- App keeps working with old data — **nothing breaks**

---

## Backwards Compatibility Strategy

### Rule 1: No Breaking Changes in the Database

When you update the app, **never delete or rename database columns**. Only add new ones.

### Good: ✅
```javascript
// Migration 003 - Adding new feature
{
  id: '003-add-subscription-level',
  version: '2.5.0',
  async up(db) {
    await db.exec(`
      ALTER TABLE users 
      ADD COLUMN subscription_level TEXT DEFAULT 'free'
    `);
  }
}
```

### Bad: ❌
```javascript
// DON'T DO THIS — breaks old data
await db.exec("ALTER TABLE users DROP COLUMN old_field");
await db.exec("ALTER TABLE users RENAME COLUMN name TO full_name");
```

---

## Adding a New Feature with Migration

### Example: Add reporting dates to invoices

**1. The Migration (in `backend/db/migrations.js`):**
```javascript
const MIGRATIONS = [
  // ... existing migrations ...
  {
    id: '004-add-reporting-dates',
    version: '2.1.0',
    description: 'Add quarterly reporting fields',
    async up(db) {
      try {
        const columns = await db.prepare(
          "PRAGMA table_info(invoices)"
        ).all();
        
        const hasReportingDate = columns.some(c => c.name === 'reporting_period');
        if (!hasReportingDate) {
          await db.exec(`
            ALTER TABLE invoices 
            ADD COLUMN reporting_period TEXT DEFAULT 'Q1'
          `);
        }
      } catch (err) {
        console.warn('Migration might already be applied:', err?.message);
      }
    },
  },
];
```

**2. Update your code (e.g., in routes) to use the new field:**
```javascript
// /routes/invoices.js
const reportingPeriod = req.body.reporting_period || 'Q1';
await db.prepare(`
  INSERT INTO invoices(..., reporting_period)
  VALUES(..., ?)
`).run(..., reportingPeriod);
```

**3. Update version in `package.json`:**
```json
"version": "2.1.0"
```

**4. Test locally:**
```bash
npm run electron-dev
# App should run migrations automatically
# Check: database still works ✅
```

**5. Build and release:**
```bash
npm run build:win
# Upload dist/IMARA-LINKS*.exe to GitHub Releases
```

---

## How Users Won't Lose Data

### Migration System:
- ✅ Tracks which migrations have been run
- ✅ Only applies new migrations
- ✅ Old users upgrading from v1.0 → v2.5 will get ALL migrations applied (001, 002, 003...)
- ✅ Reports success/failure in console

### Database Location:
- All user data lives in: `C:\Users\<username>\.imara\imara.db`
- **Not deleted during update** ← This is critical
- Survives app uninstall (manual deletion needed)

### Backup Strategy:
- Users should manually backup this file before major version jumps
- Or: implement automatic backup during update (optional)

---

## Troubleshooting Failed Updates

### User hasn't received update after 4 hours?
- Check GitHub Releases page — is the new `.exe` there?
- Verify the tag matches `package.json` version
- Restart app to force update check

### "Migration failed" error at startup?
- Check `backend/db/migrations.js` for syntax errors
- Test migration locally: `npm run electron-dev`
- Roll back if critical — users can downgrade by re-running old installer

### Data looks wrong after update?
- Check `schema_migrations` table to see what ran
- Migration code may have a bug — fix and release new version
- Older users re-running the app will not re-apply migrations

---

## Summary for Non-Technical Users

When you publish a new version:
1. Users get notified (they can ignore it)
2. Update downloads silently in background
3. Next time they open app, it updates automatically
4. All their data stays — nothing is lost
5. Everything works like before, just with new features

**That's it!** You handle the code, the system handles the rest.
