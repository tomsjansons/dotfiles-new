vim.pack.add({
	{ src = "https://github.com/pablopunk/pi.nvim" },
})

require("pi").setup()

vim.keymap.set("n", "<leader>ao", ":PiAsk<CR>", { desc = "Ask pi" })
vim.keymap.set("v", "<leader>ao", ":PiAskSelection<CR>", { desc = "Ask pi (selection)" })
