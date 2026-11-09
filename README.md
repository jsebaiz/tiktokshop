# tiktokshop

Public site for jessebaizer.com, plus a private desk at `/automate`.

The desk starts six Grok Bot agents (Fling, Cling, Sling, Bling, Pling, and Slack), lists their jobs, and browses allowlisted Drive folders. Slack is an agent name, not the Slack app. Sign-in and approvals still apply. A webhook response of 200 means a run was accepted, not that it finished.

Setup, environment variable names, and the six routine prompts are in [docs/SETUP.md](docs/SETUP.md).

```bash
npm install
npm test
npm run dev
```
