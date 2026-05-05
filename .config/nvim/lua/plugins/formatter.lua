vim.pack.add({ { src = "https://github.com/mhartington/formatter.nvim" } })

require("formatter").setup({
	logging = true,
	log_level = vim.log.levels.WARN,
	filetype = {
		yaml = {
			require("formatter.filetypes.yaml").prettierd,
		},
		json = {
			require("formatter.filetypes.json").biome,
		},
		c = {
			require("formatter.filetypes.c").clangformat,
		},
		lua = {
			require("formatter.filetypes.lua").stylua,
		},
		go = {
			require("formatter.filetypes.go").gofumpt,
		},
		rust = {
			require("formatter.filetypes.rust").rustfmt,
		},
		typescript = {
			require("formatter.filetypes.typescript").eslint_d,
			require("formatter.filetypes.typescript").prettierd,
		},
		typescriptreact = {
			require("formatter.filetypes.typescript").eslint_d,
			require("formatter.filetypes.typescript").prettierd,
		},
		javascript = {
			require("formatter.filetypes.typescript").eslint_d,
			require("formatter.filetypes.typescript").prettierd,
		},
		javascriptreact = {
			require("formatter.filetypes.typescript").eslint_d,
			require("formatter.filetypes.typescript").prettierd,
		},
		html = {
			require("formatter.filetypes.html").prettierd,
		},
		zig = {
			require("formatter.filetypes.zig").zigfmt,
		},
	},
})

vim.api.nvim_create_augroup("__formatter__", { clear = true })
vim.api.nvim_create_autocmd("BufWritePost", {
	group = "__formatter__",
	command = ":FormatWrite",
})
