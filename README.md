# Weight Loss Tracker Web App

A lightweight web app for daily weight tracking with trend insights and forecasting:

- Add daily weight entries.
- Store data in browser localStorage.
- Show quick stats: latest entry, ~7-day change, overall average, and 30-day estimate.
- Display a friendly line chart for actual data and a 7-day forecast.
- Export/Import JSON for manual backup and restore.

## JSON Backup & Restore

1. Open the Backup & Restore section in the app.
2. Click Export JSON to download a backup file.
3. Click Import JSON to restore entries from a backup file.

Note: Import will replace the current stored entries in this browser.

## Run Locally

Requirement: Node.js 18+.

```bash
npm install
npm run dev
```

Open the URL shown by Vite (usually http://localhost:5173).

## Build for Production

```bash
npm run build
npm run preview
```

## Deploy to GitHub Pages (via GitHub Actions)

1. Push the code to your GitHub repository.
2. Go to Settings -> Pages -> Build and deployment.
3. Set Source to GitHub Actions.
4. Every push to the main branch will automatically build and deploy.

Workflow file:

- .github/workflows/deploy.yml

## Optional Free Cloud Sync (Supabase)

This app supports free cloud sync so you can open it on different devices and keep the same data.

### 1) Create a free Supabase project

1. Create a project at https://supabase.com.
2. Open SQL Editor and run [supabase/schema.sql](supabase/schema.sql).

### 2) Add environment variables

Create a `.env` file in project root:

```bash
VITE_SUPABASE_URL=your_project_url
VITE_SUPABASE_ANON_KEY=your_anon_key
```

You can copy from [.env.example](.env.example).

### 3) Run app and sign in

1. Start app with `npm run dev`.
2. Use the Cloud Sync panel in-app.
3. Enter your email and request a magic login link.

Data remains local-first and syncs to cloud when signed in.
