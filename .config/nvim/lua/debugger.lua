vim.pack.add({
	{ src = "https://github.com/nvim-neotest/nvim-nio" },
	{ src = "https://github.com/mfussenegger/nvim-dap" },
	{ src = "https://github.com/rcarriga/nvim-dap-ui" },
	{ src = "https://github.com/leoluz/nvim-dap-go" },
})

local dap = require("dap")

require("dapui").setup()

-- configure codelldb adapter
dap.adapters.codelldb = {
	type = "server",
	port = "${port}",
	executable = {
		command = "codelldb",
		args = { "--port", "${port}" },
	},
}

-- setup a debugger config for zig projects
dap.configurations.zig = {
	{
		name = "Launch",
		type = "codelldb",
		request = "launch",
		-- program = "${workspaceFolder}/zig-out/bin/${workspaceFolderBasename}",
		program = "${workspaceFolder}/zig-out/bin/main",
		cwd = "${workspaceFolder}",
		stopOnEntry = false,
		args = {},
	},
}

dap.adapters["go-remote"] = {
	type = "server",
	host = "127.0.0.1",
	port = 38697, -- must match ./dev.sh esg-dlv
}

dap.configurations.go = dap.configurations.go or {}
table.insert(dap.configurations.go, {
	type = "go-remote",
	name = "Launch ESG (via external dlv dap)",
	request = "launch",
	program = "${workspaceFolder}/esg/cmd/be",
	cwd = "${workspaceFolder}",
	args = { "--env", "./.env.local" }, -- ensures backend loads .env.local
	stopOnEntry = false,
	-- Optional: buildFlags = {"-gcflags", "all=-N -l"},
})

vim.keymap.set("n", "<leader>db", function()
	require("dap").toggle_breakpoint()
end, { desc = "DAP Toggle Breakpoint" })

vim.keymap.set("n", "<leader>dr", function()
	require("dap").continue()
end, { desc = "DAP Run" })

vim.keymap.set("n", "<leader>d", "", { desc = "DAP" })

vim.keymap.set("n", "<leader>du", function()
	require("dapui").toggle()
end, { desc = "DAP UI Toggle" })

vim.keymap.set("n", "m", function()
	require("dap").step_over()
end, { desc = "DAP Step Over" })

vim.keymap.set("n", "<S-m>", function()
	require("dap").step_into()
end, { desc = "DAP Step Into" })

vim.keymap.set("n", "<C-m>", function()
	require("dap").step_out()
end, { desc = "DAP Step Out" })

require("dap-go").setup()
