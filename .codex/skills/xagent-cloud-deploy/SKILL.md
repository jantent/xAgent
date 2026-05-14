---
name: xagent-cloud-deploy
description: Repository-local workflow for deploying xAgent dry_run to a cloud/VPS server. Use when the user asks to 上线到云端服务器, 部署到 VPS, 跑起来 dryRun, configure systemd, install Node/gmgn-cli, sync the repo to /opt/xagent, or set up SSH tunnel dashboard access for this repository.
---

# xagent-cloud-deploy

## Scope

Use this skill only for this repository. It covers first deployment or redeployment of xAgent to a cloud server for `dry_run`.

Default deployment layout:

- current SSH target: `xagent-vps` (`root@43.247.132.62`, public-key auth, `IPQoS none`)
- app dir: `/opt/xagent`
- env file: `/etc/xagent/xagent.env`
- runtime dir: `/opt/xagent/runtime`
- service user/group: `xagent`
- systemd unit: `xagent.service`
- API bind: `127.0.0.1:8787`
- config: `config/agent.yaml`
- dashboard access: SSH tunnel, not public Internet

For this repository's current cloud deployment, prefer the local SSH alias `xagent-vps`. It is configured for root public-key login and `IPQoS none`; do not ask the user for the server password unless the alias/key path is proven unavailable. If the user provides a different host/user/port, use that thread-provided target instead. Do not assume any cloud provider.

## Safety Rules

- Do not print secrets. Redact tokens, API keys, RPC query strings, wallet material, and Telegram bot tokens.
- Do not ask for or configure wallet private keys for dryRun deployment.
- Do not persist a new root SSH key unless the user explicitly approves that ongoing access after being told the risk.
- Keep API bound to loopback by default. Do not expose `:8787` publicly unless the user explicitly approves and `XAGENT_API_TOKEN` is configured.
- Do not sync local `runtime/`, `.env*`, `config/wallet.enc.json`, `node_modules/`, `dist/`, `dist-test/`, or `.git/` to the server.
- Treat remote `/opt/xagent/runtime` as stateful. Never delete it during redeploy unless the user explicitly asks to reset dryRun state.
- Before restarting an existing service, inspect status and recent logs.
- Never run live/canary commands or configure wallet secrets unless the user explicitly changes the deployment goal away from dryRun.

## Preflight

1. Read repository guidance:
   - `AGENTS.md`
   - `.codex/skills/xagent-dev-flow/SKILL.md`

2. Inspect local state:
   - `git status --short`
   - `package.json`
   - `config/agent.yaml`
   - if deploying current edits, tell the user what local modified files will be included.

3. Inspect remote host:
   - For the current deployment, run remote checks through `ssh xagent-vps '...'`.
   - `uname -a`
   - `cat /etc/os-release`
   - `command -v node npm git systemctl curl rsync`
   - `free -h`
   - `df -h /`
   - `ls -ld /opt /opt/xagent /etc/xagent 2>/dev/null || true`

Expected remote baseline:

- Ubuntu 22.04/24.04 is preferred.
- Node.js must be 20+.
- systemd must be available.
- 1C/1G can run dryRun with swap, but 2G memory is preferred.

## Remote Dependencies

If Node is missing or below 20, install Node 20 from a public source such as NodeSource:

```bash
apt-get update
apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
apt-get install -y nodejs
node -v
npm -v
```

Install `gmgn-cli` globally from public npm:

```bash
npm install -g gmgn-cli --registry=https://registry.npmjs.org
gmgn-cli --version
```

If `npm ci` fails because `package-lock.json` contains private/internal tarball URLs, use the public registry without rewriting the repo:

```bash
cd /opt/xagent
rm -rf node_modules
npm install --no-package-lock --registry=https://registry.npmjs.org
```

Record this as a deployment workaround.

## Sync Source

Create directories:

```bash
mkdir -p /opt/xagent /opt/xagent/runtime /etc/xagent
chmod 750 /etc/xagent
```

Sync from local repo with exclusions:

```bash
rsync -az --delete \
  --no-owner --no-group \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude dist-test \
  --exclude runtime \
  --exclude .env \
  --exclude '.env.*' \
  --exclude 'config/wallet.enc.json' \
  -e ssh \
  ./ xagent-vps:/opt/xagent/
```

Use `-n --itemize-changes` first when redeploying an existing server:

