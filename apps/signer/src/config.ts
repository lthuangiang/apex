import { z } from "zod";

// Env của signer. Dev dùng token của Vault dev mode; môi trường khác dùng AppRole.

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value === "" ? undefined : value));

const envSchema = z
  .object({
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    SIGNER_PORT: z.coerce.number().int().positive().default(8090),
    DATABASE_URL: z.string().min(1),
    VAULT_ADDR: z.url(),
    // Compose truyền "" khi biến không được đặt: coi như không có.
    VAULT_TOKEN: optionalSecret,
    VAULT_ROLE_ID: optionalSecret,
    VAULT_SECRET_ID: optionalSecret,
    /** mTLS (DEC-42): cert/key của signer và CA ký cert client. Đặt đủ ba thì chạy https + bắt buộc client cert. */
    SIGNER_TLS_CERT: optionalSecret,
    SIGNER_TLS_KEY: optionalSecret,
    SIGNER_TLS_CA: optionalSecret,
    /** true thì từ chối khởi động khi thiếu mTLS (compose đặt true). */
    SIGNER_REQUIRE_MTLS: z.stringbool().default(false),
    VAULT_TRANSIT_KEY: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default("drift-api-keys"),
  })
  .refine(
    (env) =>
      !env.SIGNER_REQUIRE_MTLS ||
      (env.SIGNER_TLS_CERT !== undefined &&
        env.SIGNER_TLS_KEY !== undefined &&
        env.SIGNER_TLS_CA !== undefined),
    {
      message:
        "SIGNER_REQUIRE_MTLS is set: SIGNER_TLS_CERT, SIGNER_TLS_KEY and SIGNER_TLS_CA are required",
    },
  )
  .refine(
    (env) =>
      env.VAULT_TOKEN !== undefined ||
      (env.VAULT_ROLE_ID !== undefined && env.VAULT_SECRET_ID !== undefined),
    {
      message: "Set VAULT_TOKEN (dev) or VAULT_ROLE_ID + VAULT_SECRET_ID",
    },
  );

export type SignerConfig = z.infer<typeof envSchema>;

export function loadSignerConfig(env: Record<string, string | undefined>): SignerConfig {
  return envSchema.parse(env);
}
