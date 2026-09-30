# School E‑Voting MVP

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and set a strong `ADMIN_PASSWORD` and `SESSION_SECRET`.
3. Install dependencies: `npm install`
4. Start: `npm start`
5. Student portal: `http://localhost:3000/`
6. Admin portal: `http://localhost:3000/?admin=1`

## First setup
Create positions, candidates and student accounts from the admin dashboard. Keep the election closed while setting up. Open it only when ready.

## Important
This is an MVP for private school elections. Before a real election, have the school review identity verification, hosting, backups, access control, privacy, audit procedures and independent security testing. Do not use the demo admin password in production.
