-- Migration: Try-It proxy support (H2)
-- Adds runtimes.try_it_host - the bare, reachable host/IP for this runtime process
-- (self-reported by icp-runtime-bridge in the heartbeat), used by the Try-It proxy
-- (tryit_proxy_service.bal) to resolve where to forward "Try it out" requests.
-- Idempotent - safe to re-run. Fresh installs get this from h2_init.sql.
-- Run once against the main ICP DB.

ALTER TABLE runtimes ADD COLUMN IF NOT EXISTS try_it_host VARCHAR(255);
