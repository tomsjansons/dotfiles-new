vim.opt.expandtab = true
vim.opt.shiftwidth = 2
vim.opt.tabstop = 2
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.clipboard = "unnamed,unnamedplus"
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.completeopt = "menuone,noinsert,fuzzy"
vim.opt.breakindent = true
vim.opt.breakindentopt = { "shift:2", "sbr" }
vim.opt.showbreak = "⮑"

vim.g.netrw_keepdir = 1
vim.g.netrw_winsize = 30
-- vim.g.netrw_banner = 0
vim.g.netrw_liststyle = 3
vim.g.netrw_localcopydircmd = "cp -r"

local f = io.open(os.getenv("HOME") .. "/.theme-light", "r")
if f ~= nil then
	io.close(f)
	vim.opt.background = "light"
else
	vim.opt.background = "dark"
end

vim.api.nvim_create_autocmd("TextYankPost", {
	callback = function()
		vim.highlight.on_yank()
	end,
})

vim.api.nvim_create_autocmd("FileType", {
	pattern = { "yaml", "yml" },
	callback = function()
		vim.opt_local.expandtab = true
		vim.opt_local.shiftwidth = 4
		vim.opt_local.tabstop = 4
		vim.opt_local.softtabstop = 4
	end,
})
