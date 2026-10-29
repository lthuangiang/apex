# DEV ONLY. Vault server mode lưu vào named volume để khoá transit `drift-api-keys` không mất khi restart
# (UI_REVIEW H1). Production dùng cloud KMS hoặc Vault cluster riêng, không dùng file này.
storage "file" {
  path = "/vault/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

disable_mlock = true
ui            = false
