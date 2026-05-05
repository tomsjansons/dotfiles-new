vim.pack.add({ { src = "https://github.com/abhinandh-s/age.nvim" } })

local public_key = os.getenv("AGE_PUBLIC_KEY")
local private_key = os.getenv("AGE_PRIVATE_KEY")

-- if not public_key or not private_key then
-- 	vim.notify("AGE keys are not set in environment variables!", vim.log.levels.ERROR)
-- 	return
-- end

require("age").setup({
	encrypt_and_del = true, -- will remove the original file after encrypting.
	public_key = public_key,
	private_key = private_key,
})
