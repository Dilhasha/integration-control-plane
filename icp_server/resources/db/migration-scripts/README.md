# ICP Database Migration Scripts

This directory contains two kinds of SQL scripts:

1. **In-place v2 schema upgrades** (`add_workflow_feature_<engine>.sql`, `add_openapi_definitions_<engine>.sql`, `add_integration_types_<engine>.sql`, `add_faulty_data_service_state_<engine>.sql`) — bring an existing ICP v2 database up to the current schema.
2. **ICP v1 → v2 user migration** (`v1_to_v2_<engine>.sql`) — migrate user accounts, credentials, and role assignments from ICP v1.

---

## Upgrading an existing ICP v2 deployment: workflow feature

Deployments whose database was initialised **before the workflow management feature** (v2.0.0-beta2 and earlier) must run the workflow upgrade script once against the **main ICP DB** — **before** deploying this server version. Fresh installs do not need it — the `*_init.sql` scripts already contain everything.

Without it, two things break. Workflow views fail with `Column "CALLBACK_URL" not found` and no Workflow-Management permissions appear in Access Control (even for Super Admin). Worse, **every full heartbeat fails** — for MI runtimes as much as BI ones: `upsertWorkflowMetadata` issues `DELETE FROM bi_workflow_metadata` for the reporting runtime before checking whether the heartbeat carries any metadata, so a missing table errors out that statement and aborts the whole heartbeat transaction.

Pick the script matching your database engine:

| Engine | Script |
|---|---|
| H2 | `add_workflow_feature_h2.sql` |
| MySQL / MariaDB | `add_workflow_feature_mysql.sql` |
| PostgreSQL | `add_workflow_feature_postgresql.sql` |
| Microsoft SQL Server | `add_workflow_feature_mssql.sql` |
| Oracle (19c+) | `add_workflow_feature_oracle.sql` |

Each script applies, in order:

1. `runtimes.callback_url` — retained for schema compatibility: heartbeat writes still reference the column, but nothing populates it now that workflow management goes through the command tunnel
2. The `Workflow-Management` permission domain (widens the domain constraint / ENUM)
3. The four `workflow_mgt:*` permissions (human tasks + workflow executions)
4. Role grants — Super Admin / Admin / Project Admin: view + manage both; Developer: manage human tasks, view workflows; Viewer: view human tasks only
5. `bi_workflow_metadata` — the workflow metadata document and advertised capabilities a BI runtime publishes in its full heartbeat (one row per runtime, replaced on every full heartbeat, removed with the runtime via `ON DELETE CASCADE`)

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

---

## Upgrading an existing ICP v2 deployment: integration types

Deployments whose database was initialised **before integrations carried a type** must run the
integration types upgrade script once against the **main ICP DB** — **before** deploying this
server version. Fresh installs do not need it — the `*_init.sql` scripts already contain
everything.

Without it, every component read fails: the component queries now select `c.display_type` and
`c.component_sub_type`, so a missing column errors out the statement — breaking the project and
integration listings, not just the create form.

Pick the script matching your database engine:

| Engine | Script |
|---|---|
| H2 | `add_integration_types_h2.sql` |
| MySQL / MariaDB | `add_integration_types_mysql.sql` |
| PostgreSQL | `add_integration_types_postgresql.sql` |
| Microsoft SQL Server | `add_integration_types_mssql.sql` |
| Oracle (19c+) | `add_integration_types_oracle.sql` |

Each script adds two columns to `components`:

1. `display_type` — the integration type itself (`ballerinaService`, `miApiService`,
   `scheduledTask`, `miCronjob`), defaulting to `service`
2. `component_sub_type` — discriminates types that share a generic service `display_type`
   (AI Agent, MCP Server, File Integration); `NULL` for the rest

Existing rows backfill to `service`, which is exactly what the server previously reported for
every component, so nothing changes for them.

The scripts are **idempotent** — safe to re-run.

