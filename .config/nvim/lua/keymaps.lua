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

local ignored_buffer_extensions = {
   bmp = true,
   gif = true,
   jpeg = true,
   jpg = true,
   pdf = true,
   png = true,
   svg = true,
   webp = true,
}

local function buffer_fallback_root(bufnr)
   local name = vim.api.nvim_buf_get_name(bufnr)
   if name == "" then
      return vim.fs.normalize(vim.uv.cwd())
   end

   return vim.fs.normalize(vim.fs.root(name, { ".git" }) or vim.fs.dirname(name) or vim.uv.cwd())
end

local function is_buf_in_root(bufnr, root)
   if not vim.api.nvim_buf_is_valid(bufnr) or not vim.bo[bufnr].buflisted or vim.bo[bufnr].buftype ~= "" then
      return false
   end

   local name = vim.api.nvim_buf_get_name(bufnr)
   if name == "" then
      return false
   end

   local extension = vim.fn.fnamemodify(name, ":e"):lower()
   if ignored_buffer_extensions[extension] then
      return false
   end

   local path = vim.fs.normalize(vim.uv.fs_realpath(name) or name)
   root = vim.fs.normalize(root)

   if path == root then
      return true
   end

   local prefix = root:sub(-1) == "/" and root or (root .. "/")
   return vim.startswith(path, prefix)
end

function StepBackJumplist(original_buf)
	if vim.api.nvim_get_current_buf() ~= original_buf then
		return
	end

	local jumplist = vim.fn.getjumplist()
	local jumps = jumplist[1]
	local jumpPos = jumplist[2]
	local root = buffer_fallback_root(original_buf)

	for i = jumpPos, 1, -1 do
		local jump = jumps[i]
		if jump.bufnr ~= original_buf and is_buf_in_root(jump.bufnr, root) then
			vim.api.nvim_win_set_buf(0, jump.bufnr)
			local line_count = vim.api.nvim_buf_line_count(jump.bufnr)
			vim.api.nvim_win_set_cursor(0, { math.min(jump.lnum, line_count), jump.col })
			return
		end
	end

	local empty_buf = vim.api.nvim_create_buf(true, false)
	vim.api.nvim_win_set_buf(0, empty_buf)
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
