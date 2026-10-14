#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { request } = require('../lib/broker-client');
const { HOST_LAUNCHER, chromeHostManifestPath } = require('../lib/native-host-config');

function nativeMessagingStatus() {
  const status = {
    manifestPath: null,
    manifestExists: false,
    path: null,
    expectedPath: HOST_LAUNCHER,
    pathMatches: false,
    allowedOrigins: [],
  };

  try {
    status.manifestPath = chromeHostManifestPath();
    const manifest = JSON.parse(fs.readFileSync(status.manifestPath, 'utf8'));
    status.manifestExists = true;
    status.path = manifest.path || null;
    status.pathMatches = status.path === HOST_LAUNCHER;
    status.allowedOrigins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
  } catch (error) {
    status.error = error.message;
  }

  return status;
}

async function main() {
  const health = await request('bridge.health');
  health.nativeMessaging = nativeMessagingStatus();
  process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
