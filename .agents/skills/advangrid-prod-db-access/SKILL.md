---
name: advangrid-prod-db-access
description: Access Advangrid production MySQL databases. Use when a task requires querying an Advangrid production database.
---

# Advangrid production database access

Choose the database relevant to the task, then use the `mysql` command-line client with the credentials already loaded into the environment:

```sh
mysql \
  --host="$ADV_PROD_MYSQL_HOST" \
  --port="$ADV_PROD_MYSQL_PORT" \
  --user="$ADV_PROD_MYSQL_USER" \
  --password="$ADV_PROD_MYSQL_PWD" \
  --database="<relevant-db-for-task>"
```

Replace `<relevant-db-for-task>` with the actual database name. If the task does not identify the relevant database, ask the user before connecting. Never print or otherwise expose the credential variables.