```bash
# H2 (server may stay running thanks to AUTO_SERVER)
java -cp <path-to-h2.jar> org.h2.tools.RunScript \
  -url "jdbc:h2:file:./database/icp_db;MODE=MySQL;AUTO_SERVER=TRUE" \
  -user <db_user> -password <db_password> \
  -script add_integration_types_h2.sql

# MySQL
mysql -u <admin_user> -p <icp_db_name> < add_integration_types_mysql.sql

# PostgreSQL
psql -U <admin_user> -d <icp_db_name> -f add_integration_types_postgresql.sql

# Microsoft SQL Server
sqlcmd -S <server> -U <user> -P <password> -d <icp_db_name> -i add_integration_types_mssql.sql

# Oracle (run as the ICP schema owner)
sqlplus <icp_schema_user>/<password>@//<host>:1521/<service_name> @add_integration_types_oracle.sql
```

---

## Upgrading an existing ICP v2 deployment: faulty data service tracking

Deployments whose database was initialised **before data services reported a
deploy failure** must run the faulty data service upgrade script once against the
**main ICP DB** — **before** deploying this server version. Fresh installs do not
need it — the `*_init.sql` scripts already contain everything.

Without it, every full heartbeat that carries a data service fails: the heartbeat
now inserts `mi_data_service_artifacts.error_message` and reports the artifact
state as `Active` or `Faulty`, so a missing `error_message` column (or the old
`enabled`/`disabled` state CHECK/ENUM) errors out the insert and aborts the whole
heartbeat transaction.

Pick the script matching your database engine:

| Engine | Script |
|---|---|
| H2 | `add_faulty_data_service_state_h2.sql` |
| MySQL / MariaDB | `add_faulty_data_service_state_mysql.sql` |
| PostgreSQL | `add_faulty_data_service_state_postgresql.sql` |
| Microsoft SQL Server | `add_faulty_data_service_state_mssql.sql` |
| Oracle (19c+) | `add_faulty_data_service_state_oracle.sql` |

Each script adds `mi_data_service_artifacts.error_message` (the deploy failure
message the runtime bridge reports when `state = 'Faulty'`), canonicalizes every
previously deployed service to `Active`, and restricts the state contract to
`('Active', 'Faulty')`.

The scripts are **idempotent** — safe to re-run. No server restart is required;
the next heartbeat starts populating the column.

```bash
# H2 (server may stay running thanks to AUTO_SERVER)
java -cp <path-to-h2.jar> org.h2.tools.RunScript \
  -url "jdbc:h2:file:./database/icp_db;MODE=MySQL;AUTO_SERVER=TRUE" \
  -user <db_user> -password <db_password> \
  -script add_faulty_data_service_state_h2.sql

# MySQL
mysql -u <admin_user> -p <icp_db_name> < add_faulty_data_service_state_mysql.sql

# PostgreSQL
psql -U <admin_user> -d <icp_db_name> -f add_faulty_data_service_state_postgresql.sql

# Microsoft SQL Server
sqlcmd -S <server> -U <user> -P <password> -d <icp_db_name> -i add_faulty_data_service_state_mssql.sql

# Oracle (run as the ICP schema owner)
sqlplus <icp_schema_user>/<password>@//<host>:1521/<service_name> @add_faulty_data_service_state_oracle.sql
```

---

# ICP v1 → v2 User Migration

The following scripts migrate user accounts, credentials, and role assignments from **ICP v1** to **ICP v2**.

Scripts are provided for **MySQL / MariaDB** and **Microsoft SQL Server**. The script requires the old and new databases to be on the same server instance, using cross-database references to read from the old schema and write to both new schemas in a single session.

---

## Running the script

**Prerequisites:**

1. The new ICP v2 main DB and credentials DB must already be initialised using the standard init scripts.
2. The database user running the script must have `SELECT` privileges on the old database and `INSERT` / `UPDATE` / `DELETE` privileges on the two new databases.

---

### MySQL / MariaDB (`v1_to_v2_mysql.sql`)

1. Edit the configuration variables at the top of `v1_to_v2_mysql.sql`:

   ```sql
   SET @old_db          = 'userdb';    -- Old ICP v1 database name
   SET @new_main_db     = 'icp_db';    -- New ICP v2 main database name
   SET @new_creds_db    = 'icp_creds'; -- New ICP v2 credentials database name
   SET @reset_passwords = FALSE;       -- Set TRUE to force a password change on first login
   ```

2. Run the script:

   ```bash
   mysql -u <admin_user> -p < v1_to_v2_mysql.sql 2>&1 | tee migration.log
   ```

