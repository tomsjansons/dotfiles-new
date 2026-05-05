vim.pack.add({ { src = "https://github.com/stevearc/oil.nvim" } })

require("oil").setup({
	keymaps = {
		["q"] = { "actions.close", mode = "n" },
		["H"] = { "actions.toggle_hidden", mode = "n" },
	},
})

vim.keymap.set("n", "<leader>e", "<cmd>Oil --float<cr>", { desc = "Open parent directory" })
