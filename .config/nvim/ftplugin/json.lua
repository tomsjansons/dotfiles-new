-- Use jq for JSON formatting instead of language servers
-- This is faster than waiting for LSP to attach to scratch buffers
vim.bo.formatexpr = ""
vim.bo.formatprg = "jq"