---

### Microsoft SQL Server (`v1_to_v2_mssql.sql`)

1. Edit the configuration variables at the top of `v1_to_v2_mssql.sql`:

   ```sql
   DECLARE @old_db          NVARCHAR(128) = N'userdb';    -- Old ICP v1 database name
   DECLARE @new_main_db     NVARCHAR(128) = N'icp_db';    -- New ICP v2 main database name
   DECLARE @new_creds_db    NVARCHAR(128) = N'icp_creds'; -- New ICP v2 credentials database name
   DECLARE @reset_passwords BIT           = 0;             -- Set 1 to force a password change on first login
   ```

2. Run the script:

   ```bash
   sqlcmd -S <server> -U <user> -P <password> -i v1_to_v2_mssql.sql
   ```

   Alternatively, open the file in SSMS and execute it.

The script prints a status message after each step and a summary table at the end.

---

## Post-migration checklist

1. **`Config.toml`** — set `passwordHashingAlgorithm` to match the old `PasswordDigest`:

   ```toml
   passwordHashingAlgorithm = "sha-256"   # or sha-1, md5, sha-512, plain_text
   ```

2. **Restart** the ICP v2 server.

---

## What is migrated

| Data | Source (ICP v1) | Destination (ICP v2) |
|---|---|---|
| User identity | `UM_USER` (`UM_USER_ID`, `UM_USER_NAME`) | `users` (main DB) |
| Display name | `UM_USER_ATTRIBUTE` (`displayName` claim) | `users.display_name` |
| Password hash + salt | `UM_USER` (`UM_USER_PASSWORD`, `UM_SALT_VALUE`) | `user_credentials` (credentials DB) |
| Role → group assignment | `UM_USER_ROLE` + `UM_HYBRID_USER_ROLE` | `group_user_mapping` (main DB) |

**What is NOT migrated:** refresh tokens, OIDC sessions, audit logs, custom attributes beyond display name, or project/environment data (which does not exist in ICP v1).

---

## Conflict resolution

The ICP v2 init scripts seed a default `admin` user. When the migration script encounters a username that already exists in the new database it applies the following rules:

| Existing username in new DB | Action |
|---|---|
| `admin` | **Merge** — keep the v2 UUID and group membership intact; overwrite `password_hash`/`password_salt` with old system values |
| any other username | **Replace** — delete the pre-existing v2 user (and their group mappings) then insert the old system's version of that user with its original UUID |

The replace strategy gives the old system full priority: any user account that was pre-created in ICP v2 before migration (other than the seed admin) will be overwritten by the migrated account.

---

## Password migration

ICP v1 stored passwords as:

```text
Base64( Digest( password + salt ) )
```

where `Digest` is the algorithm set in `user-mgt.xml` → `PasswordDigest` (default: `SHA-256`). Salt storage is controlled by `StoreSaltedPassword` (default: `true`).

ICP v2's default authentication backend (`default_user_service.bal`) supports the **same algorithm family** via the `passwordHashingAlgorithm` setting in `Config.toml`:

| Old `PasswordDigest` value | ICP v2 `passwordHashingAlgorithm` |
|---|---|
| `SHA-256` *(default)* | `sha-256` |
| `SHA-1` / `SHA` | `sha-1` |
| `SHA-384` | `sha-384` |
| `SHA-512` | `sha-512` |
| `MD5` | `md5` |
| *(null / `PLAIN_TEXT`)* | `plain_text` |

The migration script copies hashes and salts **as-is**. After migration, set `passwordHashingAlgorithm` in `Config.toml` to match your old `PasswordDigest` value. Migrated users will not be forced to change their password on first login by default. Set `@reset_passwords = TRUE` in the script configuration to require a password change on first login.

---

## Role → group mapping

ICP v1 used flat WSO2 roles. ICP v2 uses a group-based RBAC model. The migration applies a simple two-bucket mapping:

| Old role (`UM_ROLE` or `UM_HYBRID_ROLE`) | ICP v2 group |
|---|---|
| `admin` / `Internal/admin` | Super Admins |
| any other role (or no role) | Developers |

Users assigned to Super Admins also get `is_super_admin = TRUE` in the `users` table.
