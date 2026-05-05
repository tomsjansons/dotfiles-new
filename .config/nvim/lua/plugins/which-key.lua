vim.pack.add({ { src = "https://github.com/folke/which-key.nvim" } })

vim.keymap.set("n", "<leader>?", function()
	require("which-key").show({ global = false })
end, { desc = "Whichkey" })

local wk = require("which-key")
wk.add({ { "<leader>c", group = "Code" } })
