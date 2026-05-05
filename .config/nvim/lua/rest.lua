vim.pack.add({
	{ src = "https://github.com/rest-nvim/rest.nvim" },
})

local function run_rest_if_http()
	local filetype = vim.bo.filetype

	if filetype == "http" then
		vim.cmd("Rest run")
	else
		vim.notify("Not an HTTP file", vim.log.levels.WARN)
	end
end

vim.keymap.set("n", "<Leader>R", run_rest_if_http, {
	noremap = true,
	silent = false,
	desc = "Run REST request if in HTTP file",
})

vim.api.nvim_create_user_command("Http", function()
	local buf = vim.api.nvim_create_buf(true, false)

	local content = {
		"GET http://",
		"Authorization: Token",
	}

	vim.api.nvim_buf_set_lines(buf, 0, -1, false, content)
	vim.api.nvim_command("buffer " .. buf)
	vim.cmd("setfiletype http")
end, {})
