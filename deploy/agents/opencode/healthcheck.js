const fs = require('node:fs');

const password = fs.readFileSync('/run/secrets/opencode-server-password', 'utf8').trim();
const authorization = Buffer.from(`opencode:${password}`).toString('base64');

fetch('http://127.0.0.1:4096/api/health', {
  headers: { Authorization: `Basic ${authorization}` },
})
  .then((response) => {
    if (!response.ok) {
      process.exitCode = 1;
    }
  })
  .catch(() => {
    process.exitCode = 1;
  });
