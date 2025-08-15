# Deploy to Railway (Node + Static)

> This uses Railway’s Nixpacks auto-detection for Node. No Dockerfile required. If you have an old Dockerfile from other experiments, delete or rename it so Railway doesn’t try to use it.

## 1) Push code to GitHub
- Create a new repo (e.g., `stablelens-v1`)
- Add the four files/folders above
- Commit + push

## 2) Create a Railway project
- In Railway, click **New Project → Deploy from GitHub** and select your repo
- Service should autodetect **Node** and set `npm start`
- Expose port: Railway injects `PORT`; server already reads it

## 3) Verify health
- Open the Railway URL → you should see the StableLens UI
- Check health: `https://<your-app>.railway.app/api/health` → `{ status: "ok" }`

## 4) Custom domain (stablelens.net)
- In Railway → your service → **Settings → Domains** → **Add Custom Domain** → `stablelens.net`
- Railway will show a CNAME target
- In your DNS provider (where `stablelens.net` is managed):
  - Create a **CNAME** for `@` (root) **or** for `www` to Railway’s target
  - If pointing root, use an ALIAS/ANAME if supported; otherwise point `www` and set a redirect from root to `www`
- Wait for DNS to propagate, then click **Verify** in Railway

## 5) Observability
- Use Railway **Logs** for server output
- Endpoints to verify:
  - `/api/prices`
  - `/api/stablecoins/chain?chain=Ethereum`
  - `/api/stablecoins/chain?chain=Tron`
  - `/api/yields/sdai`
  - `/api/news`

## Notes
- Node >=18 is required (we set it in `package.json` `engines`)
- The server has retries + caching so the UI remains responsive even if a free API blips
- Plug-points for paid providers can be added behind feature flags/env vars later without touching the UI
