vim.pack.add({ { src = "https://github.com/sontungexpt/url-open" } })

require("url-open").setup({})

vim.keymap.set("n", "gx", "<cmd>URLOpenUnderCursor<cr>", { desc = "Open URL" })
