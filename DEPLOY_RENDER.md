# Render Free Deployment Checklist

This is the first hosting path for the Company Board PWA. It is intended for a free public demo, not final production.

## What Render Will Run

- Runtime: Node
- Plan: Free
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`

These settings are defined in `render.yaml`.

## Steps

1. Create or open a GitHub account.
2. Create a new GitHub repository.
3. Push this project folder to that repository.
4. Create or open a Render account.
5. Click **New > Blueprint**.
6. Connect the GitHub repository.
7. Confirm the service named `company-board-pwa`.
8. Click **Apply**.
9. Wait for the deploy to finish.

## Links After Deploy

Replace `your-render-url` with the URL Render gives you.

- Employee portal: `https://your-render-url.onrender.com/employee`
- HR dashboard: `https://your-render-url.onrender.com/admin`

Employees can view the board directly. HR can open the dashboard directly for publishing and branding changes during the demo.

## Phone Install

On iPhone:

1. Open the employee board link in Safari.
2. Tap Share.
3. Tap **Add to Home Screen**.

On Android:

1. Open the employee board link in Chrome.
2. Tap the menu.
3. Tap **Add to Home screen** or **Install app**.

## Demo Limitations

- Free Render services can sleep after inactivity.
- Updates are stored in a local JSON file.
- Local JSON storage can reset on redeploy or instance replacement.
- The HR dashboard is open in this demo and must get real login before production use.
- Push notifications are not included yet.

## Production Upgrade After Approval

Move to:

- Real HR login
- Database-backed posts
- Audit log
- Custom company domain
- Push notifications for urgent alerts
- Employee groups or locations
- Backups and monitoring
