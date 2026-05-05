vim.g.mapleader = " "
vim.g.maplocalleader = ","

vim.keymap.set("n", "<c-h>", "<C-w>h")
vim.keymap.set("n", "<c-l>", "<C-w>l")
vim.keymap.set("n", "<c-j>", "<C-w>j")
vim.keymap.set("n", "<c-k>", "<C-w>k")

vim.keymap.set("n", "<leader>tn", "<cmd>tabnew<cr>", { desc = "Tab new" })
vim.keymap.set("n", "<leader>tc", "<cmd>tabclose<cr>", { desc = "Tab close" })
vim.keymap.set("n", "<c-s-t>", "<cmd>tabnew<cr>")
vim.keymap.set("n", "<c-s-h>", "<cmd>tabprevious<cr>")
vim.keymap.set("n", "<c-s-l>", "<cmd>tabnext<cr>")

vim.keymap.set("v", "<", "<gv")
vim.keymap.set("v", ">", ">gv")

vim.keymap.set({ "n", "v" }, "j", "gj")
vim.keymap.set({ "n", "v" }, "k", "gk")

vim.api.nvim_create_user_command("W", "w", {})
vim.api.nvim_create_user_command("Wa", "wa", {})
vim.api.nvim_create_user_command("WA", "wa", {})
vim.api.nvim_create_user_command("Q", "q", {})
vim.api.nvim_create_user_command("Qa", "qa", {})
vim.api.nvim_create_user_command("QA", "qa", {})

function StepBackJumplist(original_buf)
	local jumplist = vim.fn.getjumplist()
	local jumps = jumplist[1]
	local jumpPos = jumplist[2]

	for i = jumpPos, 1, -1 do
		local jump = jumps[i]
		if jump.bufnr ~= original_buf and vim.api.nvim_buf_is_valid(jump.bufnr) then
			vim.api.nvim_win_set_buf(0, jump.bufnr)
			vim.api.nvim_win_set_cursor(0, { jump.lnum, jump.col })
			break
		end
	end
end

vim.keymap.set("n", "<leader>D", function()
	local original_buf = vim.api.nvim_get_current_buf()

	StepBackJumplist(original_buf)

	vim.api.nvim_buf_delete(original_buf, { force = true })
end, { desc = "Delete buffer" })

-- for nimi.completion to do enter for select
_G.cr_action = function()
	if vim.fn.complete_info()["selected"] ~= -1 then
		return "\25"
	end
	return MiniPairs.cr()
end

vim.keymap.set("i", "<CR>", "v:lua.cr_action()", { expr = true })

vim.api.nvim_create_user_command("R", function(args)
	local cz_nvim = os.getenv("HOME") .. "/.local/share/chezmoi/dot_config/nvim"
	local cnf_nvim = os.getenv("HOME") .. "/.config/nvim"
	vim.cmd("!rm -rf " .. cz_nvim)
	vim.cmd("!cp -r " .. cnf_nvim .. " " .. cz_nvim)
	vim.cmd("restart")
end, { desc = "Update cz and restart" })

vim.keymap.set("n", "=", "<cmd>vertical resize +5<cr>") -- make the window biger vertically
vim.keymap.set("n", "-", "<cmd>vertical resize -5<cr>") -- make the window smaller vertically
vim.keymap.set("n", "+", "<cmd>horizontal resize +2<cr>") -- make the window bigger horizontally by pressing shift and =
vim.keymap.set("n", "_", "<cmd>horizontal resize -2<cr>") -- make the window smaller horizontally by pressing shift and -
