vim.pack.add({ { src = "https://github.com/MagicDuck/grug-far.nvim" } })

local grug = require("grug-far")
grug.setup({})

vim.api.nvim_create_autocmd("FileType", {
	group = vim.api.nvim_create_augroup("grug-far-keymap", { clear = true }),
	pattern = { "grug-far" },
	callback = function()
		vim.keymap.set("n", "q", function()
			grug.get_instance(0):close()
		end, { buffer = true })
		vim.keymap.set("n", "<esc>", function()
			grug.get_instance(0):close()
		end, { buffer = true })
	end,
})

vim.keymap.set({ "n" }, "<leader>sr", "<cmd>GrugFar<cr>", { desc = "Search and replace" })
vim.keymap.set({ "n" }, "<leader>sw", function()
	grug.open({ prefills = { search = vim.fn.expand("<cword>") } })
end, { desc = "Search and replace word" })
