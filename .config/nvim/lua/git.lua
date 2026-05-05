vim.pack.add({
	{ src = "https://github.com/pwntester/octo.nvim" },
	{ src = "https://github.com/nvim-tree/nvim-web-devicons" },
	{ src = "https://github.com/lewis6991/gitsigns.nvim" },
	{ src = "https://github.com/sindrets/diffview.nvim" },
})

local wk = require("which-key")
wk.add({
	{ "<leader>g", group = "Git" },
})

wk.add({
	{ "<leader>gd", group = "Diff" },
})
vim.keymap.set("n", "<leader>gdf", "<cmd>DiffviewFileHistory %<cr>", { desc = "Diff File" })
vim.keymap.set("n", "<leader>gdh", "<cmd>DiffviewFileHistory<cr>", { desc = "Diff History" })
vim.keymap.set("n", "<leader>gp", "<cmd>DiffviewOpen<cr>", { desc = "Project Diff Current" })

require("gitsigns").setup({
	current_line_blame = true,
})

wk.add({
	{ "<leader>gh", group = "Hunk" },
})
vim.keymap.set("n", "<leader>ghd", "<cmd>Gitsigns preview_hunk<cr>", { desc = "Hunk diff" })
vim.keymap.set("n", "<leader>ghr", "<cmd>Gitsigns reset_hunk<cr>", { desc = "Hunk reset" })

require("octo").setup({})

wk.add({
	{ "<leader>ggp", group = "Github" },
})
vim.keymap.set("n", "<leader>ggp", "<cmd>Octo pr list<cr>", { desc = "Github PRs list" })
vim.keymap.set("n", "<leader>ggp", "<cmd>Octo pr list<cr>", { desc = "Github PRs list" })
vim.keymap.set("n", "<leader>ggr", "<cmd>Octo review<cr>", { desc = "Github PR review" })
