vim.pack.add({
	{ src = "https://github.com/nvim-treesitter/nvim-treesitter", version = "main" },
	{ src = "https://github.com/nvim-treesitter/nvim-treesitter-textobjects", version = "main" },
	{ src = "https://github.com/mawkler/jsx-element.nvim" },
})

local parsers = {
	"lua",
	"markdown",
	"markdown_inline",
	"typescript",
	"tsx",
	"go",
	"rust",
	"zig",
	"yaml",
	"kotlin",
	"swift",
}

require("nvim-treesitter").setup()

local installed = require("nvim-treesitter").get_installed()
local missing = vim.tbl_filter(function(lang)
	return not vim.list_contains(installed, lang)
end, parsers)

if #missing > 0 then
	require("nvim-treesitter").install(missing, { summary = true })
end

require("nvim-treesitter-textobjects").setup({
	select = {
		lookahead = true,
		keymaps = {
			["af"] = "@function.outer",
			["if"] = "@function.inner",
		},
		include_surrounding_whitespace = true,
	},
})

vim.api.nvim_create_autocmd("FileType", {
	pattern = {
 		"lua",
		"markdown",
		"typescript",
		"typescriptreact",
		"javascript",
		"javascriptreact",
		"go",
		"yaml",
		"kotlin",
		"swift",
		"zig",
	},
	callback = function(args)
		local max_filesize = 100 * 1024
		local ok, stats = pcall(vim.uv.fs_stat, vim.api.nvim_buf_get_name(args.buf))
		if ok and stats and stats.size > max_filesize then
			return
		end

		pcall(vim.treesitter.start, args.buf)
	end,
})

require("jsx-element").setup({
	keymaps = {
		enable = true,
		jsx_element = "t",
	},
})
