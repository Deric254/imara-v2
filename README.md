# IMARA LINKS - Manual

IMARA LINKS is a local Windows desktop app for inventory, invoicing, production tracking, reconciliation, and reports.

## Give To A Customer

Use the installer in:

```text
dist\IMARA LINKS Setup 2.0.3.exe
```

That `.exe` is the only file you give to the customer.

Do not give customers the source ZIP, `node_modules`, `START.bat`, `SETUP-DEV.bat`, or `BUILD-INSTALLER.bat`.

## Build A Fresh Installer

Double-click:

```text
BUILD-INSTALLER.bat
```

After it finishes, the installer will be in:

```text
dist\
```

## Developer Setup

If you are running this source folder directly, run this once:

```text
SETUP-DEV.bat
```

Then start the app with:

```text
START.bat
```

Normal startup does not install dependencies. If dependencies are missing, `START.bat` tells you to run `SETUP-DEV.bat`.

## Startup Flow

When the app opens, it:

1. Finds a free local port.
2. Prepares the local SQLite database.
3. Loads local backend services.
4. Starts the local server.
5. Opens the desktop window.

The splash screen shows startup progress. If startup fails or takes too long, the app shows an error instead of waiting forever.

## First Login

Default login:

```text
Username: owner
Password: owner1234
```

Change this password immediately after first login.

## Database

The local database is stored at:

```text
C:\Users\<you>\.imara\imara.db
```

Back up the `.imara` folder regularly.
