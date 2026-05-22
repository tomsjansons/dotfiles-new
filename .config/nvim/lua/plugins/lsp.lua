vim.pack.add({
	{ src = "https://github.com/neovim/nvim-lspconfig" },
	{ src = "https://github.com/mason-org/mason.nvim" },
	{ src = "https://github.com/mason-org/mason-lspconfig.nvim" },
	{ src = "https://github.com/WhoIsSethDaniel/mason-tool-installer.nvim" },
	{ src = "https://github.com/nvimdev/lspsaga.nvim" },
})

require("mason").setup()
-- Do not call mason-lspconfig.setup() on startup: it refreshes the
-- Mason registry. LSP servers are enabled explicitly below.
require("mason-tool-installer").setup({
  -- Avoid Mason registry/tool checks on every new Neovim session.
  -- Run :MasonToolsUpdate when you want to install/update tools.
  run_on_start = false,
	integrations = {
		["mason-lspconfig"] = true,
		["mason-null-ls"] = false,
		["mason-nvim-dap"] = false,
	},
	ensure_installed = {
		"lua_ls",
		"stylua",
		"eslint_d",
		"prettierd",
		"tsgo",
		"gopls",
		"gofumpt",
		"rust_analyzer",
		"kotlin_lsp",
		"ktlint",
	},
})

local nvim_lsp = require("lspconfig")

vim.lsp.config("denols", {
	filetypes = { "typescript", "typescriptreact" },
	root_dir = function(...)
		return nvim_lsp.util.root_pattern("deno.jsonc", "deno.json")(...)
	end,
})

vim.lsp.config("lua_ls", {
	settings = {
		Lua = {
			runtime = {
				version = "LuaJIT",
			},
			diagnostics = {
				globals = {
					"vim",
					"require",
				},
			},
			workspace = {
				library = vim.api.nvim_get_runtime_file("", true),
			},
			telemetry = {
				enable = false,
			},
		},
	},
})

vim.lsp.config("zls", {
	settings = {
		zls = {
			enable_build_on_save = true,
			semantic_tokens = "partial",
		},
	},
})

vim.defer_fn(function()
  vim.lsp.enable({
    "lua_ls",
    "denols",
    "tsgo",
    "gopls",
    "rust_analyzer",
    "kotlin_lsp",
    "zls",
  })
end, 500)

require("lspsaga").setup({
	code_action = {
		extend_gitsigns = true,
	},
	lightbulb = {
		enable = true,
		sign = false,
		virtual_text = true,
		debounde = 0,
	},
})

local wk = require("which-key")
wk.add({
	{ "<leader>c", group = "Code" },
	{ "<leader>cc", group = "Calls" },
})

vim.keymap.del("n", "gri")
vim.keymap.del("n", "gra")
vim.keymap.del("n", "grn")
vim.keymap.del("n", "grr")
vim.keymap.del("n", "grt")

vim.keymap.set("n", "<leader>ca", "<cmd>Lspsaga code_action<cr>", { desc = "Code Action" })
vim.keymap.set("n", "<leader>cci", "<cmd>Lspsaga incoming_calls<cr>", { desc = "Calls Incoming" })
vim.keymap.set("n", "<leader>cco", "<cmd>Lspsaga outgoing_calls<cr>", { desc = "Calls Outgoing" })
vim.keymap.set("n", "<leader>cd", vim.diagnostic.open_float, { desc = "Show Diagnostic" })
vim.keymap.set("n", "gr", "<cmd>Lspsaga finder<cr>", { desc = "References Finder" })
vim.keymap.set("n", "K", "<cmd>Lspsaga hover_doc<cr>")
vim.keymap.set("n", "<leader>cr", "<cmd>Lspsaga rename<cr>", { desc = "Rename" })
vim.keymap.set("n", "<leader>co", "<cmd>Lspsaga outline<cr>", { desc = "Outline" })
