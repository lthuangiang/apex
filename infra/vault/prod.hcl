# Production 1 host (DEC-70): Vault server mode, lưu file trên named volume `vaultdata`.
# Chỉ nghe trong network `secure` (internal), không có cổng ra ngoài nên không bật TLS.
# Mất volume này = mất khoá transit `drift-api-keys` = mọi API key đã lưu không giải mã được (UI_REVIEW H1).
# Backup cùng volume `vaultinit` (infra/deploy/backup.sh).
storage "file" {
  path = "/vault/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

disable_mlock = true
ui            = false
