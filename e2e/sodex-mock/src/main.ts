import { readFileSync } from "node:fs";

import Fastify from "fastify";

import { buildSodexMock } from "./index";

// Chạy mock như một server cho E2E: SODEX_MOCK_USERS="0xabc…:1001,0xdef…:1002".
const builderId = Number(process.env.DRIFT_BUILDER_ID ?? "0");
// E2E chạy mock qua https (cert tự ký) vì api chỉ nhận URL SoDEX dạng https.
const tls =
  process.env.TLS_CERT !== undefined && process.env.TLS_KEY !== undefined
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
    : undefined;
const mock = buildSodexMock({
  builderIds: [builderId],
  ...(tls === undefined ? {} : { https: tls }),
});
for (const pair of (process.env.SODEX_MOCK_USERS ?? "").split(",").filter(Boolean)) {
  const [address, id] = pair.split(":");
  if (address !== undefined && id !== undefined) mock.addUser(address, Number(id));
}
// Cổng điều khiển cho test: http thường, chỉ nghe trên 127.0.0.1.
const control = Fastify({ logger: false });
control.post("/__mock/users", (request, reply) => {
  const body = request.body as { address: string; accountID: number };
  mock.addUser(body.address, body.accountID);
  return reply.status(204).send();
});
control.post("/__mock/history", (request, reply) => {
  const body = request.body as { address: string } & Parameters<typeof mock.setHistory>[1];
  mock.setHistory(body.address, body);
  return reply.status(204).send();
});
control.get("/__mock/orders", (request, reply) => {
  const { address } = request.query as { address: string };
  return reply.send(mock.orders(address));
});
control.post("/__mock/fail-next", (request, reply) => {
  const body = request.body as { mode: "timeout-after-apply" | "reject"; error?: string };
  mock.failNextWrite(body.mode, body.error);
  return reply.status(204).send();
});
await mock.app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? "8099") });
await control.listen({ host: "127.0.0.1", port: Number(process.env.CONTROL_PORT ?? "8098") });
