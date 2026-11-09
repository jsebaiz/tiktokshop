# tiktokshop

Public site for jessebaizer.com, plus a desk at `/automatezynn3`.

The desk starts six Grok Bot agents (Fling, Cling, Sling, Bling, Pling, and Slack), lists their jobs, and browses allowlisted Drive folders. Slack is an agent name, not the Slack app. The live desk is public (`AUTOMATE_AUTH_MODE=public`). CSRF checks and server-side allowlists still apply. Agent sign-in and approvals still apply when a task needs them. A webhook response of 200 means a run was accepted, not that it finished.

Setup, environment variable names, and the six routine prompts are in [docs/SETUP.md](docs/SETUP.md).

```bash
npm install
npm test
npm run dev
```
