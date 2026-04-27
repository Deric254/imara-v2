# IMARA LINKS - Local Desktop Application

A complete business management system for inventory, invoicing, production tracking, and financial reconciliation. Now running locally with SQLite and packaged as a desktop application.

## Features

✅ **Completely Local** - Runs entirely on your computer  
✅ **SQLite Database** - No cloud dependencies  
✅ **Desktop App** - Click-to-launch from Start Menu or Desktop  
✅ **Auto-Updates** - Updates deploy automatically from GitHub  
✅ **Offline-First** - Works without internet  
✅ **Professional UI** - Intuitive, responsive interface  
✅ **Full Features** - Invoicing, inventory, production, reconciliation, reports

## Installation

### Option 1: Install Pre-Built Application (Recommended)

1. Download `IMARA-LINKS-Setup-2.0.0.exe` from [Releases](https://github.com/Deric254/imara/releases)
2. Run the installer
3. Click "Install" and wait for completion
4. A desktop shortcut will be created automatically
5. Launch from Start Menu → "IMARA LINKS"

**Default Credentials:**
- Username: `owner`
- Password: `owner1234`
- ⚠️ **Change password on first login!**

### Option 2: Development Setup

Requirements:
- Node.js v16+ (Download from [nodejs.org](https://nodejs.org))
- Git

Steps:

```powershell
# Clone the repository
git clone https://github.com/Deric254/imara.git
cd imara

# Install dependencies
npm install

# Start development server
npm run electron-dev

# To build installer
npm run build
```

## Database

- **Type:** SQLite3
- **Location:** `C:\Users\[YourUsername]\.imara\imara.db`
- **Automatic Setup:** Database is created and initialized on first run
- **Backup:** Copy the `.imara` folder to backup your data

## GitHub Auto-Updates

The application checks for updates from GitHub automatically. When a new release is published:

1. App notifies you of available update
2. Download happens in background
3. Install on next app restart
4. No manual intervention needed

### Deploying Updates

To push updates:

```bash
# Make changes to code
git add .
git commit -m "Your changes"
git push origin main

# Create release with tag
git tag v2.0.1
git push origin v2.0.1

# GitHub Actions will automatically build and create release
```

## Usage

### Dashboard
- View business overview
- Quick statistics
- Recent transactions

### Daily Entry
- Record material purchases
- Log production data
- Track sales

### Invoicing
- Create professional invoices
- Track payments
- Generate reports

### Inventory
- Manage stock levels
- Track piece types
- Monitor gauges

### Reconciliation
- Match transactions
- Verify calculations
- Generate financial reports

### Reports
- Daily summary
- Monthly statements
- Custom date ranges
- Export to PDF/CSV

## Troubleshooting

### App Won't Start
1. Check if port 9000 is not in use: `netstat -ano | findstr :9000`
2. Reinstall: Uninstall → Restart → Reinstall

### Database Issues
1. Backup: Copy `C:\Users\[YourUsername]\.imara` folder
2. Delete `imara.db`
3. Restart app (database auto-recreates)

### Update Not Working
1. Check internet connection
2. Manually download from Releases
3. Run installer over existing installation

## Security

✅ **Passwords:** Hashed with bcryptjs  
✅ **Tokens:** JWT-based authentication  
✅ **Database:** ACID transactions with SQLite  
✅ **CORS:** Configured for local access only  
✅ **Rate Limiting:** Protects against brute force  

⚠️ **Important:** 
- Change default owner password immediately
- Do not share your `imara.db` file
- Backup regularly to external storage

## Technical Stack

- **Frontend:** HTML5, CSS3, Vanilla JavaScript
- **Backend:** Node.js + Express.js
- **Database:** SQLite3
- **Desktop:** Electron + Electron Builder
- **Auth:** JWT + bcryptjs
- **Updates:** Electron Updater

## Project Structure

```
imara/
├── electron-main.js          # Electron app entry point
├── preload.js                # Secure IPC bridge
├── backend/
│   ├── server.js             # Express server
│   ├── db/
│   │   ├── sqlite-schema.js  # SQLite database setup
│   │   └── fixes.sql         # Database migrations
│   ├── middleware/           # Authentication & transactions
│   ├── routes/               # API endpoints
│   └── package.json
├── frontend/
│   ├── index.html
│   ├── login.html
│   ├── dashboard.html
│   ├── invoices.html
│   ├── inventory.html
│   ├── daily.html
│   ├── reports.html
│   ├── reconciliation.html
│   ├── users.html
│   ├── shared.js             # Frontend utilities
│   └── shared.css
└── .github/workflows/        # Auto-build & release
```

## Development

### Running Locally

```powershell
npm install
npm run electron-dev
```

This starts:
- Backend server on `http://localhost:9000`
- Electron app with DevTools open
- SQLite database at `~/.imara/imara.db`

### Building Installer

```powershell
npm run build
```

Output: `dist/IMARA-LINKS-Setup-2.0.0.exe`

### Testing Changes

1. Make code changes
2. Reload DevTools (Ctrl+R) for frontend
3. Restart app for backend changes
4. Check `Console` and `Network` tabs in DevTools

## Support & Contribution

- **Issues:** Report bugs on GitHub Issues
- **Contributions:** Fork → Branch → PR
- **Documentation:** See [GitHub Wiki](https://github.com/Deric254/imara/wiki)

## License

MIT License - See LICENSE file

## Version History

### v2.0.0 (Current)
✅ Converted to local SQLite database  
✅ Desktop app with Electron  
✅ Auto-update system  
✅ Improved UI/UX  

### v1.0.1 (Previous)
- Neon PostgreSQL cloud version

---

**Made with ❤️ for IMARA LINKS**
