---
name: xagent-cloud-health-check
description: Repository-local workflow for strict health checks and safe remediation of the xAgent cloud/VPS deployment. Use when the user asks for 云端巡检, 线上检查, dry_run service verification, dashboard/API not loading, GMGN/RPC/Telegram validation, or systemd xagent.service troubleshooting for this repository.
---

# xagent-cloud-health-check

## Scope

Use this skill only for this repository's cloud deployment. It assumes the deployed service is xAgent running as a systemd service, usually:

- current SSH target: `xagent-vps` (`root@43.247.132.62`, public-key auth, `IPQoS none`)
- app dir: `/opt/xagent`
- env file: `/etc/xagent/xagent.env`
- service: `xagent.service`
- API: `127.0.0.1:8787`
- normal dryRun mode: `execution.mode=dry_run`

For this repository's current cloud deployment, prefer the local SSH alias `xagent-vps`. It is configured for root public-key login and `IPQoS none`; do not ask the user for the server password unless the alias/key path is proven unavailable. If the current thread provides a different host, use that host. Do not assume a password or secret. Do not place this skill outside this repository.

## Safety Rules

- Never print secret values from `/etc/xagent/xagent.env`; print only key names, presence, lengths, or redacted URL origins.
- Do not ask for or configure wallet private keys during dryRun inspection.
- Do not disable API auth to work around dashboard issues unless the user explicitly approves the security tradeoff.
- Do not run live-chain actions unless the user explicitly asks for canary/live validation and the config is not `dry_run`.
- Do not edit `runtime/state.json` or audit logs directly. Use control-plane APIs for dryRun remediation.
- Before mutating a live service, first prove the current state with read-only checks.

## Baseline Checks

Run these groups first. Use SSH escalation when needed. For the current deployment, execute remote commands through `ssh xagent-vps '...'`.

1. Service and network:
   - `ssh xagent-vps 'systemctl is-active xagent.service'`
   - `ssh xagent-vps 'systemctl is-enabled xagent.service'`
   - `ssh xagent-vps 'systemctl --no-pager --full status xagent.service'`
   - `ssh xagent-vps 'ss -ltnp | grep 8787'`
   - Expected: service `active`, enabled, Node process running, API bound to `127.0.0.1:8787` only.

2. Environment and permissions:
   - print keys only: `cut -d= -f1 /etc/xagent/xagent.env`
   - check presence/length for `XAGENT_API_TOKEN`, `GMGN_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `SOL_PRICE_USD`, `PRIMARY_RPC_URL`, `HELIUS_RPC_URL`, `TG_BOT_TOKEN`, `TG_CHAT_ID`; prefer a remote-only Node snippet over nested shell `${...}` expansion:
     `node -e 'const fs=require("fs"); const env=Object.fromEntries(fs.readFileSync("/etc/xagent/xagent.env","utf8").split(/\n/).filter(Boolean).map(line=>{const i=line.indexOf("="); return [line.slice(0,i), line.slice(i+1)]})); for (const k of ["XAGENT_API_TOKEN","GMGN_API_KEY","ANTHROPIC_AUTH_TOKEN","SOL_PRICE_USD","PRIMARY_RPC_URL","HELIUS_RPC_URL","TG_BOT_TOKEN","TG_CHAT_ID"]) console.log(k+":"+(env[k]||"").length);'`
   - `ls -ld /etc/xagent && ls -l /etc/xagent/xagent.env`
   - Expected: env file readable by the service user/group, not world-readable.

3. Runtime status through API:
   - `ssh xagent-vps 'curl -s http://127.0.0.1:8787/health'` must return `ok: true`.
   - `ssh xagent-vps 'curl -s -w "\n%{http_code}\n" http://127.0.0.1:8787/status'` should return `401`.
   - `ssh xagent-vps 'set -a; source /etc/xagent/xagent.env; set +a; curl -s -w "\n%{http_code}\n" -H "Authorization: Bearer $XAGENT_API_TOKEN" http://127.0.0.1:8787/status'` should return `200`.
   - Expected status fields:
     - `mode=normal`
     - `manualPause=false`
     - `orchestratorRunning=true`
     - `pendingActions=0`
     - `execution.mode=dry_run`
     - `execution.healthy=true`
     - `dataProviders.hasPrimaryProvider=true`
     - `dataProviders.providerStatuses` contains `provider=gmgn` with `ok=true`
     - `rpc.statuses` contains primary/backup statuses with `ok=true`
     - `paperTrading.enabled=true`
     - `paperTrading.stalePositions=0`

4. Dependency and resource health:
   - `node -v`, `npm -v`, `gmgn-cli --version`
   - `df -h / /opt/xagent`
   - `free -h`
   - `find /opt/xagent/runtime -maxdepth 2 -type f -printf '%p %s bytes\n'`
   - Expected: Node 20+, enough disk, swap present, runtime state/audit files being written.

5. External integrations:
   - For GMGN CLI direct tests, export env first:
     `set -a; source /etc/xagent/xagent.env; set +a`
   - Then run:
     `gmgn-cli market trending --chain sol --interval 1h --limit 1 --raw`
   - Telegram direct ping is valid when `TG_BOT_TOKEN` and `TG_CHAT_ID` are present. Redact bot token in all output.
   - LLM success is inferred by lack of `OpenAI API Key 未配置` warnings and normal `llm.jsonl` writes.

6. Logs:
   - Check current-window logs, not stale pre-configuration history:
     `ssh xagent-vps 'journalctl -u xagent.service --since "10 min ago" --no-pager'`
   - Treat current `GMGN_API_KEY is required`, `OpenAI API Key 未配置`, provider down, state persistence errors, `close_only`, and `emergency` as actionable.
   - During dryRun, `钱包密钥未加载` is acceptable. `Discord notifier 未启用` is acceptable if Telegram is configured.

## Safe Remediation

- Service down:
  1. inspect `ssh xagent-vps 'journalctl -u xagent.service -n 120 --no-pager'`
  2. run `ssh xagent-vps 'cd /opt/xagent && npm run check'`
  3. if source changed, run `ssh xagent-vps 'cd /opt/xagent && npm run build'`
  4. restart with `ssh xagent-vps 'systemctl restart xagent.service'`

- Env updated:
  1. verify key presence without printing values
  2. `ssh xagent-vps 'systemctl restart xagent.service'`
  3. re-check `/status` and recent logs

- GMGN direct CLI says key is missing but `/status` says GMGN is healthy:
  - likely the shell used `source` without exporting variables.
  - use `set -a; source /etc/xagent/xagent.env; set +a` before CLI tests.

- Dashboard auth prompt fails:
  - verify served `/dashboard/app.js` contains `requestAuthToken` and `token-prompt-backdrop`.
  - if missing, deploy the current repo build and restart service.
  - do not remove `XAGENT_API_TOKEN` as a workaround.

- Active dryRun position has `paper.lastSource=missing_pool` or stale paper data:
  - confirm `execution.mode=dry_run`.
  - use `POST /positions/:id/force-exit` with the API token.
  - re-check active positions and `paperTrading.stalePositions`.
  - never direct-edit runtime state.

- `/metrics` returns `401` when opened from the dashboard link:
  - this is non-blocking with Bearer auth enabled.
  - verify metrics with an Authorization header.
  - note as UX debt unless the user asks to change dashboard behavior.

## Completion Criteria

Report:

- service status and listening address
- API auth result
- execution mode and health
- GMGN/RPC/Telegram status
- active/stale position counts
- any warnings that are acceptable for dryRun
- fixes applied
- commands used for validation

If all checks pass, say explicitly that the cloud dryRun service is operating as expected and has not touched live execution.
