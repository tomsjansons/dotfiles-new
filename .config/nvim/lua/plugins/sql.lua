vim.pack.add({
	{ src = "https://github.com/tpope/vim-dadbod" },
	{ src = "https://github.com/kristijanhusak/vim-dadbod-completion" },
	{ src = "https://github.com/kristijanhusak/vim-dadbod-ui" },
})

vim.g.db_ui_use_nerd_fonts = 1

local dbui_group = vim.api.nvim_create_augroup("DbuiMappings", { clear = true })

vim.api.nvim_create_autocmd("FileType", {
	group = dbui_group,
	pattern = "dbui",
	callback = function()
		vim.api.nvim_buf_set_keymap(0, "n", "<C-j>", "<C-w>j", { noremap = false, silent = true })
		vim.api.nvim_buf_set_keymap(0, "n", "<C-k>", "<C-w>k", { noremap = false, silent = true })
		vim.api.nvim_buf_set_keymap(0, "n", "q", "<cmd>DBUIClose<cr>", { noremap = false, silent = true })
		vim.api.nvim_buf_set_keymap(0, "n", "<esc>", "<cmd>DBUIClose<cr>", { noremap = false, silent = true })
	end,
})
