// process.loadEnvFile works throughout Node 22, including before --env-file-if-exists existed.
try { process.loadEnvFile('.env'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await import('./index.js');
