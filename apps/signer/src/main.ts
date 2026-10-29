import { readFileSync } from "node:fs";

import pg from "pg";

import { buildSignerApp } from "./app";
import { loadSignerConfig } from "./config";
import { connectVault } from "./vault";

const config = loadSignerConfig(process.env);
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
const vault = await connectVault(
  config.VAULT_ADDR,
  { token: config.VAULT_TOKEN, roleId: config.VAULT_ROLE_ID, secretId: config.VAULT_SECRET_ID },
  config.VAULT_TRANSIT_KEY,
);
const tls =
  config.SIGNER_TLS_CERT === undefined ||
  config.SIGNER_TLS_KEY === undefined ||
  config.SIGNER_TLS_CA === undefined
    ? undefined
    : {
        cert: readFileSync(config.SIGNER_TLS_CERT, "utf8"),
        key: readFileSync(config.SIGNER_TLS_KEY, "utf8"),
        ca: readFileSync(config.SIGNER_TLS_CA, "utf8"),
      };
const app = buildSignerApp({
  pool,
  vault,
  logLevel: config.LOG_LEVEL,
  ...(tls === undefined ? {} : { tls }),
});

const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await app.listen({ host: "0.0.0.0", port: config.SIGNER_PORT });
