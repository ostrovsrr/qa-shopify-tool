# Native Windows deployment (HELIOS-SERVER)

The Docker path in `deploy/docker-compose.yml` is the reference design. This is the
same design on a Windows host that has no Docker and no WSL, which is what
HELIOS-SERVER is.

What carries over unchanged:

- **One instance per Solution Engineer**, each holding credentials for only its own
  test stores. `getShopifyClient()` throws for any store it has no config for, so an
  instance cannot touch a store whose token is not in its process. That is the entire
  isolation mechanism and there is nothing else.
- **One shared PostgreSQL**, so run history is visible to everyone in one place.
- **Migrations run once**, not per instance.
- **`RETENTION_DAYS` stays unset.**

What differs: scheduled tasks instead of containers, native PostgreSQL instead of
`postgres:16`, and ports bound per `BIND_ADDR` + a host firewall rule instead of a
Docker port mapping.

## ⚠ There is no authentication

Not "not configured" — it does not exist in the code on `main`. Anyone who can reach
an instance port gets that SE's full API, including six destructive routes: deleting
validation runs and product uploads, and the two cleanup routes that **delete records
by tag across an entire Shopify store**.

The only controls are the firewall rule's `RemoteAddress` and `BIND_ADDR`. Keep both
tight, and do not give this a public DNS name.

> **The firewall rule is currently not enforcing anything on one profile.**
> HELIOS-SERVER has the **Private** Windows Firewall profile **disabled**. A rule only
> filters on a profile that is switched on, so if the active network is classified
> Private, ports 3101–3107 are reachable from anywhere that can route to the box —
> not just `10.20.30.0/24` — with no authentication in front of them.
> `Register-Instances.ps1` warns about this on every run. Enabling that profile is a
> machine-wide change that affects everything else on this shared box, so it is a
> deliberate decision for whoever owns the machine, not something the deploy does.

PostgreSQL is bound to `localhost` (`listen_addresses`), so the database is not exposed
even with the firewall profile off. `Install-Prerequisites.ps1` enforces that — the EDB
installer's default is `'*'`, which would otherwise put the superuser account on the LAN.

A Cloudflare Access implementation exists unmerged on the `hosting-async-fix` branch
(`middleware/accessAuth.ts`). It needs a tunnel and a public hostname, which is a
different deployment shape than this one.

## Layout

| Path | What |
|---|---|
| `C:\apps\qa-shopify-tool` | Git checkout + build output. Disposable; `git reset --hard` runs against it. |
| `C:\ProgramData\qa-shopify-tool\deploy.env` | **Credentials.** Deliberately outside the checkout. |
| `C:\ProgramData\qa-shopify-tool\logs\se*.log` | Per-instance stdout/stderr, rolled at 20 MB. |
| Task Scheduler `\QA Shopify Tool\` | One `qa-shopify-se*` task per instance. |

`deploy.env` is `deploy/.env` — the same format, the same keys. It sits outside the
checkout so that `git reset --hard` cannot clobber it and no `git add` can publish it
to what is a **public** repository.

## First run

Elevated, on the server:

```powershell
# 1. Put the credentials in place (from your laptop, before this):
#    scp deploy/.env all-users@10.20.30.208:C:/ProgramData/qa-shopify-tool/deploy.env

cd C:\apps\qa-shopify-tool\deploy\windows   # or wherever you unpacked the scripts

powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-Prerequisites.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy-QaTool.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Register-Instances.ps1
```

`Register-Instances.ps1` derives the instance list from the `SHOPIFY_STORES_SE*` keys
that actually have values, so adding an SE means adding a key and re-running it.

## Updating

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy-QaTool.ps1
```

Pulls `main`, **stops every instance**, rebuilds both halves, runs
`prisma migrate deploy` once, then starts them again.

Everything is down for the whole rebuild — a minute or two, not a rolling restart.
That is forced: Windows will not let `npm ci` replace
`node_modules\.prisma\client\query_engine-windows.dll.node` while a running instance
has that engine mapped, so the processes must stop before the build, not after it.
Tell people before you run it.

## Ports

| Instance | Port | URL for that SE |
|---|---|---|
| SE1 | 3101 | `http://10.20.30.208:3101` |
| SE2 | 3102 | `http://10.20.30.208:3102` |
| SE3 | 3103 | `http://10.20.30.208:3103` |
| SE4 | 3104 | `http://10.20.30.208:3104` |
| SE5 | 3105 | `http://10.20.30.208:3105` |
| SE6 | 3106 | `http://10.20.30.208:3106` |
| SE7 | 3107 | `http://10.20.30.208:3107` |

3101+ rather than 3001+ because 3001 is the development API port; colliding with it
would break `npm run dev` on the same machine.

PostgreSQL listens on 127.0.0.1:5432 and gets no firewall rule.

## Operating

```powershell
# state of every instance
Get-ScheduledTask -TaskPath '\QA Shopify Tool\' |
  Get-ScheduledTaskInfo | Format-Table TaskName, LastRunTime, LastTaskResult

# health
3101..3107 | ForEach-Object {
  try   { "$_ -> $((Invoke-RestMethod "http://127.0.0.1:$_/api/health").status)" }
  catch { "$_ -> DOWN" }
}

# logs
Get-Content C:\ProgramData\qa-shopify-tool\logs\se1.log -Tail 50 -Wait

# restart one
Stop-ScheduledTask  -TaskName qa-shopify-se1 -TaskPath '\QA Shopify Tool\'
Start-ScheduledTask -TaskName qa-shopify-se1 -TaskPath '\QA Shopify Tool\'
```

## How an instance recovers

Two layers, because the obvious one does not work:

1. **`Start-Instance.ps1` supervises node itself** — if node exits, it logs the exit
   code and restarts within seconds, backing off to a 60s ceiling if it keeps dying
   immediately. A process that stayed up for a minute resets the backoff.
2. **The task repeats every 5 minutes** with `MultipleInstances = IgnoreNew`, so a
   tick while healthy does nothing and a tick after the launcher itself died restarts
   it. Worst-case downtime if the whole task process dies: 5 minutes.

Task Scheduler's own `RestartOnFailure` is set but **is not what saves you**. This
machine registers tasks with `UseUnifiedSchedulingEngine`, which does not honour
restart-on-failure for a long-running action that exits non-zero. Verified by killing
a node process: the task ended at `0xFFFFFFFF` and never came back. That is what the
two layers above are for.

Config errors are deliberately not retried in the loop — a bad or missing store list
throws before the loop starts, so it fails loudly rather than spinning.

## Known limitations

- **`all-users` is a shared admin account.** Anyone who logs into it can read
  `deploy.env`, and ACLs cannot change that while the account is shared and
  administrative. A dedicated service account is a small change, not a redesign.
- **Two concurrent imports into the same Shopify store are impossible** — Shopify
  allows one bulk operation per shop, surfaced as a 409. Different stores run in
  parallel. Two SEs sharing a store will collide.
- **`product_original_rows` grows per upload** and nothing prunes it. `RETENTION_DAYS`
  is the lever, and it is off; read the retention section of `docs/DEPLOY.md` before
  touching it.
- **No backups.** Nothing dumps this database anywhere.
- **One CPU-bound validation blocks that instance's other requests** — Node is
  single-threaded and validation is synchronous. Per-SE instances mean an SE only
  ever blocks themselves.
