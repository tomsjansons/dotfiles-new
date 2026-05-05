vim.pack.add({
	{ src = "https://github.com/nvim-telescope/telescope.nvim" },
	{ src = "https://github.com/nvim-telescope/telescope-file-browser.nvim" },
	{ src = "https://github.com/nvim-telescope/telescope-ui-select.nvim" },
})

vim.keymap.set("n", "<space>E", function()
	require("telescope").extensions.file_browser.file_browser()
end, { desc = "File explorer" })
vim.keymap.set("n", "<space>e", ":Telescope file_browser path=%:p:h select_buffer=true<CR>", { desc = "File explorer" })

local function delete_selected_buffer(prompt_bufnr)
	local actions = require("telescope.actions")
	local action_state = require("telescope.actions.state")

	local selection = action_state.get_selected_entry()

	if selection then
		local bufnr = selection.bufnr
		if bufnr then
			actions.close(prompt_bufnr)
			StepBackJumplist(bufnr)
			vim.api.nvim_buf_delete(bufnr, { force = true })
			require("telescope.builtin").buffers()
		end
	end
end

require("telescope").setup({
	defaults = {
		mappings = {
			i = {
				["<C-d>"] = delete_selected_buffer,
			},
			n = {
				["<C-d>"] = delete_selected_buffer,
			},
		},
	},
	extensions = {
		file_browser = {
			hidden = { file_browser = true, folder_browser = true },
			respect_gitignore = false,
		},
	},
})
require("telescope").load_extension("file_browser")
require("telescope").load_extension("ui-select")

vim.keymap.set("n", "<leader>b", function()
	require("telescope.builtin").buffers({ sort_lastused = true, ignore_current_buffer = true })
end, { desc = "Find Buffers" })

vim.keymap.set("n", "<leader>f", function()
	local is_git_repo = vim.fn.system("git rev-parse --is-inside-work-tree"):match("true")

	if is_git_repo then
		require("telescope.builtin").git_files()
	else
		require("telescope.builtin").find_files()
	end
end, { desc = "Find Files Git" })

vim.keymap.set("n", "<leader>F", function()
	require("telescope.builtin").find_files()
end, { desc = "Find Files All" })

-- vim.keymap.del("n", "gri")
-- vim.keymap.del("n", "gra")
-- vim.keymap.del("n", "grn")
-- vim.keymap.del("n", "grr")
-- vim.keymap.del("n", "grt")

-- vim.keymap.set("n", "gri", function()
-- 	require("telescope.builtin").lsp_implementations()
-- end, { desc = "LSP Implementation" })
--
-- vim.keymap.set("n", "grn", function()
-- 	require("telescope.builtin").lsp_references()
-- end, { desc = "LSP References" })
--
-- vim.keymap.set("n", "grr", function()
-- 	require("telescope.builtin").lsp_references()
-- end, { desc = "LSP References" })
--
-- vim.keymap.set("n", "grt", function()
-- 	require("telescope.builtin").lsp_type_definitions()
-- end, { desc = "LSP Type Def" })
--
vim.keymap.set("n", "gO", function()
	require("telescope.builtin").lsp_document_symbols()
end, { desc = "LSP Doc Symbols" })

vim.keymap.set("n", "gd", function()
	require("telescope.builtin").lsp_definitions()
end, { desc = "LSP Definition" })

vim.keymap.set("n", "<leader>cD", function()
	require("telescope.builtin").diagnostics()
end, { desc = "Diagnostic" })

vim.keymap.set("n", "<leader>sg", function()
	require("telescope.builtin").live_grep()
end, { desc = "Grep" })

vim.keymap.set("n", "<leader>sR", function()
	require("telescope.builtin").resume()
end, { desc = "Resume" })
