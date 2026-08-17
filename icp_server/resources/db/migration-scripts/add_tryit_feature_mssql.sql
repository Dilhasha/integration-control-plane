-- Migration: Try-It proxy support (Microsoft SQL Server)
-- Adds runtimes.try_it_host - the bare, reachable host/IP for this runtime process
-- (self-reported by icp-runtime-bridge in the heartbeat), used by the Try-It proxy
-- (tryit_proxy_service.bal) to resolve where to forward "Try it out" requests.
-- Idempotent - safe to re-run. Fresh installs get this from mssql_init.sql.
-- Run once against the main ICP DB.

IF COL_LENGTH('runtimes', 'try_it_host') IS NULL
    ALTER TABLE runtimes ADD try_it_host NVARCHAR(255) NULL;
GO
