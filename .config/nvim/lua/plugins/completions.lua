local blink_group = vim.api.nvim_create_augroup("blink_pack_hooks", { clear = true })

local function build_blink()
	vim.notify("Building blink", vim.log.levels.INFO)
	pcall(vim.cmd.packadd, "blink.lib")
	pcall(vim.cmd.packadd, "blink.cmp")

	local ok, cmp = pcall(require, "blink.cmp")
	if not ok then
		vim.notify("Building blink failed: could not load blink.cmp", vim.log.levels.ERROR)
		return
	end

	local ok_build, err = pcall(function()
		cmp.build({ force = true }):wait(60000)
	end)
	if ok_build then
		vim.notify("Building blink done", vim.log.levels.INFO)
	else
		vim.notify("Building blink failed: " .. tostring(err), vim.log.levels.ERROR)
	end
end

vim.api.nvim_create_autocmd("PackChanged", {
	group = blink_group,
	callback = function(ev)
		local name, kind = ev.data.spec.name, ev.data.kind
		if name ~= "blink.cmp" or (kind ~= "install" and kind ~= "update") then
			return
		end

		build_blink()
	end,
})

vim.pack.add({
	{ src = "https://github.com/Saghen/blink.lib" },
	{ src = "https://github.com/Saghen/blink.cmp" },
})

require("blink.cmp").setup({
	sources = {
		default = {
			"lsp",
			"buffer",
			"path",
		},
		per_filetype = {
			sql = { "dadbod" },
		},
		providers = {
			dadbod = { module = "vim_dadbod_completion.blink" },
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
