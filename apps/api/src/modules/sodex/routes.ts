import {
  connectBodySchema,
  disconnectBodySchema,
  revokeBuilderFeeBodySchema,
  submitSignatureBodySchema,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import {
  getConnection,
  getSignatureRequest,
  startDisconnect,
  reconcile,
  startBuilderFee,
  startConnect,
  startRenew,
  submitSignature,
  type SodexDeps,
} from "./service";

const idParams = z.object({ id: z.uuid() });

export function registerSodexRoutes(app: FastifyInstance, deps: SodexDeps): void {
  const { db } = deps;

  app.get("/api/v1/sodex/connection", async (request) =>
    getConnection(deps, requireAuth(request).userId),
  );

  /** Onboarding bước 2, chữ ký 1. */
  app.post("/api/v1/sodex/connection", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(connectBodySchema, request.body);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => ({
      status: 201,
      body: await startConnect(deps, auth.userId, body.address),
    }));
  });

  /** Renew key (DEC-59): key mới `DRIFT-<yyyymmdd>`, một chữ ký của master wallet. */
  app.post("/api/v1/sodex/connection/renewal", async (request, reply) => {
    const auth = requireAuth(request);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => ({
      status: 201,
      body: await startRenew(deps, auth.userId),
    }));
  });

  /** Chữ ký 2 (onboarding) hoặc "Sign to approve 0.01% again" (DEC-46). */
  app.post("/api/v1/sodex/builder-fee/approval", async (request, reply) => {
    const auth = requireAuth(request);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => ({
      status: 201,
      body: await startBuilderFee(deps, auth.userId, true, undefined, request.ip),
    }));
  });

  /** "Revoke (set to 0)…": dialog + ký + 2FA. */
  app.post("/api/v1/sodex/builder-fee/revocation", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(revokeBuilderFeeBodySchema, request.body);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => ({
      status: 201,
      body: await startBuilderFee(deps, auth.userId, false, body.twoFactorCode, request.ip),
    }));
  });

  /** "Disconnect…": dialog + 2FA, rồi ký hai request xoá key (DEC-31). */
  app.post("/api/v1/sodex/disconnection", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(disconnectBodySchema, request.body);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => ({
      status: 201,
      body: await startDisconnect(deps, auth.userId, body.twoFactorCode, request.ip),
    }));
  });

  app.get("/api/v1/sodex/signature-requests/:id", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return getSignatureRequest(deps, requireAuth(request).userId, id);
  });

  app.post("/api/v1/sodex/signature-requests/:id/signature", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    const body = parseOrThrow(submitSignatureBodySchema, request.body);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => ({
      status: 200,
      body: await submitSignature(deps, auth.userId, id, body.signature, request.ip),
    }));
  });

  /** Đọc lại cho request `unknown`. Chỉ đọc SoDEX, không gửi lại. */
  app.post("/api/v1/sodex/signature-requests/:id/reconciliation", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => ({
      status: 200,
      body: await reconcile(deps, auth.userId, id),
    }));
  });
}
