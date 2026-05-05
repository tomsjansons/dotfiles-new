vim.pack.add({ { src = "https://github.com/Saghen/blink.cmp" } })

function Build_blink(params)
	vim.notify("Building blink", vim.log.levels.INFO)
	local obj = vim.system({ "cargo", "build", "--release" }, { cwd = params.path }):wait()
	if obj.code == 0 then
		vim.notify("Building blink done", vim.log.levels.INFO)
	else
		vim.notify("Building blink failed", vim.log.levels.ERROR)
	end
end

vim.api.nvim_create_autocmd("PackChanged", {
	pattern = "*",
	callback = function(ev)
		vim.notify(ev.data.spec.name .. " has been updated.")
		if ev.data.spec.name == "blink.cmp" then
			Build_blink({ path = ev.data.path })
		end
	end,
})

require("blink.cmp").setup({
	sources = {
		default = {
			"lsp",
			"codecompanion",
			"buffer",
			"path",
		},
		per_filetype = {
			sql = { "dadbod" },
		},
		providers = {
			dadbod = { module = "vim_dadbod_completion.blink" },
			codecompanion = {
				name = "CodeCompanion",
				module = "codecompanion.providers.completion.blink",
				enabled = true,
				score_offset = 10,
				async = true,
			},
		},
	},
	keymap = {
		preset = "default",
		["<Tab>"] = { "select_and_accept", "fallback" },
		["<CR>"] = { "fallback" },
	},
	signature = {
		enabled = true,
	},
	appearance = {
		nerd_font_variant = "mono",
	},
	completion = {
		accept = {
			auto_brackets = {
				enabled = false,
			},
		},
		documentation = {
			auto_show = true,
		},
	},
	fuzzy = { implementation = "prefer_rust_with_warning" },
})