```bash
rsync -azn --delete --itemize-changes \
  --no-owner --no-group \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude dist-test \
  --exclude runtime \
  --exclude .env \
  --exclude '.env.*' \
  --exclude 'config/wallet.enc.json' \
  -e ssh \
  ./ xagent-vps:/opt/xagent/
```

For a one-off non-default host, replace `xagent-vps:/opt/xagent/` with `root@HOST:/opt/xagent/` and add any needed SSH options explicitly.

After sync:

```bash
chown -R root:root /opt/xagent
mkdir -p /opt/xagent/runtime
```

## Environment File

Create a restricted env file. Generate `XAGENT_API_TOKEN` on the server if the user has not provided one:

```bash
umask 077
printf 'NODE_ENV=production\nAPI_HOST=127.0.0.1\nPORT=8787\nXAGENT_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > /etc/xagent/xagent.env
```

DryRun recommended keys:

```bash
GMGN_API_KEY=
ANTHROPIC_AUTH_TOKEN=
SOL_PRICE_USD=
PRIMARY_RPC_URL=
HELIUS_RPC_URL=
TG_BOT_TOKEN=
TG_CHAT_ID=
```

Do not require all keys for first boot. The minimum first boot can run with only `XAGENT_API_TOKEN`, but meaningful dryRun should add GMGN, LLM, SOL price, and RPC.

Set permissions:

```bash
id xagent >/dev/null 2>&1 || useradd --system --home /opt/xagent --shell /usr/sbin/nologin xagent
chown root:xagent /etc/xagent /etc/xagent/xagent.env
chmod 750 /etc/xagent
chmod 640 /etc/xagent/xagent.env
chown -R xagent:xagent /opt/xagent/runtime
```

When testing CLI tools from a shell, export env values:

```bash
set -a
source /etc/xagent/xagent.env
set +a
```

## Build And Smoke Test

On first deployment, before systemd is running, smoke test on the server:

```bash
cd /opt/xagent
npm run check
npm run build
runuser -u xagent -- /bin/bash -lc 'cd /opt/xagent && set -a; source /etc/xagent/xagent.env; set +a; npm run start:once'
```

Expected smoke result:

- boot succeeds
- `execution.mode=dry_run`
- wallet secret missing warning is acceptable in dryRun
- GMGN warning is acceptable only before `GMGN_API_KEY` is configured
- no state persistence failure
- no service crash

If `xagent.service` is already active, do not run `start:once` concurrently because the running service already holds the runtime lock. For redeploy/update of an existing server:

```bash
ssh xagent-vps 'systemctl is-active xagent.service'
ssh xagent-vps 'cd /opt/xagent && npm run check && npm run build'
ssh xagent-vps 'systemctl restart xagent.service'
```

Then use the post-deploy verification below.

## Systemd Service

Install unit:

```ini
[Unit]
Description=xAgent dry_run service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=xagent
Group=xagent
WorkingDirectory=/opt/xagent
EnvironmentFile=/etc/xagent/xagent.env
ExecStart=/usr/bin/node /opt/xagent/dist/index.js
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/xagent/runtime

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now xagent.service
systemctl --no-pager --full status xagent.service
```

## Post-Deploy Verification

Use the `xagent-cloud-health-check` skill after deployment. Minimum verification:

```bash
systemctl is-active xagent.service
ss -ltnp | grep 8787
source /etc/xagent/xagent.env
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/status -H "Authorization: Bearer $XAGENT_API_TOKEN"
```

When testing external CLI tools such as `gmgn-cli` from the shell, use `set -a` before sourcing so variables are exported to child processes.

Expected:

- service `active`
- API bound to `127.0.0.1:8787`
- `/health` returns `ok:true`
- `/status` with token returns `execution.mode=dry_run`
- `orchestratorRunning=true`
- `pendingActions=0`

When all real keys are configured:

- RPC primary/backup should be real and `ok=true`
- `dataProviders.hasPrimaryProvider=true`
- `gmgn.ok=true`
- Telegram test message should send successfully if configured

## Dashboard Access

Give the user this command:

```bash
ssh -L 8787:127.0.0.1:8787 xagent-vps
```

Then open:

```text
http://127.0.0.1:8787/dashboard
```

Explain that `127.0.0.1` is local because SSH forwards it to the server loopback.

## Handoff

Report:

- server host
- app dir
- service name
- API bind address
- dashboard tunnel command
- validation commands run
- whether deployment stayed in dryRun
- which optional integrations are still missing
- any workaround used, especially public-registry install due to private lockfile URLs

Remind the user to rotate any secret that was pasted into chat.
