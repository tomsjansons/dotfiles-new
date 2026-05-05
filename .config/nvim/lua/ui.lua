vim.pack.add({
	{ src = "https://github.com/nvim-lualine/lualine.nvim" },
	{ src = "https://github.com/j-hui/fidget.nvim" },
})

require("fidget").setup({
	notification = {
		override_vim_notify = true,
	},
})
require("lualine").setup({})
