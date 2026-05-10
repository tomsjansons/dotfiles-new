vim.pack.add({
	{ src = "https://github.com/pablopunk/pi.nvim" },
	{ src = "https://github.com/carderne/pi-nvim" },
})

require("pi-nvim").setup()

vim.keymap.set("n", "<leader>ap", ":PiSend<CR>", { desc = "Pi Send" })
vim.keymap.set("n", "<leader>af", ":PiSendFile<CR>", { desc = "Pi Send File" })
vim.keymap.set("v", "<leader>as", ":PiSendSelection<CR>", { desc = "Pi Send Selection" })
vim.keymap.set("n", "<leader>ab", ":PiSendBuffer<CR>", { desc = "Pi Send Buffer" })
vim.keymap.set("n", "<leader>ai", ":PiPing<CR>", { desc = "Pi Ping" })

require("pi").setup({
	binary = { "env", "PI_SKIP_VERSION_CHECK=1", "pi" },
	model = "openai-codex/gpt-5.4-mini",
	thinking = "off",
	append_system_prompt = "IMPORTANT: Chat responses are NOT usable and will NOT be seen by the user. You MUST answer by editing files. All output text is lost; only edited code files remain. Do not communicate via chat prose. Every interaction, including answering questions, explaining changes, or presenting examples, must go through code edits in relevant files. Place explanations only as code comments in the appropriate file, before the relevant code/functions/classes/headers. If you need to present code, write it into actual files or edits, not chat-style text. Output no conversational text; make file edits only.",
	skills = false,
	extensions = false,
})

vim.keymap.set("n", "<leader>ao", ":PiAsk<CR>", { desc = "Ask pi" })
vim.keymap.set("v", "<leader>ao", ":PiAskSelection<CR>", { desc = "Ask pi (selection)" })
