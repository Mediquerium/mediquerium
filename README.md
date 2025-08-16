# Mediquerium Registration (Admin + Email)

Features:
- Configurable dates & limits (`config.json`)
- Per-day and per-cohort caps
- Persistent storage (`data.json`)
- Admin dashboard at `/admin` (password from `config.json`)
- CSV export
- Email confirmations via SMTP (Nodemailer)
- Reset endpoint for testing (opt-in)

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```

## Admin dashboard
- Visit `http://localhost:3000/admin`
- Enter `adminPassword` from `config.json`
- Filter records and Export CSV

## Email confirmations
Edit `config.json` `smtp` section. For Gmail (use an App Password):
```json
"smtp": {
  "host": "smtp.gmail.com",
  "port": 587,
  "secure": false,
  "user": "youraddress@gmail.com",
  "pass": "your-app-password"
}
```
Restart the server. On successful registration an email is sent to the participant.

If SMTP not filled, emails are skipped and everything else still works.

## Reset during testing
Enable via env var:
```bash
ALLOW_RESET=true npm start
# then:
curl -X POST http://localhost:3000/api/reset
```

## Deploy
- Push to GitHub and deploy to any Node host (Render recommended)
- Build: `npm install`
- Start: `npm start`
- Optional env var on host: `ALLOW_RESET=true`
