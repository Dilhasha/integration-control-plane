# ICP Database Migration Scripts

This directory contains **in-place v2 schema upgrade** scripts — they bring an existing ICP v2
database up to the current schema.

For migrating user accounts, credentials, and role assignments from **ICP v1**, see
[`../icp-1.2.x-to-2.x.x/`](../icp-1.2.x-to-2.x.x/).

---

## Upgrading an existing ICP v2 deployment: workflow feature

Deployments whose database was initialised **before the workflow management feature** (v2.0.0-beta2 and earlier) must run the workflow upgrade script once against the **main ICP DB**. Fresh installs do not need it — the `*_init.sql` scripts already contain everything.

Without it, the new server version starts normally but workflow views fail with `Column "CALLBACK_URL" not found`, and no Workflow-Management permissions appear in Access Control (even for Super Admin).

Pick the script matching your database engine:

| Engine | Script |
|---|---|
| H2 | `add_workflow_feature_h2.sql` |
| MySQL / MariaDB | `add_workflow_feature_mysql.sql` |
| PostgreSQL | `add_workflow_feature_postgresql.sql` |
| Microsoft SQL Server | `add_workflow_feature_mssql.sql` |
| Oracle (19c+) | `add_workflow_feature_oracle.sql` |

Each script applies, in order:

1. `runtimes.callback_url` — workflow management service base URL reported via the runtime heartbeat
2. The `Workflow-Management` permission domain (widens the domain constraint / ENUM)
3. The four `workflow_mgt:*` permissions (human tasks + workflow executions)
4. Role grants — Super Admin / Admin / Project Admin: view + manage both; Developer: manage human tasks, view workflows; Viewer: view human tasks only

The scripts are **idempotent** — safe to re-run, including after a partial failure. After running, restart the ICP server (or have users re-login) so sessions pick up the new permissions.

Example (H2, server may stay running thanks to `AUTO_SERVER`):

```bash
java -cp <path-to-h2.jar> org.h2.tools.RunScript \
  -url "jdbc:h2:file:./database/icp_db;MODE=MySQL;AUTO_SERVER=TRUE" \
  -user <db_user> -password <db_password> \
  -script add_workflow_feature_h2.sql
```

```bash
# MySQL
mysql -u <admin_user> -p <icp_db_name> < add_workflow_feature_mysql.sql

# PostgreSQL
psql -U <admin_user> -d <icp_db_name> -f add_workflow_feature_postgresql.sql

# Microsoft SQL Server
sqlcmd -S <server> -U <user> -P <password> -d <icp_db_name> -i add_workflow_feature_mssql.sql

# Oracle (run as the ICP schema owner)
sqlplus <icp_schema_user>/<password>@//<host>:1521/<service_name> @add_workflow_feature_oracle.sql
```

---

## Upgrading an existing ICP v2 deployment: packed OpenAPI definitions

Deployments whose database was initialised **before BI runtimes could report packed OpenAPI
(Swagger) definitions** must run the OpenAPI definitions upgrade script once against the
**main ICP DB** — **before** deploying this server version. Fresh installs do not need it —
the `*_init.sql` scripts already contain everything.

Without it, every full heartbeat fails: `upsertOpenApiDefinitions` unconditionally issues
`DELETE FROM bi_service_openapi_definitions` for the reporting runtime before checking whether
the heartbeat carries any OpenAPI definitions, so a missing table errors out that statement and
aborts the whole heartbeat transaction — for BI and MI runtimes alike, not just BI runtimes with
`remoteManagement` enabled.

Pick the script matching your database engine:

| Engine | Script |
|---|---|
| H2 | `add_openapi_definitions_h2.sql` |
| MySQL / MariaDB | `add_openapi_definitions_mysql.sql` |
| PostgreSQL | `add_openapi_definitions_postgresql.sql` |
| Microsoft SQL Server | `add_openapi_definitions_mssql.sql` |
| Oracle (19c+) | `add_openapi_definitions_oracle.sql` |

Each script adds the `bi_service_openapi_definitions` table (one row per packed OpenAPI file per
runtime, keyed by `(runtime_id, file_name)`, cascade-deleted with the runtime).

The scripts are **idempotent** — safe to re-run. No server restart is required; the next
heartbeat from an updated `icp-runtime-bridge` agent starts populating the table.

```bash
# H2 (server may stay running thanks to AUTO_SERVER)
java -cp <path-to-h2.jar> org.h2.tools.RunScript \
  -url "jdbc:h2:file:./database/icp_db;MODE=MySQL;AUTO_SERVER=TRUE" \
  -user <db_user> -password <db_password> \
  -script add_openapi_definitions_h2.sql

# MySQL
mysql -u <admin_user> -p <icp_db_name> < add_openapi_definitions_mysql.sql

# PostgreSQL
psql -U <admin_user> -d <icp_db_name> -f add_openapi_definitions_postgresql.sql

# Microsoft SQL Server
sqlcmd -S <server> -U <user> -P <password> -d <icp_db_name> -i add_openapi_definitions_mssql.sql

# Oracle (run as the ICP schema owner)
sqlplus <icp_schema_user>/<password>@//<host>:1521/<service_name> @add_openapi_definitions_oracle.sql
```
