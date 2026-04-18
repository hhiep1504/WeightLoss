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

### If You Want Cloud Sync On GitHub Domain

Add these repository secrets before deploying:

1. Go to Settings -> Secrets and variables -> Actions.
2. Create secret `VITE_SUPABASE_URL` with your Supabase project URL.
3. Create secret `VITE_SUPABASE_ANON_KEY` with your Supabase anon key.

The workflow injects these values only at build time on GitHub Actions.

### Supabase Auth Redirect For GitHub Pages

If local works but GitHub Pages login fails, set these in Supabase:

1. Supabase Dashboard -> Authentication -> URL Configuration.
2. Set Site URL to your GitHub Pages URL.
3. Add Redirect URLs:
	- `https://<username>.github.io/<repo>/`
	- `https://<username>.github.io/<repo>`

Then run a new deploy (push a commit) so the latest build uses your secrets.

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

## Apple Health Steps Auto Sync (iPhone Shortcut)

Web apps cannot read Apple Health directly. The practical free solution is:

1. iPhone Shortcut reads Steps from Apple Health.
2. Shortcut sends a POST request to a Supabase Edge Function.
3. Function updates `entries.steps` for that date.

### 1) Deploy edge function

File is already included at [supabase/functions/ingest-apple-steps/index.ts](supabase/functions/ingest-apple-steps/index.ts).

Deploy with Supabase CLI:

```bash
supabase functions deploy ingest-apple-steps
```

Function endpoint format:

```text
https://<project-ref>.supabase.co/functions/v1/ingest-apple-steps
```

### 2) Run schema update and create ingest token

Run [supabase/schema.sql](supabase/schema.sql), then create your personal token:

```sql
insert into public.step_ingest_tokens (user_id, token, is_active)
values ('<your-auth-user-id>', '<your-long-random-token>', true)
on conflict (user_id)
do update set
	token = excluded.token,
	is_active = excluded.is_active,
	updated_at = now();
```

How to get `<your-auth-user-id>`:

- In Supabase SQL editor: `select id, email from auth.users order by created_at desc;`

### 3) Build iPhone Shortcut

Recommended Shortcut flow:

1. `Find Health Samples` (Type: Steps, Start Date: Today, End Date: Today)
2. `Calculate Statistics` (Sum)
3. `Format Date` as `yyyy-MM-dd`
4. `Get Contents of URL`
	 - URL: your function URL
	 - Method: `POST`
	 - Headers:
		 - `Content-Type: application/json`
		 - `x-ingest-token: <your-long-random-token>`
	 - JSON Body:
		 - `date`: formatted date (yyyy-MM-dd)
		 - `steps`: summed steps number

The endpoint now accepts both `yyyy-MM-dd` and `dd/MM/yyyy` date formats.

Schedule this Shortcut daily (for example 23:59).

### Important behavior

- This endpoint updates steps for an existing weight entry date.
- If that date has no weight row yet, API returns 409: add weight first, then sync steps.
