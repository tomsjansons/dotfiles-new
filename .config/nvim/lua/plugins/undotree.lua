vim.pack.add({ { src = "https://github.com/jiaoshijie/undotree" } })

local tree = require("undotree")
tree.setup({
	keymaps = {
		["<esc>"] = "quit",
	},
})

vim.keymap.set("n", "<leader>u", function()
	tree.toggle()
end, { desc = "Undo tree" })
