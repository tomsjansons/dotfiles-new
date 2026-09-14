---
name: advangrid-prod-access
description: Access Advangrid production services — MySQL databases, the Dozzle container log viewer, and the Inngest server. Use when a task requires querying an Advangrid production database, reading production container logs, or inspecting Inngest apps, functions, and runs.
---

# Advangrid production access

Credentials are already loaded into the environment. The helper scripts resolve
relative to this skill directory.

## Prerequisites

| Service | Env vars |
| --- | --- |
| MySQL | `ADV_PROD_MYSQL_{HOST,PORT,USER,PWD}` |
| Dozzle | `ADV_PROD_DOZZLE_{URL,USER,PWD}` |
| Inngest | `ADV_PROD_INNGEST_{URL,USER,PWD}` |

Check the ones you need are present:

```sh
for v in ADV_PROD_MYSQL_HOST ADV_PROD_MYSQL_USER ADV_PROD_MYSQL_PWD \
         ADV_PROD_DOZZLE_URL ADV_PROD_DOZZLE_USER ADV_PROD_DOZZLE_PWD \
         ADV_PROD_INNGEST_URL ADV_PROD_INNGEST_USER ADV_PROD_INNGEST_PWD; do
  eval "val=\$$v"
  [ -n "$val" ] || echo "MISSING: $v"
done
```

If any variable is empty, stop and ask the user to run `sec-login` (or
`sec-api`) in zsh. Never print, log, or echo the credential variables.

## MySQL

Choose the database relevant to the task; ask the user if the task doesn't name one.

```sh
mysql \
  --host="$ADV_PROD_MYSQL_HOST" --port="$ADV_PROD_MYSQL_PORT" \
  --user="$ADV_PROD_MYSQL_USER" --password="$ADV_PROD_MYSQL_PWD" \
  --database="<relevant-db-for-task>"
```

## Dozzle — container logs

```sh
scripts/ag-dozzle.sh containers              # running containers
scripts/ag-dozzle.sh find advangrid          # resolve a name substring
scripts/ag-dozzle.sh logs advangrid-api                  # last 15 min
scripts/ag-dozzle.sh logs advangrid-api --since 2h --grep 'error|panic'
scripts/ag-dozzle.sh follow advangrid-worker --grep ERROR
scripts/ag-dozzle.sh download advangrid-api  # ZIP of log files
scripts/ag-dozzle.sh api /api/version        # any authenticated GET
```

## Inngest — apps, functions, runs

```sh
scripts/ag-inngest.sh apps                   # apps + functions
scripts/ag-inngest.sh runs --status failed --since 6h
scripts/ag-inngest.sh runs --fn process-order --limit 50
scripts/ag-inngest.sh run <runID>            # one run + trace summary
scripts/ag-inngest.sh gql '<query>' '{"vars":...}'
```

## Rules

- Investigation only. Never send events, invoke functions, cancel or rerun runs,
  start/stop containers, or modify data. Writes are deliberately not available
  in the helpers, and `ag-inngest.sh gql` refuses `mutation` operations.
- Prefer the helpers; they keep credentials out of `argv` and your transcript.
- Run `scripts/ag-dozzle.sh help` or `scripts/ag-inngest.sh help` for all options.
