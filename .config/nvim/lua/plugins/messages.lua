vim.pack.add({ { src = "https://github.com/AckslD/messages.nvim" } })

require("messages").setup({
	-- should prepare a new buffer and return the winid
	-- by default opens a floating window
	-- provide a different callback to change this behaviour
	-- @param opts: the return value from float_opts
	-- prepare_buffer = function(opts)
	-- 	print("opts", vim.inspect(opts))
	--
	-- 	local buf = vim.api.nvim_create_buf(false, true)
	-- 	local res = vim.api.nvim_open_win(buf, true, opts)
	-- 	print("res", res)
	-- 	return res
	-- end,
})
